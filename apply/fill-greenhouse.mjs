#!/usr/bin/env node
// Deterministic auto-fill for Greenhouse application forms (job-boards.greenhouse.io).
// Fills to submit-ready and STOPS — the human reviews and submits.
//
// Encoded DOM facts (confirmed against a live PlanetScale posting):
//   • Stable ids: #first_name #last_name #email #phone #preferred_name.
//   • Hidden file inputs #resume / #cover_letter — setInputFiles directly, never click
//     "Attach" (filechooser race), never .nth() (breaks after the first re-render).
//   • Custom questions are #question_{id} (text/textarea/native-select) OR react-select
//     comboboxes, each with a real <label>. Match by label text.
//   • react-select options: scope the option search to the combobox's aria-controls
//     listbox (or the control's own menu) — otherwise the intl phone-country picker
//     (#iti-0__country-listbox) pollutes the global [role=option] set and "No" fuzzy-
//     matches "Norway".
//   • EEO/demographic questions are react-select — detect and flag, never fill.

import { chromium } from 'playwright';
import {
  parseCliArgs, loadProfile, loadAnswers, loadLedgerAnswers, commonQuestions, answerFor,
  createSummary, fillBySelector, attachFile, selectNative, detectRequired, launchBrowser, reconcile,
  finish, settle, EEO_LABEL_RE, LEGAL_LABEL_RE, MARKETING_RE,
} from './lib/adapter-core.mjs';

const STANDARD_IDS = new Set(['first_name', 'last_name', 'email', 'phone', 'preferred_name']);

async function main() {
  const args = parseCliArgs();
  const profile = await loadProfile(args.profilePath);
  const answers = await loadAnswers(args.answersPath);
  const ledgerAnswers = await loadLedgerAnswers(args.ledgerPath, { company: args.company, role: args.title, url: args.url });
  const tables = [answers, ledgerAnswers, commonQuestions(profile)];

  const resumePath = args.resume || profile.defaults?.resume_path || '';
  const coverPath = args.cover || profile.defaults?.cover_letter_path || '';

  const browser = await launchBrowser(chromium, { headless: args.headless, channel: args.browser });
  const page = await browser.newPage();
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  await page.locator('#first_name').waitFor({ timeout: 20000 }).catch(() => {});
  await settle(page);

  const tools = createSummary();
  const id = profile.identity;

  // --- Standard fields -----------------------------------------------------
  await fillBySelector(page, '#first_name', id.first_name, 'First name', tools);
  await fillBySelector(page, '#last_name', id.last_name, 'Last name', tools);
  await fillBySelector(page, '#email', id.email, 'Email', tools);
  await fillBySelector(page, '#phone', id.phone, 'Phone', tools);
  if (id.preferred_name) {
    await fillBySelector(page, '#preferred_name', id.preferred_name, 'Preferred name', tools);
  }

  // --- Files ---------------------------------------------------------------
  await attachFile(page, '#resume', resumePath, 'Résumé', tools);
  await attachFile(page, '#cover_letter', coverPath, 'Cover letter', tools);

  // --- Custom questions ----------------------------------------------------
  const questions = await collectQuestions(page);
  for (const q of questions) {
    if (EEO_LABEL_RE.test(q.label)) {
      tools.review(`EEO: ${q.label}`, 'voluntary self-identification — fill it yourself');
      continue;
    }
    if (MARKETING_RE.test(q.label)) {
      tools.skip(`Marketing consent: ${q.label}`, 'left unchecked (privacy default)');
      continue;
    }
    if (LEGAL_LABEL_RE.test(q.label)) {
      tools.review(`Legal: ${q.label}`, 'legal attestation or background question — answer manually');
      continue;
    }

    const value = resolveValue(q.label, id, profile, tables);
    if (value === null) {
      if (q.required) tools.review(q.label, 'no matching profile value — answer manually');
      continue;
    }

    if (q.kind === 'text' || q.kind === 'textarea') {
      await fillBySelector(page, `#${cssId(q.id)}`, value, q.label, tools);
    } else if (q.kind === 'select') {
      await selectNative(page, `#${cssId(q.id)}`, value, q.label, tools);
    } else if (q.kind === 'combobox') {
      await selectReactSelectByLabel(page, q.label, value, tools);
    } else if (q.kind === 'radio') {
      await checkRadioByValue(page, q.name, value, q.label, tools);
    }
  }

  // Country combobox (system field) — fill from address.country when present.
  if (await page.locator('#country').count()) {
    await selectReactSelectByLabel(page, 'Country', profile.address?.country || '', tools);
  }

  // --- Required-field reconciliation ---------------------------------------
  const stillEmpty = await detectRequired(page);
  reconcile(tools, stillEmpty);
  for (const e of stillEmpty) {
    if (EEO_LABEL_RE.test(e.label) || LEGAL_LABEL_RE.test(e.label)) continue; // already flagged / never auto-filled
    if (!tools.summary.needsReview.some((r) => r.label === e.label)) {
      tools.review(e.label, 'required and still empty');
    }
  }

  await finish(page, browser, tools, {
    headless: args.headless,
    url: args.url,
    submit: args.submit,
    policy: await import('./application-policy.mjs').then(({ loadPolicy }) => loadPolicy(args.policyPath)),
    ledgerPath: args.ledgerPath,
    adapter: 'greenhouse',
    applicationKey: args.applicationKey,
    company: args.company,
    title: args.title,
    fitScore: args.fitScore,
    liveness: args.liveness,
  });
}

// -------------------------------------------------------------------------
// Value resolution: links / phone by label, else common+answers tables.
// -------------------------------------------------------------------------
function resolveValue(label, id, profile, tables) {
  const L = label.toLowerCase();
  const links = profile.links || {};
  if (/linkedin/.test(L) && links.linkedin) return links.linkedin;
  if (/github/.test(L) && links.github) return links.github;
  if (/(website|portfolio|personal site)/.test(L) && links.website) return links.website;
  if (/phone/.test(L) && id.phone) return id.phone;
  if (/(^|[^a-z])name([^a-z]|$)/.test(L) && /full/.test(L) && id.full_name) return id.full_name;
  return answerFor(label, tables);
}

// -------------------------------------------------------------------------
// Custom-question collector (runs in page context).
// -------------------------------------------------------------------------
async function collectQuestions(page) {
  return page.evaluate((standardIds) => {
    const STANDARD = new Set(standardIds);
    const labelFor = (el) => {
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.textContent.replace(/\*/g, '').trim(); }
      const w = el.closest('label'); if (w) return w.textContent.replace(/\*/g, '').trim();
      return (el.getAttribute('aria-label') || '').trim();
    };
    const req = (el) => el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
    const out = [];
    const seenRadio = new Set();

    // Native question inputs / textareas / selects (#question_{id}).
    document.querySelectorAll('[id^="question_"]').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (el.type === 'hidden') return;
      if (tag === 'textarea') out.push({ kind: 'textarea', id: el.id, label: labelFor(el), required: req(el) });
      else if (tag === 'select') out.push({ kind: 'select', id: el.id, label: labelFor(el), required: req(el) });
      else if (el.type === 'radio' || el.type === 'checkbox') {
        if (seenRadio.has(el.name)) return; seenRadio.add(el.name);
        out.push({ kind: 'radio', name: el.name, id: el.id, label: labelFor(el), required: req(el) });
      } else out.push({ kind: 'text', id: el.id, label: labelFor(el), required: req(el) });
    });

    // React-select comboboxes that are NOT standard/system fields (e.g. Yes/No custom
    // questions, EEO). Resolve the field label by walking up to the enclosing block.
    document.querySelectorAll('.select__control').forEach((ctrl) => {
      const inputId = ctrl.querySelector('input')?.id || '';
      if (STANDARD.has(inputId)) return;
      let label = '';
      let node = ctrl;
      for (let i = 0; i < 6 && node.parentElement; i++) {
        node = node.parentElement;
        const l = node.querySelector && node.querySelector('label');
        if (l && l.textContent.trim()) { label = l.textContent.replace(/\*/g, '').trim(); break; }
      }
      if (!label) return;
      const block = node;
      const required = !!(block.querySelector && block.querySelector('[aria-required="true"]'));
      out.push({ kind: 'combobox', label, required });
    });

    // De-dup by label (a react-select can also expose a hidden native mirror).
    const byLabel = new Map();
    for (const q of out) if (q.label && !byLabel.has(q.label)) byLabel.set(q.label, q);
    return Array.from(byLabel.values());
  }, [...STANDARD_IDS, 'country']);
}

function cssId(id) {
  return id.replace(/([^\w-])/g, '\\$1');
}

// React-select: open the field's combobox (scoped by its label), type the value,
// and click the matching option WITHIN the aria-controls listbox / control menu.
async function selectReactSelectByLabel(page, labelText, value, tools) {
  if (!value) { tools.review(labelText, 'no value in profile'); return; }
  const wrapper = page
    .locator('div')
    .filter({ has: page.locator('.select__control') })
    .filter({ hasText: labelText })
    .last();
  const control = wrapper.locator('.select__control').first();
  if (!(await control.count())) { tools.skip(labelText, 'no combobox'); return; }

  const input = control.locator('input').first();
  await control.click();
  await input.type(value, { delay: 15 });
  await page.waitForTimeout(200);

  // Scope options to the combobox's own listbox (avoids phone-picker pollution).
  const listboxId = await input.getAttribute('aria-controls');
  const optionSel = listboxId
    ? `[id="${listboxId}"] [role="option"], [id="${listboxId}"] .select__option`
    : '.select__menu [role="option"], .select__menu .select__option';
  const scope = listboxId ? page.locator(optionSel) : wrapper.locator(optionSel);

  const n = await scope.count();
  let picked = false;
  for (const exact of [true, false]) {
    for (let i = 0; i < n; i++) {
      const t = (await scope.nth(i).innerText()).trim();
      const hit = exact ? t.toLowerCase() === value.toLowerCase() : t.toLowerCase().includes(value.toLowerCase());
      if (hit) { await scope.nth(i).click(); picked = true; break; }
    }
    if (picked) break;
  }

  if (picked) tools.ok(labelText, ''); // reconciliation confirms it stuck
  else { tools.review(labelText, `no option matched "${value}"`); await input.press('Escape').catch(() => {}); }
}

async function checkRadioByValue(page, name, value, label, tools) {
  const input = page.locator(`input[name="${name}"][value="${value}" i]`).first();
  if (!(await input.count())) { tools.review(label, `no option "${value}"`); return; }
  try {
    await input.check();
    tools.ok(label, name);
  } catch (err) { tools.review(label, `radio failed: ${err.message}`); }
}

main().catch((err) => { console.error(err); process.exit(1); });
