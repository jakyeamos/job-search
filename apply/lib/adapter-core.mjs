// Shared skeleton for the per-ATS auto-fill adapters (Greenhouse, Ashby, Lever).
// Deterministic Playwright filling — no LLM in the per-field loop. Adapters stay thin;
// the CLI parsing, profile/answers loading, summary reporting, required-field detector,
// reconciliation pass, and browser hold-open all live here.

import { parseArgs } from 'util';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_POLICY_PATH, loadPolicy, submissionGate } from '../application-policy.mjs';
import { DEFAULT_LEDGER_PATH, answerTable, loadLedger, recordQuestion } from '../question-ledger.mjs';
import { projectAccomplishmentAnswerTable } from '../../project-accomplishment-ledger.mjs';

const DEFAULT_PROFILE = fileURLToPath(
  new URL('../../config/application-profile.json', import.meta.url),
);

const CONFIRMATION_PATTERNS = [
  ['thank-you', /\b(?:thank you|thanks for applying)(?: for your application)?\b/i],
  ['application-submitted', /\bapplication (?:was )?submitted\b/i],
  ['application-received', /\bapplication received\b/i],
  ['successfully-applied', /\bsuccessfully applied\b/i],
  ['received-your-application', /\bwe['’]?ve received (?:your )?application\b/i],
  ['application-complete', /\bapplication (?:is )?complete\b/i],
  ['submitted-successfully', /\bsubmitted successfully\b/i],
  ['we-will-be-in-touch', /\bwe(?:['’]ll| will) be in touch\b/i],
];

const CONFIRMATION_URL_RE = /thank[-_ ]?you|success|confirmation|submitted|application[-_ ]?received/i;
const SUBMISSION_BLOCK_PATTERNS = [
  ['possible-spam', /flagged as possible spam|possible spam/i],
  ['suspicious-activity', /suspicious (?:activity|submission)|automated (?:submission|activity)|bot detection/i],
  ['rate-limited', /too many (?:requests|attempts)|rate limit/i],
];
const EVIDENCE_TEXT_LIMIT = 1200;
const EVIDENCE_SIGNAL_LIMIT = 12;
const EVIDENCE_RESPONSE_LIMIT = 40;
const HUMAN_HANDOFF_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeEvidenceText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function redactEvidenceText(value, sensitiveTokens = []) {
  let text = normalizeEvidenceText(value);
  const tokens = [...new Set(sensitiveTokens.map((token) => normalizeEvidenceText(token)))]
    .filter((token) => token.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const token of tokens) {
    text = text.replace(new RegExp(escapeRegExp(token), 'gi'), '[redacted-field]');
  }
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/(?:\+?\d[\d .()\-]{7,}\d)/g, '[redacted-phone]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]');
}

function evidenceUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesFor(patterns, value) {
  const text = String(value || '');
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/**
 * Classify sanitized-independent post-submit observations without a browser.
 * Signal text is preferred to the whole body so a job description or footer
 * cannot confirm a submission while the original form is still present.
 *
 * @param {{ url?: string, title?: string, bodyText?: string, signalTexts?: string[], formCount?: number, submitControlCount?: number, frames?: Array<Record<string, unknown>> }} observation
 * @returns {{ confirmed: boolean, markers: string[] }}
 */
export function detectConfirmation(observation = {}) {
  const frames = Array.isArray(observation.frames) && observation.frames.length
    ? observation.frames
    : [observation];
  const markers = new Set();
  for (const [index, frame] of frames.entries()) {
    const signalText = Array.isArray(frame.signalTexts) ? frame.signalTexts.join('\n') : '';
    const bodyText = String(frame.bodyText || '');
    const title = String(frame.title || '');
    const url = String(frame.url || '');
    for (const marker of matchesFor(CONFIRMATION_PATTERNS, signalText)) markers.add(`frame-${index}:signal:${marker}`);
    for (const marker of matchesFor(CONFIRMATION_PATTERNS, title)) markers.add(`frame-${index}:title:${marker}`);
    if (CONFIRMATION_URL_RE.test(url)) markers.add(`frame-${index}:url`);
    const formCount = Number(frame.formCount ?? observation.formCount ?? 0);
    const submitControlCount = Number(frame.submitControlCount ?? observation.submitControlCount ?? 0);
    if (formCount === 0 && submitControlCount === 0) {
      for (const marker of matchesFor(CONFIRMATION_PATTERNS, bodyText)) markers.add(`frame-${index}:body:${marker}`);
    }
  }
  return { confirmed: markers.size > 0, markers: [...markers] };
}

/**
 * Classify explicit post-submit anti-abuse messages. Do not inspect arbitrary
 * body text here: ATS footers often mention reCAPTCHA even on a normal form.
 * @param {{ title?: string, signalTexts?: string[], frames?: Array<Record<string, unknown>> }} observation
 * @returns {{ blocked: boolean, state: string|null, markers: string[] }}
 */
export function detectSubmissionBlock(observation = {}) {
  const frames = Array.isArray(observation.frames) && observation.frames.length
    ? observation.frames
    : [observation];
  const markers = new Set();
  for (const [index, frame] of frames.entries()) {
    const source = [
      String(frame.title || ''),
      ...(Array.isArray(frame.signalTexts) ? frame.signalTexts : []),
    ].join('\n');
    for (const marker of matchesFor(SUBMISSION_BLOCK_PATTERNS, source)) {
      markers.add(`frame-${index}:${marker}`);
    }
  }
  return {
    blocked: markers.size > 0,
    state: markers.size > 0 ? 'blocked_by_antispam' : null,
    markers: [...markers],
  };
}

async function collectSensitiveFieldValues(page) {
  return page.locator('input:not([type="file"]), textarea, select').evaluateAll((elements) => elements
    .map((element) => element.value || element.textContent || '')
    .filter((value) => String(value).trim().length >= 4))
    .catch(() => []);
}

async function capturePostSubmitEvidence(page, responses, sensitiveTokens) {
  const frameObservations = [];
  for (const frame of page.frames()) {
    const observation = await frame.evaluate((signalLimit) => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (element) => (element.textContent || '').replace(/\s+/g, ' ').trim();
      const signalNodes = Array.from(document.querySelectorAll(
        'main h1, main h2, main h3, [role="alert"], [role="status"], [aria-live], dialog, [data-testid*="success" i], [data-testid*="confirm" i], [class*="success" i], [class*="confirm" i], [class*="thank" i]',
      ));
      const signalTexts = signalNodes
        .filter(visible)
        .map(textOf)
        .filter(Boolean)
        .slice(0, signalLimit);
      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body?.innerText || '',
        signalTexts,
        formCount: document.querySelectorAll('form').length,
        submitControlCount: Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(visible).length,
      };
    }, EVIDENCE_SIGNAL_LIMIT).catch(() => ({ url: frame.url(), title: '', bodyText: '', signalTexts: [], formCount: 0, submitControlCount: 0 }));
    frameObservations.push(observation);
  }

  const main = frameObservations[0] || { url: page.url(), title: '', bodyText: '', signalTexts: [], formCount: 0, submitControlCount: 0 };
  const confirmation = detectConfirmation({ ...main, frames: frameObservations });
  const normalizedBody = normalizeEvidenceText(frameObservations.map((frame) => frame.bodyText).join('\n'));
  const sanitizedSignals = [...new Set(frameObservations.flatMap((frame) => frame.signalTexts || []))]
    .map((value) => redactEvidenceText(value, sensitiveTokens))
    .filter(Boolean)
    .slice(0, EVIDENCE_SIGNAL_LIMIT);
  const sanitizedFrames = frameObservations.map((frame) => ({
    url: evidenceUrl(frame.url),
    title: redactEvidenceText(frame.title, sensitiveTokens).slice(0, 240),
    signalTexts: (frame.signalTexts || []).map((value) => redactEvidenceText(value, sensitiveTokens)).filter(Boolean).slice(0, EVIDENCE_SIGNAL_LIMIT),
    formCount: frame.formCount,
    submitControlCount: frame.submitControlCount,
    bodyTextLength: normalizeEvidenceText(frame.bodyText).length,
  }));

  return {
    observedAt: new Date().toISOString(),
    url: evidenceUrl(main.url || page.url()),
    title: redactEvidenceText(main.title, sensitiveTokens).slice(0, 240),
    markers: confirmation.markers,
    confirmed: confirmation.confirmed,
    signalTexts: sanitizedSignals,
    bodyPreview: redactEvidenceText(normalizedBody, sensitiveTokens).slice(0, EVIDENCE_TEXT_LIMIT),
    bodyTextLength: normalizedBody.length,
    bodyTextHash: shortHash(normalizedBody),
    frames: sanitizedFrames,
    responses: responses.slice(-EVIDENCE_RESPONSE_LIMIT),
  };
}

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
      'cdp-endpoint': { type: 'string' },
      'queue-id': { type: 'string' },
      'human-handoff': { type: 'boolean', default: false },
      'human-timeout': { type: 'string' },
      'prepare-only': { type: 'boolean', default: false },
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
    queueId: values['queue-id'] || '',
    company: values.company || '',
    title: values.title || '',
    lane: values.lane || '',
    jobDescription: values['job-description'] || '',
    fitScore: values['fit-score'] === undefined ? null : Number(values['fit-score']),
    liveness: values.liveness || '',
    browser: values.browser || process.env.CAREER_OPS_BROWSER_CHANNEL || 'chrome-beta',
    cdpEndpoint: values['cdp-endpoint'] || '',
    humanHandoff: !!values['human-handoff'],
    prepareOnly: !!values['prepare-only'],
    humanTimeoutMs: values['human-timeout'] === undefined
      ? HUMAN_HANDOFF_DEFAULT_TIMEOUT_MS
      : Math.max(30_000, Number(values['human-timeout']) * 1000 || HUMAN_HANDOFF_DEFAULT_TIMEOUT_MS),
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
  if (options.cdpEndpoint) return chromium.connectOverCDP(options.cdpEndpoint);
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

/** @param {import('playwright').Browser} browser @param {{ shared?: boolean }} [options] */
export async function createBrowserPage(browser, options = {}) {
  if (!options.shared) return browser.newPage();
  const context = browser.contexts()[0] || await browser.newContext();
  return context.newPage();
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

function isHybridWorkQuestion(questionText) {
  const text = String(questionText || '');
  const questionCue = /\b(?:are|would|will|can|do)\s+you\b/i.test(text);
  const workMode = /\b(?:hybrid|in[- ]?person|on[- ]?site|onsite|office)\b/i.test(text);
  const citySchedule = /\b(?:nyc|new york|san francisco|sf)\b[\s\S]{0,100}(?:\bdays?\s+(?:per|a)\s+week\b|\b\d+\s*%\b)/i.test(text);
  const cityRelocation = /\b(?:nyc|new york|san francisco|sf|bay area)\b/i.test(text)
    && /\b(?:relocat|move)\w*\b/i.test(text);
  return questionCue && (workMode || citySchedule || cityRelocation);
}

// Recurring custom questions every ATS tends to ask. Values come ONLY from the profile.
export function commonQuestions(profile) {
  const wa = profile.work_authorization || {};
  const authorized = wa.authorized_us ? 'Yes' : 'No';
  const needsSponsorship = wa.requires_sponsorship ? 'Yes' : 'No';
  const applicationAnswers = profile.application_answers && typeof profile.application_answers === 'object'
    ? profile.application_answers
    : {};
  const configured = (key) => {
    const value = applicationAnswers[key];
    if (!value || typeof value !== 'object') return null;
    const answer = String(value.answer || '').trim();
    return answer || null;
  };
  const rules = [
    // Authorization is checked BEFORE sponsorship so "authorized to work ... without
    // sponsorship?" resolves to the authorization answer, not the sponsorship one.
    { re: /legally authorized|authorized to work|eligible to work|work authorization|right to work/i, value: authorized },
    { re: /sponsor|require .*(petition|immigration)|file a petition|immigration status|nonimmigrant|visa status/i, value: needsSponsorship },
    { re: /(previously|ever).*(employed|worked).*(here|for (us|this)|at (this )?compan)|former employee|prior employment/i, value: 'No' },
    { re: /at least 18|18 years of age|are you 18/i, value: 'Yes' },
    { re: /currently.*(employed|work).*(here|for (us|this compan))/i, value: 'No' },
    { re: /have you ever interviewed at anthropic before/i, value: configured('anthropic_interview') },
    { re: /do you know anyone currently at glean/i, value: configured('glean_relationship') },
    { re: /\bdutch\b[\s\S]{0,100}\bc1\s*\/\s*c2\b|\bc1\s*\/\s*c2\b[\s\S]{0,100}\bdutch\b/i, value: configured('dutch_proficiency') },
    { match: isHybridWorkQuestion, value: configured('hybrid_work') },
    { re: /located (?:in|within) (?:the )?(?:united states|u\.s\.?|us)\b/i, value: configured('located_in_us') },
    { re: /located in north america\b/i, value: configured('located_in_north_america') },
    { re: /\b(?:located|live|based|reside)\b[\s\S]{0,60}\bsan francisco bay area\b/i, value: configured('located_in_bay_area') },
    { re: /live in one of the following states\b/i, value: configured('restricted_state_residence') },
    { re: /\b(?:used|worked with|experience with)\s+sentry\b|sentry experience/i, value: configured('sentry_experience') },
    { re: /llm evaluation|observability|guardrails/i, value: configured('llm_evaluation') },
    { re: /\bhow\s+long\b[\s\S]{0,220}\bcommit(?:ted|ting)?\b[\s\S]{0,120}\b(?:repository|repo)\b/i, value: configured('recent_code_commit') },
    { re: /which programming languages[\s\S]*most complex application|programming languages do you know/i, value: configured('programming_languages') },
    { re: /what is your main development language/i, value: configured('main_development_language') },
    { re: /^pronouns?$/i, value: profile.identity?.pronouns || null },
  ];
  return rules.filter((rule) => rule.value !== null && rule.value !== undefined && rule.value !== '');
}

// Resolve a question's answer from answers file (highest priority) then commonQuestions.
export function answerFor(questionText, tables) {
  for (const table of tables) {
    for (const entry of table) {
      if (typeof entry.match === 'function' && entry.match(questionText)) return entry.value;
      if (entry.re && entry.re.test(questionText)) return entry.value;
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
    review: (label, reason = '', metadata = {}) => summary.needsReview.push({
      label,
      reason,
      ...metadata,
      options: Array.isArray(metadata.options) ? metadata.options : [],
    }),
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
export const LEGAL_LABEL_RE = /attest|certif|background|criminal|conviction|terms (?:and|of)|agree.*(?:accurate|truth|conditions|terms)|privacy\s+(?:notice|policy)|ai\s+policy|double[- ]check|accuracy is crucial|information provided above|full[- ]time\s+(?:on[- ]?site|in[- ]person)[\s\S]*\b(?:london|germany|france|spain|netherlands|belgium|italy)\b/i;

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
    let nextFieldId = 0;
    const fieldEntry = (el) => el.closest('[data-field-path], [class*="_fieldEntry"], [class*="Field"], fieldset');
    const fieldKey = (el) => {
      const box = fieldEntry(el);
      if (!box) return el.name || el.id || '';
      const path = box.getAttribute('data-field-path');
      let id = box.getAttribute('data-codex-field-id');
      if (!id) {
        id = `codex-field-${nextFieldId++}`;
        box.setAttribute('data-codex-field-id', id);
      }
      const fieldPath = path || id;
      const optionInputs = Array.from(box.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      const names = new Set(optionInputs.map((input) => input.name || input.id).filter(Boolean));
      const groupByContainer = box.tagName.toLowerCase() === 'fieldset'
        || Boolean(box.querySelector('button'))
        || names.size > 1
        || !el.name;
      return groupByContainer ? `container:${fieldPath}` : `name:${fieldPath}:${el.name}`;
    };
    const fieldRequired = (el) => {
      const box = fieldEntry(el);
      return Boolean(box?.querySelector('[class*="_required"], [aria-required="true"]'));
    };
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

    const groupLabelFor = (el) => {
      if (/communicationConsent/i.test(el.name || '')) return 'Text message consent';
      const box = fieldEntry(el);
      const heading = box?.querySelector('legend, [class*="_heading"], [class*="question-title"]');
      if (heading && heading.textContent.trim()) return heading.textContent.trim();
      return labelFor(el);
    };

    const isRequired = (el) =>
      el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';

    const inRecaptcha = (el) =>
      el.name === 'g-recaptcha-response' ||
      !!el.closest('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], [class*="recaptcha" i]');

    const isVisible = (el) => {
      if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };

    const hasCustomSelection = (el) => Boolean(
      el.closest('.select__control')?.querySelector('.select__single-value, [aria-selected="true"]')?.textContent?.trim(),
    );

    const els = Array.from(document.querySelectorAll('input, select, textarea'));
    const out = [];
    const seenGroups = new Set();

    for (const el of els) {
      const type = (el.type || el.tagName).toLowerCase();
      if (type === 'hidden') continue;
      if (inRecaptcha(el)) continue;
      if (!isVisible(el)) continue;

      if (type === 'radio' || type === 'checkbox') {
        const name = el.name;
        const key = fieldKey(el);
        if (!key) {
          if ((isRequired(el) || fieldRequired(el)) && !el.checked) {
            out.push({ tag: el.tagName.toLowerCase(), type, name: '', id: el.id, label: labelFor(el), group: false });
          }
          continue;
        }
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const group = els.filter((x) => fieldKey(x) === key && (x.type || '').toLowerCase() === type);
        const groupRequired = group.some(isRequired) || fieldRequired(el);
        const box = fieldEntry(el);
        const customSelected = Boolean(box?.querySelector(
          'button[class*="_active"], button[aria-pressed="true"], [data-state="checked"]',
        ));
        const anyChecked = group.some((x) => x.checked) || customSelected;
        if (groupRequired && !anyChecked) {
          out.push({ tag: 'input', type, name, id: el.id, label: groupLabelFor(el), group: true });
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
      if (!isRequired(el) && !fieldRequired(el)) continue;
      const val = (el.value || '').trim();
      if (val === '' && !hasCustomSelection(el)) {
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

/** @param {string} label */
function isHumanOnlyReview(label) {
  return LEGAL_LABEL_RE.test(label)
    || /identity|verification|multi[- ]factor|one[- ]time password|captcha|recaptcha|hcaptcha|autocomplete|dropdown suggestion|select .* manually|current location/i.test(label);
}

/** @param {Array<Record<string, unknown>>} reviews */
function reviewState(reviews) {
  const blocking = reviews.filter((review) => {
    const label = String(review.label || '');
    return !EEO_LABEL_RE.test(label) && !MARKETING_RE.test(label);
  });
  if (blocking.some((review) => isHumanOnlyReview(String(review.label || '')))) {
    return { state: 'blocked_by_human', reason: `${blocking.length} field(s) require human review` };
  }
  if (blocking.length) {
    return { state: 'blocked_by_question', reason: `${blocking.length} required or unresolved field(s) need an answer` };
  }
  return { state: 'not_requested', reason: 'fill-only mode' };
}

export async function finish(page, browser, tools, {
  headless,
  url,
  submit = false,
  humanHandoff = false,
  humanTimeoutMs = HUMAN_HANDOFF_DEFAULT_TIMEOUT_MS,
  policy = loadPolicy(),
  ledgerPath = DEFAULT_LEDGER_PATH,
  adapter = 'unknown',
  applicationKey = '',
  queueId = '',
  company = '',
  title = '',
  fitScore = null,
  liveness = '',
  prepareOnly = false,
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
    recordQuestion(ledgerPath, label, {
      company,
      role: title,
      url,
      queueId,
      source: `adapter:${adapter}`,
      options: review.options,
      fieldKind: review.kind || review.fieldKind || null,
      reason: review.reason || '',
    });
  }

  const blockingReviews = needsReview.filter((review) => {
    const label = String(review.label || '');
    return !EEO_LABEL_RE.test(label) && !MARKETING_RE.test(label);
  });
  let submission = submit || humanHandoff || prepareOnly
    ? reviewState(blockingReviews)
    : { state: 'not_requested', reason: 'fill-only mode' };
  if (prepareOnly) {
    submission = blockingReviews.length
      ? reviewState(blockingReviews)
      : { state: 'handoff_ready', reason: 'form prepared in the shared browser session; waiting for human handoff' };
  } else if (humanHandoff) {
    if (headless) {
      submission = { state: 'blocked', reason: 'human handoff requires a visible browser; remove --headless' };
    } else if (submit) {
      submission = { state: 'blocked', reason: '--human-handoff cannot be combined with --submit' };
    } else {
      const effectiveLiveness = liveness === 'active' || liveness === 'expired'
        ? liveness
        : await hasActiveFormEvidence(page) ? 'active' : liveness;
      const gate = submissionGate(policy, adapter, { fitScore, liveness: effectiveLiveness, needsReview: blockingReviews.length });
      if (!gate.ok) {
        submission = { state: 'blocked', reason: gate.reason };
        console.log(`\n⚠️  Human handoff blocked: ${gate.reason}`);
      } else {
        console.log(`\n🧑‍💻 Human handoff ready: complete any CAPTCHA and click Submit manually in the visible browser. Watching for up to ${Math.round(humanTimeoutMs / 60000)} minutes.`);
        submission = await observeHumanSubmission(page, { adapter, url, timeoutMs: humanTimeoutMs });
        console.log(`\n${submission.state === 'submitted' ? '✅' : '⚠️'} Human handoff ${submission.state}: ${submission.reason}`);
      }
    }
  } else if (submit) {
    const effectiveLiveness = liveness === 'active' || liveness === 'expired'
      ? liveness
      : await hasActiveFormEvidence(page) ? 'active' : liveness;
    const gate = submissionGate(policy, adapter, { fitScore, liveness: effectiveLiveness, needsReview: blockingReviews.length });
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
    queueId,
    company,
    title,
    fitScore,
    filled,
    skipped,
    needsReview,
    submissionEvidence: submission.evidence || null,
  };
  if (submit || humanHandoff || headless || prepareOnly) console.log(`CAREER_OPS_APPLICATION_RESULT ${JSON.stringify(result)}`);

  if (prepareOnly) return result;
  if (headless || humanHandoff || submission.state === 'submitted') {
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
    return { state: 'blocked_by_captcha', reason: 'captcha or anti-bot challenge is present; human action is required' };
  }
  if (policy.stopOnMfa && /multi[- ]factor|one[- ]time password|verification code|sign in to continue/i.test(visibleText)) {
    return { state: 'blocked_by_mfa', reason: 'sign-in, MFA, or verification step is present; human action is required' };
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

  const sensitiveTokens = await collectSensitiveFieldValues(page);
  const responseSummaries = [];
  const onResponse = (response) => {
    const resourceType = response.request().resourceType();
    if (!['document', 'fetch', 'xhr'].includes(resourceType)) return;
    const responseUrl = evidenceUrl(response.url());
    if (!responseUrl) return;
    responseSummaries.push({
      resourceType,
      status: response.status(),
      ok: response.ok(),
      url: responseUrl,
    });
  };
  page.on('response', onResponse);

  let clickError = null;
  try {
    await candidates[0].click({ timeout: 5000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
  } catch (error) {
    clickError = error;
  }
  if (clickError) {
    page.off('response', onResponse);
    return { state: 'failed', reason: `submit control could not be clicked: ${clickError instanceof Error ? clickError.message : String(clickError)}` };
  }

  let evidence = await capturePostSubmitEvidence(page, responseSummaries, sensitiveTokens);
  const deadline = Date.now() + 8000;
  while (!evidence.confirmed && Date.now() < deadline) {
    await page.waitForTimeout(250);
    evidence = await capturePostSubmitEvidence(page, responseSummaries, sensitiveTokens);
  }
  page.off('response', onResponse);
  if (evidence.confirmed) {
    return {
      state: 'submitted',
      reason: `success confirmation detected for ${context.adapter}: ${evidence.markers.join(', ')}`,
      evidence,
    };
  }
  const block = detectSubmissionBlock(evidence);
  if (block.blocked) {
    return {
      state: block.state,
      reason: `anti-spam block detected (${block.markers.join(', ')}); human handoff required; automatic retry is disabled`,
      evidence,
    };
  }
  return {
    state: 'submission_unknown',
    reason: 'submit was clicked but no success confirmation was detected; automatic retry is disabled',
    evidence,
  };
}

/** @param {import('playwright').Page} page @param {{ adapter: string, url: string, timeoutMs: number }} context */
export async function observeHumanSubmission(page, context) {
  const sensitiveTokens = await collectSensitiveFieldValues(page);
  const responseSummaries = [];
  const onResponse = (response) => {
    const resourceType = response.request().resourceType();
    if (!['document', 'fetch', 'xhr'].includes(resourceType)) return;
    const responseUrl = evidenceUrl(response.url());
    if (!responseUrl) return;
    responseSummaries.push({ resourceType, status: response.status(), ok: response.ok(), url: responseUrl });
  };
  page.on('response', onResponse);
  const deadline = Date.now() + context.timeoutMs;
  let evidence = await capturePostSubmitEvidence(page, responseSummaries, sensitiveTokens);
  while (!page.isClosed() && Date.now() < deadline) {
    if (evidence.confirmed) {
      page.off('response', onResponse);
      return {
        state: 'submitted',
        reason: `success confirmation detected for ${context.adapter}: ${evidence.markers.join(', ')}`,
        evidence,
      };
    }
    const block = detectSubmissionBlock(evidence);
    if (block.blocked) {
      page.off('response', onResponse);
      return {
        state: block.state,
        reason: `anti-spam block detected (${block.markers.join(', ')}); automatic retry is disabled`,
        evidence,
      };
    }
    await page.waitForTimeout(500);
    evidence = await capturePostSubmitEvidence(page, responseSummaries, sensitiveTokens);
  }
  page.off('response', onResponse);
  if (page.isClosed()) {
    return {
      state: 'human_handoff_closed',
      reason: 'visible browser was closed before a confirmation was observed; no automatic retry',
      evidence,
    };
  }
  return {
    state: 'human_handoff_timeout',
    reason: `no manual submission confirmation observed within ${Math.round(context.timeoutMs / 60000)} minutes; no automatic retry`,
    evidence,
  };
}

/** @param {import('playwright').Page} page */
async function hasActiveFormEvidence(page) {
  const forms = await page.locator('form').count().catch(() => 0);
  const controls = await page.locator('button, input[type="submit"]').count().catch(() => 0);
  return forms > 0 && controls > 0;
}
