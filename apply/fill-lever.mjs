#!/usr/bin/env node
// Deterministic auto-fill for Lever application forms (jobs.lever.co).
// Fills to submit-ready and STOPS — the human reviews and submits.
//
// Encoded DOM facts (confirmed against a live Match Group posting):
//   • Fields addressed by `name` (no stable ids): name (Full name), email, phone,
//     location, org (current company), urls[LinkedIn] / urls[GitHub] / urls[Portfolio].
//   • Résumé is a hidden input[name="resume"] — setInputFiles directly.
//   • NO cover-letter upload. Long-form text goes in an "Additional information"
//     textarea[name="comments"] when present (--cover-text).
//   • Custom questions are `.application-question` cards; fields are cards[{id}][field{n}]
//     and can be radio, native <select>, or text. Each radio is
//     <label><input type=radio value="X"><span>X</span></label>. A plain .check() and a
//     force-check can both fail (click point intercepted); fall back click <label> →
//     force-check → input.evaluate(el=>el.click()), and verify isChecked() before
//     claiming success.
//   • location is a Google-places autocomplete — fill the text but FLAG it: Lever rejects
//     bare free text (the hidden selectedLocation must be committed by picking a suggestion).
//   • EEO lives in surveysResponses[...] (and native <select name="eeo[...]"> on some
//     tenants) — detect but DO NOT fill.
//   • The captcha is hCaptcha (hidden h-captcha-response) — the human's job.

import { chromium } from 'playwright';
import {
  parseCliArgs, loadProfile, loadAnswers, loadLedgerAnswers, commonQuestions, answerFor,
  createSummary, fillBySelector, attachFile, detectRequired, launchBrowser, createBrowserPage, reconcile, finish,
  settle, EEO_LABEL_RE, LEGAL_LABEL_RE, MARKETING_RE,
} from './lib/adapter-core.mjs';

async function main() {
  const args = parseCliArgs();
  const profile = await loadProfile(args.profilePath);
  const answers = await loadAnswers(args.answersPath);
  const ledgerAnswers = await loadLedgerAnswers(args.ledgerPath, {
    company: args.company,
    role: args.title,
    url: args.url,
    description: args.jobDescription,
    lane: args.lane,
  });
  const tables = [answers, ledgerAnswers, commonQuestions(profile)];

  const resumePath = args.resume || profile.defaults?.resume_path || '';

  const browser = await launchBrowser(chromium, { headless: args.headless, channel: args.browser, cdpEndpoint: args.cdpEndpoint });
  const page = await createBrowserPage(browser, { shared: Boolean(args.cdpEndpoint) });
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="name"]').waitFor({ timeout: 20000 }).catch(() => {});
  await settle(page);

  const tools = createSummary();
  const id = profile.identity;
  const links = profile.links || {};

  // --- Standard fields (by name) -------------------------------------------
  await fillBySelector(page, 'input[name="name"]', id.full_name, 'Full name', tools);
  await fillBySelector(page, 'input[name="email"]', id.email, 'Email', tools);
  await fillBySelector(page, 'input[name="phone"]', id.phone, 'Phone', tools);
  await fillBySelector(page, 'input[name="org"]', currentEmployer(profile), 'Current company', tools);
  await fillUrl(page, 'LinkedIn', links.linkedin, tools);
  await fillUrl(page, 'GitHub', links.github, tools);
  await fillUrl(page, 'Portfolio', links.website, tools);

  // --- Résumé (hidden file input) ------------------------------------------
  await attachFile(page, 'input[name="resume"]', resumePath, 'Résumé', tools);

  // --- Additional information (cover text) ---------------------------------
  if (args.coverText && await page.locator('textarea[name="comments"]').count()) {
    await fillBySelector(page, 'textarea[name="comments"]', args.coverText, 'Additional information', tools);
  } else if (args.coverText) {
    tools.skip('Additional information', 'no comments field on this posting');
  }

  // --- Location autocomplete (fill + flag) ---------------------------------
  await fillLocation(page, profile, tools);

  // --- Custom question cards -----------------------------------------------
  const cards = await collectCards(page);
  for (const c of cards) {
    if (c.isEeo || EEO_LABEL_RE.test(c.label)) {
      tools.review(`EEO: ${c.label}`, 'voluntary self-identification — fill it yourself');
      continue;
    }
    if (MARKETING_RE.test(c.label)) {
      tools.skip(`Marketing consent: ${c.label}`, 'left unchecked (privacy default)');
      continue;
    }
    if (LEGAL_LABEL_RE.test(c.label)) {
      tools.review(`Legal: ${c.label}`, 'legal attestation or background question — answer manually');
      continue;
    }

    const value = resolveValue(c.label, id, profile, tables);
    if (value === null) {
      if (c.required) tools.review(c.label, 'no matching profile value — answer manually', { options: c.options, kind: c.kind, required: true });
      continue;
    }

    if (c.kind === 'radio' || c.kind === 'checkbox') {
      await checkOptionByValue(page, c.name, value, c.label, tools);
    } else if (c.kind === 'select') {
      await selectNativeByName(page, c.name, value, c.label, tools);
    } else {
      await fillBySelector(page, `[name="${esc(c.name)}"]`, value, c.label, tools);
    }
  }

  // --- Required-field reconciliation ---------------------------------------
  const stillEmpty = await detectRequired(page);
  reconcile(tools, stillEmpty);
  for (const e of stillEmpty) {
    if (EEO_LABEL_RE.test(e.label) || LEGAL_LABEL_RE.test(e.label) || /surveysResponses/.test(e.name || '')) continue;
    if (/^location$/.test(e.name || '')) continue; // already flagged
    if (!tools.summary.needsReview.some((r) => r.label === e.label)) {
      tools.review(e.label || e.name, 'required and still empty');
    }
  }

  await finish(page, browser, tools, {
    headless: args.headless,
    url: args.url,
    submit: args.submit,
    humanHandoff: args.humanHandoff,
    humanTimeoutMs: args.humanTimeoutMs,
    policy: await import('./application-policy.mjs').then(({ loadPolicy }) => loadPolicy(args.policyPath)),
    ledgerPath: args.ledgerPath,
    adapter: 'lever',
    applicationKey: args.applicationKey,
    queueId: args.queueId,
    company: args.company,
    title: args.title,
    fitScore: args.fitScore,
    liveness: args.liveness,
    prepareOnly: args.prepareOnly,
  });
}

function currentEmployer(profile) {
  const we = profile.work_experience || [];
  const cur = we.find((w) => w.current);
  return (cur || we[0])?.employer || '';
}

function resolveValue(label, id, profile, tables) {
  return answerFor(label, tables);
}

async function fillUrl(page, key, value, tools) {
  const sel = `input[name="urls[${key}]"]`;
  if (!(await page.locator(sel).count())) { tools.skip(`${key} URL`, 'field not present'); return; }
  await fillBySelector(page, sel, value, `${key} URL`, tools);
}

async function fillLocation(page, profile, tools) {
  const sel = 'input[name="location"]';
  if (!(await page.locator(sel).count())) return;
  const addr = profile.address || {};
  const text = [addr.city, addr.state].filter(Boolean).join(', ');
  if (!text) { tools.review('Current location', 'no city/state in profile'); return; }
  await page.locator(sel).fill(text);
  tools.review('Current location', `typed "${text}" — pick the dropdown suggestion so Lever commits it (bare text is rejected)`);
}

function esc(s) { return s.replace(/(["\\])/g, '\\$1'); }

// -------------------------------------------------------------------------
// Custom-card collector (page context). Only cards[...] and surveysResponses[...]
// fields; standard fields are handled directly by name.
// -------------------------------------------------------------------------
async function collectCards(page) {
  return page.evaluate(() => {
    const isCustom = (name) => /^cards\[|^surveysResponses\[/.test(name || '');
    const req = (el) => el.hasAttribute('required') || el.getAttribute('aria-required') === 'true'
      || !!el.closest('.application-question.required');

    const cardLabel = (el) => {
      const card = el.closest('.application-question');
      if (!card) return '';
      const lbl = card.querySelector('.application-label, label');
      if (!lbl) return '';
      // First text line only; drop the ✱ marker and helper text.
      return lbl.textContent.split('\n')[0].replace(/[✱*]/g, '').trim();
    };

    const out = [];
    const groups = new Map();
    document.querySelectorAll('.application-question input, .application-question select, .application-question textarea').forEach((el) => {
      const type = (el.type || el.tagName).toLowerCase();
      if (type === 'hidden') return;
      if (!isCustom(el.name)) return;
      const isEeo = /^surveysResponses\[/.test(el.name);

      if (type === 'radio' || type === 'checkbox') {
        if (!groups.has(el.name)) {
          groups.set(el.name, { kind: type, name: el.name, label: cardLabel(el), required: req(el), isEeo, options: [] });
        }
        const g = groups.get(el.name);
        if (req(el)) g.required = true;
        g.options.push(el.value);
        return;
      }
      const kind = type === 'textarea' ? 'textarea' : el.tagName.toLowerCase() === 'select' ? 'select' : 'text';
      out.push({ kind, name: el.name, label: cardLabel(el), required: req(el), isEeo });
    });
    for (const g of groups.values()) out.push(g);
    return out;
  });
}

async function selectNativeByName(page, name, value, label, tools) {
  const loc = page.locator(`select[name="${esc(name)}"]`).first();
  if (!(await loc.count())) { tools.review(label, 'dropdown not present'); return; }
  try {
    try { await loc.selectOption({ label: value }); }
    catch { await loc.selectOption({ value }); }
    tools.ok(label, name);
  } catch (err) { tools.review(label, `select failed: ${err.message}`); }
}

// Match a radio/checkbox by its value attribute (Lever options carry value="Yes" etc.).
// Fallback chain: click <label> → force-check → native in-page click; verify each time.
async function checkOptionByValue(page, name, value, label, tools) {
  const input = page.locator(`input[name="${esc(name)}"][value="${esc(value)}" i]`).first();
  if (!(await input.count())) { tools.review(label, `no option "${value}"`); return; }
  const ok = await robustCheck(page, input);
  if (ok) tools.ok(label, name);
  else tools.review(label, 'could not toggle option — set it manually');
}

async function robustCheck(page, input) {
  // 1) plain check
  try { await input.check({ timeout: 1500 }); if (await input.isChecked()) return true; } catch { /* next */ }
  // 2) click the enclosing <label>
  try {
    const wrapLabel = input.locator('xpath=ancestor::label[1]');
    if (await wrapLabel.count()) { await wrapLabel.first().click({ timeout: 1500 }); if (await input.isChecked()) return true; }
  } catch { /* next */ }
  // 3) force-check
  try { await input.check({ force: true, timeout: 1500 }); if (await input.isChecked()) return true; } catch { /* next */ }
  // 4) LAST RESORT: native in-page click (toggles a real radio regardless of overlays)
  try { await input.evaluate((el) => el.click()); return await input.isChecked(); } catch { return false; }
}

main().catch((err) => { console.error(err); process.exit(1); });
