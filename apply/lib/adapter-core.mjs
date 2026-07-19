// Shared skeleton for the per-ATS auto-fill adapters (Greenhouse, Ashby, Lever).
// Deterministic Playwright filling — no LLM in the per-field loop. Adapters stay thin;
// the CLI parsing, profile/answers loading, summary reporting, required-field detector,
// reconciliation pass, and browser hold-open all live here.

import { parseArgs } from 'util';
import { readFile } from 'fs/promises';
import { resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_POLICY_PATH, loadPolicy, submissionGate } from '../application-policy.mjs';
import { DEFAULT_LEDGER_PATH, answerTable, loadLedger, recordQuestion } from '../question-ledger.mjs';
import { projectAccomplishmentAnswerTable } from '../../project-accomplishment-ledger.mjs';

const DEFAULT_PROFILE = fileURLToPath(
  new URL('../../config/application-profile.json', import.meta.url),
);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCliArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      resume: { type: 'string' },
      cover: { type: 'string' },
      'cover-text': { type: 'string' },
      answers: { type: 'string' },
      profile: { type: 'string' },
      ledger: { type: 'string' },
      policy: { type: 'string' },
      submit: { type: 'boolean', default: false },
      'application-key': { type: 'string' },
      company: { type: 'string' },
      title: { type: 'string' },
      lane: { type: 'string' },
      'job-description': { type: 'string' },
      'fit-score': { type: 'string' },
      liveness: { type: 'string' },
      browser: { type: 'string' },
      headless: { type: 'boolean', default: false },
    },
  });

  const url = positionals[0];
  if (!url) {
    console.error('Usage: node <adapter>.mjs <application-url> [--resume path] [--cover path | --cover-text "..."] [--answers file.json] [--profile path] [--headless]');
    process.exit(1);
  }

  return {
    url,
    resume: values.resume ? absPath(values.resume) : '',
    cover: values.cover ? absPath(values.cover) : '',
    coverText: values['cover-text'] || '',
    answersPath: values.answers ? absPath(values.answers) : '',
    profilePath: values.profile ? absPath(values.profile) : DEFAULT_PROFILE,
    ledgerPath: values.ledger ? absPath(values.ledger) : DEFAULT_LEDGER_PATH,
    policyPath: values.policy ? absPath(values.policy) : DEFAULT_POLICY_PATH,
    submit: !!values.submit,
    applicationKey: values['application-key'] || '',
    company: values.company || '',
    title: values.title || '',
    lane: values.lane || '',
    jobDescription: values['job-description'] || '',
    fitScore: values['fit-score'] === undefined ? null : Number(values['fit-score']),
    liveness: values.liveness || '',
    browser: values.browser || process.env.CAREER_OPS_BROWSER_CHANNEL || 'chrome-beta',
    headless: !!values.headless,
  };
}

function absPath(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export async function loadProfile(path) {
  const raw = await readFile(path, 'utf8');
  const profile = JSON.parse(raw);
  // Fall back to profile defaults for resume/cover when the flag is omitted.
  return profile;
}

// Answers file: { "regex or exact question text": "value" }. Merged OVER commonQuestions
// so per-posting custom answers win without touching the profile.
export async function loadAnswers(path) {
  if (!path) return [];
  const raw = await readFile(path, 'utf8');
  const obj = JSON.parse(raw);
  return Object.entries(obj).map(([pattern, value]) => ({
    re: toRegex(pattern),
    value: String(value),
    source: 'answers',
  }));
}

/** @param {string} path @param {{ company?: string, role?: string, url?: string, description?: string, lane?: string }} [context] */
export async function loadLedgerAnswers(path, context = {}) {
  return [
    ...answerTable(loadLedger(path), context),
    ...projectAccomplishmentAnswerTable(context),
  ];
}

/** @param {import('playwright').ChromiumType} chromium @param {{ headless: boolean, channel?: string }} options */
export async function launchBrowser(chromium, options) {
  const requested = options.channel || 'chrome-beta';
  const channels = [requested, requested === 'chrome-beta' ? 'chrome' : null, null].filter((value, index, all) => value !== null ? all.indexOf(value) === index : all.indexOf(value) === index);
  let lastError = null;
  for (const channel of channels) {
    try {
      return await chromium.launch(channel ? { headless: options.headless, channel } : { headless: options.headless });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('unable to launch a browser');
}

function toRegex(pattern) {
  // Treat the key as a case-insensitive substring/regex. Escape only if it is not
  // already a valid regex-looking string is overkill — build a loose matcher.
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

// Recurring custom questions every ATS tends to ask. Values come ONLY from the profile.
export function commonQuestions(profile) {
  const wa = profile.work_authorization || {};
  const authorized = wa.authorized_us ? 'Yes' : 'No';
  const needsSponsorship = wa.requires_sponsorship ? 'Yes' : 'No';
  return [
    // Authorization is checked BEFORE sponsorship so "authorized to work ... without
    // sponsorship?" resolves to the authorization answer, not the sponsorship one.
    { re: /legally authorized|authorized to work|eligible to work|work authorization|right to work/i, value: authorized },
    { re: /sponsor|require .*(petition|immigration)|file a petition|immigration status|nonimmigrant|visa status/i, value: needsSponsorship },
    { re: /(previously|ever).*(employed|worked).*(here|for (us|this)|at (this )?compan)|former employee|prior employment/i, value: 'No' },
    { re: /at least 18|18 years of age|are you 18/i, value: 'Yes' },
    { re: /currently.*(employed|work).*(here|for (us|this compan))/i, value: 'No' },
  ];
}

// Resolve a question's answer from answers file (highest priority) then commonQuestions.
export function answerFor(questionText, tables) {
  for (const table of tables) {
    for (const entry of table) {
      if (entry.re.test(questionText)) return entry.value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summary + reporting
// ---------------------------------------------------------------------------

export function createSummary() {
  const summary = { filled: [], skipped: [], needsReview: [] };
  return {
    summary,
    // key = an id/name string used by the reconciliation pass to detect silent resets.
    ok: (label, key = '') => summary.filled.push({ label, key }),
    skip: (label, reason = '') => summary.skipped.push({ label, reason }),
    review: (label, reason = '') => summary.needsReview.push({ label, reason }),
  };
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

export async function fillBySelector(page, selector, value, label, tools) {
  if (value === undefined || value === null || value === '') {
    tools.review(label, 'no value in profile');
    return false;
  }
  const loc = page.locator(selector).first();
  if (!(await loc.count())) {
    tools.skip(label, `not present (${selector})`);
    return false;
  }
  const want = String(value);
  try {
    await loc.fill(want);
    // A controlled React input can be reset by a late hydration re-render. Verify the
    // value took and refill once if it didn't.
    if ((await loc.inputValue().catch(() => want)) !== want) {
      await page.waitForTimeout(400);
      await loc.fill(want);
    }
    tools.ok(label, selector);
    return true;
  } catch (err) {
    tools.review(label, `fill failed: ${err.message}`);
    return false;
  }
}

// Hidden file inputs: setInputFiles directly. NEVER click an "Attach" button (filechooser
// race) and NEVER use index-based .nth() (breaks on re-render after the first upload).
export async function attachFile(page, selector, filePath, label, tools) {
  if (!filePath) {
    tools.skip(label, 'no file provided');
    return false;
  }
  const loc = page.locator(selector).first();
  if (!(await loc.count())) {
    tools.skip(label, `no file input (${selector})`);
    return false;
  }
  try {
    await loc.setInputFiles(filePath);
    tools.ok(label, selector);
    return true;
  } catch (err) {
    tools.review(label, `attach failed: ${err.message}`);
    return false;
  }
}

// Native <select> only. React-select comboboxes are handled per-adapter (Greenhouse).
export async function selectNative(page, selector, value, label, tools) {
  if (!value) {
    tools.review(label, 'no value in profile');
    return false;
  }
  const loc = page.locator(selector).first();
  if (!(await loc.count())) {
    tools.skip(label, `not present (${selector})`);
    return false;
  }
  try {
    // Try by visible label (human-readable answers like "Yes"/"No"), then by value.
    try {
      await loc.selectOption({ label: value });
    } catch {
      await loc.selectOption({ value });
    }
    tools.ok(label, selector);
    return true;
  } catch (err) {
    tools.review(label, `select failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// EEO / marketing-consent policy (hard rules 2 & 3)
// ---------------------------------------------------------------------------

export const EEO_LABEL_RE = /gender|race|ethnic|hispanic|latino|veteran|disabilit|self[-\s]?identif|voluntary self/i;
export const MARKETING_RE = /marketing|newsletter|updates|promotional|subscribe|keep me (posted|informed)|receive (emails|communications)/i;
export const LEGAL_LABEL_RE = /attest|certif|background|criminal|conviction|terms (?:and|of)|agree.*(?:accurate|truth|conditions|terms)/i;

// ---------------------------------------------------------------------------
// Required-field detection (page.evaluate). Group-aware; skips reCAPTCHA.
// Returns [{ tag, type, name, id, label }] for every required-but-empty control.
// ---------------------------------------------------------------------------

// Let a progressively-hydrating React form finish mounting before we fill, so controlled
// inputs don't get reset by a late re-render.
export async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
}

export async function detectRequired(page) {
  return page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && l.textContent.trim()) return l.textContent.trim();
      }
      const wrap = el.closest('label');
      if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
      const albl = el.getAttribute('aria-label');
      if (albl) return albl.trim();
      const alblBy = el.getAttribute('aria-labelledby');
      if (alblBy) {
        const parts = alblBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
        const t = parts.map((p) => p.textContent.trim()).join(' ').trim();
        if (t) return t;
      }
      // Fall back to the nearest field-group heading/legend.
      const grp = el.closest('[class*="field"], [class*="question"], fieldset');
      if (grp) {
        const lg = grp.querySelector('legend, label, .label, [class*="label"]');
        if (lg && lg.textContent.trim()) return lg.textContent.trim().slice(0, 120);
      }
      return el.name || el.id || '(unlabeled)';
    };

    const isRequired = (el) =>
      el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';

    const inRecaptcha = (el) =>
      el.name === 'g-recaptcha-response' ||
      !!el.closest('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], [class*="recaptcha" i]');

    const els = Array.from(document.querySelectorAll('input, select, textarea'));
    const out = [];
    const seenGroups = new Set();

    for (const el of els) {
      const type = (el.type || el.tagName).toLowerCase();
      if (type === 'hidden') continue;
      if (inRecaptcha(el)) continue;

      if (type === 'radio' || type === 'checkbox') {
        const name = el.name;
        if (!name) {
          if (isRequired(el) && !el.checked) {
            out.push({ tag: el.tagName.toLowerCase(), type, name: '', id: el.id, label: labelFor(el), group: false });
          }
          continue;
        }
        if (seenGroups.has(name)) continue;
        seenGroups.add(name);
        const group = els.filter((x) => x.name === name && (x.type || '').toLowerCase() === type);
        const groupRequired = group.some(isRequired);
        const anyChecked = group.some((x) => x.checked);
        if (groupRequired && !anyChecked) {
          out.push({ tag: 'input', type, name, id: el.id, label: labelFor(el), group: true });
        }
        continue;
      }

      // File inputs: "filled" = a file is attached (value is a fakepath string).
      if (type === 'file') {
        if (isRequired(el) && !(el.files && el.files.length)) {
          out.push({ tag: 'input', type, name: el.name, id: el.id, label: labelFor(el), group: false });
        }
        continue;
      }

      // text / email / tel / select / textarea / combobox inputs
      if (!isRequired(el)) continue;
      const val = (el.value || '').trim();
      if (val === '') {
        out.push({ tag: el.tagName.toLowerCase(), type, name: el.name, id: el.id, label: labelFor(el), group: false });
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Reconciliation: drop optimistic "filled" claims the detector still reports empty
// (react-select values can silently reset on a later re-render).
// ---------------------------------------------------------------------------

export function reconcile(tools, stillEmpty) {
  const emptyKeys = new Set();
  for (const e of stillEmpty) {
    if (e.id) emptyKeys.add(`#${e.id}`);
    if (e.id) emptyKeys.add(e.id);
    if (e.name) emptyKeys.add(e.name);
    if (e.name) emptyKeys.add(`[name="${e.name}"]`);
  }
  const kept = [];
  for (const item of tools.summary.filled) {
    const key = item.key || '';
    const bare = key.replace(/^#/, '').replace(/^\[name="(.*)"\]$/, '$1');
    if (key && (emptyKeys.has(key) || emptyKeys.has(bare) || emptyKeys.has(`#${bare}`) || emptyKeys.has(`[name="${bare}"]`))) {
      tools.summary.needsReview.push({
        label: item.label,
        reason: 'value did not persist (re-render reset) — set it manually',
      });
    } else {
      kept.push(item);
    }
  }
  tools.summary.filled = kept;
}

// ---------------------------------------------------------------------------
// Final report + browser hold-open
// ---------------------------------------------------------------------------

export async function finish(page, browser, tools, {
  headless,
  url,
  submit = false,
  policy = loadPolicy(),
  ledgerPath = DEFAULT_LEDGER_PATH,
  adapter = 'unknown',
  applicationKey = '',
  company = '',
  title = '',
  fitScore = null,
  liveness = '',
}) {
  const { filled, skipped, needsReview } = tools.summary;
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  Application: ${url}`);
  console.log(line);

  console.log(`\n✅ Filled (${filled.length})`);
  for (const f of filled) console.log(`   • ${f.label}`);

  console.log(`\n⏭  Skipped (${skipped.length})`);
  for (const s of skipped) console.log(`   • ${s.label}${s.reason ? ` — ${s.reason}` : ''}`);

  console.log(`\n⚠  Needs review (${needsReview.length})`);
  for (const r of needsReview) console.log(`   • ${r.label}${r.reason ? ` — ${r.reason}` : ''}`);

  console.log(`\n${line}`);
  if (!submit) console.log('  Fill-only mode: the adapter will not click Submit.');
  console.log(line + '\n');

  for (const review of needsReview) {
    const label = String(review.label || '').replace(/^EEO:\s*/i, '').trim();
    if (!label || /^EEO:/i.test(String(review.label || '')) || /captcha|recaptcha|hcaptcha|multi-factor|verification code/i.test(label)) continue;
    recordQuestion(ledgerPath, label, { company, role: title, source: `adapter:${adapter}` });
  }

  let submission = { state: submit ? 'blocked' : 'not_requested', reason: submit ? 'submission was not attempted' : 'fill-only mode' };
  if (submit) {
    const effectiveLiveness = liveness === 'active' || liveness === 'expired'
      ? liveness
      : await hasActiveFormEvidence(page) ? 'active' : liveness;
    const gate = submissionGate(policy, adapter, { fitScore, liveness: effectiveLiveness, needsReview: needsReview.length });
    if (!gate.ok) {
      submission = { state: 'blocked', reason: gate.reason };
      console.log(`\n⚠️  Submission blocked: ${gate.reason}`);
    } else {
      submission = await submitApplication(page, policy, { adapter, url });
      console.log(`\n${submission.state === 'submitted' ? '✅' : '⚠️'} Submission ${submission.state}: ${submission.reason}`);
    }
  }

  const result = {
    state: submission.state,
    reason: submission.reason,
    url,
    adapter,
    applicationKey,
    company,
    title,
    fitScore,
    filled,
    skipped,
    needsReview,
  };
  if (submit || headless) console.log(`CAREER_OPS_APPLICATION_RESULT ${JSON.stringify(result)}`);

  if (headless || submission.state === 'submitted') {
    await browser.close();
    return result;
  }
  console.log('Browser left open for review. Press Ctrl+C when done.\n');
  await new Promise(() => {});
}

/** @param {import('playwright').Page} page @param {Record<string, unknown>} policy @param {{ adapter: string, url: string }} context */
async function submitApplication(page, policy, context) {
  const visibleText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const captchaVisible = await page.locator('iframe[src*="captcha" i]:visible, [class*="captcha" i]:visible, [id*="captcha" i]:visible').count().catch(() => 0);
  if (policy.stopOnCaptcha && (captchaVisible > 0 || /\bcaptcha\b|recaptcha|hcaptcha/i.test(visibleText))) {
    return { state: 'blocked', reason: 'captcha or anti-bot challenge is present; human action is required' };
  }
  if (policy.stopOnMfa && /multi[- ]factor|one[- ]time password|verification code|sign in to continue/i.test(visibleText)) {
    return { state: 'blocked', reason: 'sign-in, MFA, or verification step is present; human action is required' };
  }

  const controls = page.locator('button, input[type="submit"]');
  const candidates = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false)) || !(await control.isEnabled().catch(() => false))) continue;
    const label = `${await control.innerText().catch(() => '')} ${await control.getAttribute('value').catch(() => '')}`.replace(/\s+/g, ' ').trim();
    if (/submit(?: application)?|apply(?: now)?|send application/i.test(label) && !/save|next|continue|preview/i.test(label)) candidates.push(control);
  }
  if (candidates.length !== 1) return { state: 'blocked', reason: candidates.length ? `found ${candidates.length} possible submit controls; refusing to guess` : 'no unambiguous submit control found' };

  try {
    await candidates[0].click({ timeout: 5000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } catch (error) {
    return { state: 'failed', reason: `submit control could not be clicked: ${error instanceof Error ? error.message : String(error)}` };
  }

  const afterUrl = page.url();
  const afterText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const confirmed = /thank you|application (?:was )?submitted|application received|successfully applied|we['’]?ve received|thanks for applying/i.test(afterText)
    || /thank[-_ ]?you|success|confirmation|submitted/i.test(afterUrl);
  if (confirmed) return { state: 'submitted', reason: `success confirmation detected for ${context.adapter}` };
  return { state: 'submission_unknown', reason: 'submit was clicked but no success confirmation was detected; automatic retry is disabled' };
}

/** @param {import('playwright').Page} page */
async function hasActiveFormEvidence(page) {
  const forms = await page.locator('form').count().catch(() => 0);
  const controls = await page.locator('button, input[type="submit"]').count().catch(() => 0);
  return forms > 0 && controls > 0;
}
