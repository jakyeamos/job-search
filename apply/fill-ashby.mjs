#!/usr/bin/env node
// Deterministic auto-fill for Ashby application forms (jobs.ashbyhq.com).
// Fills to submit-ready and STOPS — the human reviews and submits.
//
// Encoded DOM facts (confirmed against a live Notion posting):
//   • ONE combined "Legal/Full Name" field #_systemfield_name (not First/Last), plus
//     #_systemfield_email and the résumé file input #_systemfield_resume.
//   • Phone and every custom question use GENERATED UUID ids/names — NOT #phone or
//     #question_{id}. Match those by their <label> text.
//   • reCAPTCHA (textarea#g-recaptcha-response) appears only at submit — the human's
//     job; excluded from required detection.
//   • Normalize the URL to /application if it isn't already.

import { chromium } from 'playwright';
import {
  parseCliArgs, loadProfile, loadAnswers, loadLedgerAnswers, commonQuestions, answerFor,
  createSummary, fillBySelector, attachFile, detectRequired, launchBrowser, reconcile, finish,
  settle, EEO_LABEL_RE, LEGAL_LABEL_RE, MARKETING_RE,
} from './lib/adapter-core.mjs';

function normalizeUrl(url) {
  if (/\/application\/?$/.test(url)) return url;
  return url.replace(/\/?$/, '') + '/application';
}

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
  const coverPath = args.cover || profile.defaults?.cover_letter_path || '';

  const url = normalizeUrl(args.url);
  const browser = await launchBrowser(chromium, { headless: args.headless, channel: args.browser });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#_systemfield_name').waitFor({ timeout: 20000 }).catch(() => {});
  await settle(page);

  const tools = createSummary();
  const id = profile.identity;

  // --- System fields -------------------------------------------------------
  await fillBySelector(page, '#_systemfield_name', id.full_name, 'Full name', tools);
  await fillBySelector(page, '#_systemfield_email', id.email, 'Email', tools);
  await attachFile(page, '#_systemfield_resume', resumePath, 'Résumé', tools);
  if (await page.locator('#cover_letter').count()) {
    await attachFile(page, '#cover_letter', coverPath, 'Cover letter', tools);
  }

  // --- Custom + label-addressed fields -------------------------------------
  const fields = await collectFields(page);
  for (const f of fields) {
    if (EEO_LABEL_RE.test(f.label)) {
      tools.review(`EEO: ${f.label}`, 'voluntary self-identification — fill it yourself');
      continue;
    }
    if (MARKETING_RE.test(f.label)) {
      tools.skip(`Marketing consent: ${f.label}`, 'left unchecked (privacy default)');
      continue;
    }
    if (LEGAL_LABEL_RE.test(f.label)) {
      tools.review(`Legal: ${f.label}`, 'legal attestation or background question — answer manually');
      continue;
    }

    const value = resolveValue(f.label, f.kind, id, profile, tables);
    if (value === null) {
      if (f.required) tools.review(f.label, 'no matching profile value — answer manually');
      continue;
    }

    if (f.kind === 'text' || f.kind === 'textarea') {
      await fillByName(page, f.name, f.id, value, f.label, tools);
    } else if (f.kind === 'select') {
      await selectNativeByName(page, f.name, value, f.label, tools);
    } else if (f.kind === 'radio' || f.kind === 'checkbox') {
      await checkOptionByText(page, f.name, value, f.label, tools);
    }
  }

  // --- Required-field reconciliation ---------------------------------------
  const stillEmpty = await detectRequired(page);
  reconcile(tools, stillEmpty);
  for (const e of stillEmpty) {
    if (EEO_LABEL_RE.test(e.label) || LEGAL_LABEL_RE.test(e.label)) continue;
    if (!tools.summary.needsReview.some((r) => r.label === e.label)) {
      tools.review(e.label, 'required and still empty');
    }
  }

  await finish(page, browser, tools, {
    headless: args.headless,
    url,
    submit: args.submit,
    policy: await import('./application-policy.mjs').then(({ loadPolicy }) => loadPolicy(args.policyPath)),
    ledgerPath: args.ledgerPath,
    adapter: 'ashby',
    applicationKey: args.applicationKey,
    company: args.company,
    title: args.title,
    fitScore: args.fitScore,
    liveness: args.liveness,
  });
}

function resolveValue(label, kind, id, profile, tables) {
  const L = label.toLowerCase();
  // Link / phone / location values only make sense in free-text fields — never as a
  // radio/checkbox option (e.g. the "How did you hear about us?" LinkedIn checkbox).
  if (kind === 'text' || kind === 'textarea') {
    const links = profile.links || {};
    if (/linkedin/.test(L) && links.linkedin) return links.linkedin;
    if (/github/.test(L) && links.github) return links.github;
    if (/(website|portfolio|personal site)/.test(L) && links.website) return links.website;
    if (/phone|mobile/.test(L) && id.phone) return id.phone;
    if (/pronoun/.test(L) && id.pronouns) return id.pronouns;
    if (/location|city/.test(L) && profile.address?.city) {
      return [profile.address.city, profile.address.state].filter(Boolean).join(', ');
    }
  }
  return answerFor(label, tables);
}

// -------------------------------------------------------------------------
// Field collector (page context). Skips system fields (handled directly) and
// reCAPTCHA. Groups radio/checkbox inputs by name.
// -------------------------------------------------------------------------
async function collectFields(page) {
  return page.evaluate(() => {
    const fieldLabel = (el) => {
      const box = el.closest('[class*="_fieldEntry"], [class*="Field"], fieldset, [class*="_container"]');
      if (box) {
        const lg = box.querySelector('label, legend, [class*="_label"]');
        if (lg && lg.textContent.trim()) return lg.textContent.replace(/\*/g, '').trim();
      }
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent.replace(/\*/g, '').trim(); }
      const albl = el.getAttribute('aria-label'); if (albl) return albl.trim();
      return '';
    };
    const optionLabel = (el) => {
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent.trim(); }
      const w = el.closest('label'); if (w) return w.textContent.trim();
      return el.value || '';
    };
    const req = (el) => el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';

    const out = [];
    const groups = new Map();
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      const type = (el.type || el.tagName).toLowerCase();
      if (type === 'hidden') return;
      if (el.name === 'g-recaptcha-response') return;
      if (el.id && el.id.startsWith('_systemfield_')) return; // handled directly
      if (type === 'file') return;

      if (type === 'radio' || type === 'checkbox') {
        const key = el.name || el.id;
        if (!groups.has(key)) {
          groups.set(key, { kind: type, name: el.name, label: fieldLabel(el), required: req(el), options: [] });
        }
        const g = groups.get(key);
        if (req(el)) g.required = true;
        g.options.push(optionLabel(el));
        return;
      }
      if (!el.name && !el.id) return; // un-addressable stray input
      const kind = type === 'textarea' ? 'textarea' : el.tagName.toLowerCase() === 'select' ? 'select' : 'text';
      const label = fieldLabel(el);
      if (!label) return;
      out.push({ kind, name: el.name, id: el.id, label, required: req(el) });
    });
    for (const g of groups.values()) if (g.label) out.push(g);
    return out;
  });
}

function esc(s) { return s.replace(/(["\\])/g, '\\$1'); }

async function fillByName(page, name, id, value, label, tools) {
  const sel = id ? `[id="${esc(id)}"]` : `[name="${esc(name)}"]`;
  await fillBySelector(page, sel, value, label, tools);
}

async function selectNativeByName(page, name, value, label, tools) {
  const loc = page.locator(`select[name="${esc(name)}"]`).first();
  if (!(await loc.count())) { tools.review(label, 'dropdown is a custom widget — set it manually'); return; }
  try {
    try { await loc.selectOption({ label: value }); }
    catch { await loc.selectOption({ value }); }
    tools.ok(label, name);
  } catch (err) { tools.review(label, `select failed: ${err.message}`); }
}

// Check the radio/checkbox whose OPTION label matches the value text.
async function checkOptionByText(page, name, value, label, tools) {
  const inputs = page.locator(`input[name="${esc(name)}"]`);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const optId = await el.getAttribute('id');
    let text = '';
    if (optId) text = (await page.locator(`label[for="${esc(optId)}"]`).first().innerText().catch(() => '')) || '';
    if (!text) text = (await el.getAttribute('value')) || '';
    if (text.trim().toLowerCase() === value.toLowerCase() || text.trim().toLowerCase().includes(value.toLowerCase())) {
      const ok = await robustCheck(page, el, optId);
      if (ok) tools.ok(label, name);
      else tools.review(label, 'could not toggle option — set it manually');
      return;
    }
  }
  tools.review(label, `no option matched "${value}"`);
}

// Click-to-toggle fallback chain with verification.
async function robustCheck(page, input, optId) {
  try { await input.check({ timeout: 2000 }); if (await input.isChecked()) return true; } catch { /* fall through */ }
  if (optId) {
    try { await page.locator(`label[for="${esc(optId)}"]`).first().click({ timeout: 2000 }); if (await input.isChecked()) return true; } catch { /* fall through */ }
  }
  try { await input.evaluate((el) => el.click()); return await input.isChecked(); } catch { return false; }
}

main().catch((err) => { console.error(err); process.exit(1); });
