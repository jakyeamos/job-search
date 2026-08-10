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
  matchAnswerToOptions, matchAnswersToOptions,
  createSummary, fillBySelector, attachFile, selectNative, detectRequired, launchBrowser, createBrowserPage, reconcile,
  finish, settle, EEO_LABEL_RE, LEGAL_LABEL_RE, MARKETING_RE,
} from './lib/adapter-core.mjs';
import { readReactSelectOptions } from './lib/react-select-options.mjs';

const STANDARD_IDS = new Set(['first_name', 'last_name', 'email', 'phone', 'preferred_name']);

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
  const tables = [answers, ledgerAnswers, commonQuestions(profile, {
    company: args.company,
    title: args.title,
    location: args.jobLocation,
    url: args.url,
    description: args.jobDescription,
    lane: args.lane,
  })];

  const resumePath = args.resume || profile.defaults?.resume_path || '';
  const coverPath = args.cover || profile.defaults?.cover_letter_path || '';

  const browser = await launchBrowser(chromium, { headless: args.headless, channel: args.browser, cdpEndpoint: args.cdpEndpoint });
  const page = await createBrowserPage(browser, { shared: Boolean(args.cdpEndpoint) });
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

  // Set the phone country before custom react-select questions; Greenhouse can
  // re-render the custom-question section when the phone country changes.
  if (await page.locator('#country').count()) {
    await selectReactSelectByLabel(page, 'Country', profile.address?.country || '', tools, '#country');
  }

  // --- Custom questions ----------------------------------------------------
  const questions = await collectQuestions(page);
  for (const q of [...questions].sort((left, right) => Number(left.kind === 'combobox') - Number(right.kind === 'combobox'))) {
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

    const rawValue = resolveValue(q.label, id, profile, tables);
    const value = rawValue === null
      ? null
      : q.kind === 'checkbox'
        ? matchAnswersToOptions(rawValue, q.options)
        : matchAnswerToOptions(rawValue, q.options);
    if (value === null) {
      if (q.required) tools.review(q.label, 'no matching profile value — answer manually', { options: q.options, kind: q.kind, required: true });
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
    } else if (q.kind === 'checkbox') {
      await checkCheckboxesByValue(page, q.name, value, q.label, tools);
    }
  }

  // A late Greenhouse field re-render can clear a selected custom dropdown;
  // reconcile the known combobox answers once after all text fields settle.
  for (const q of questions.filter((question) => question.kind === 'combobox')) {
    if (EEO_LABEL_RE.test(q.label) || MARKETING_RE.test(q.label) || LEGAL_LABEL_RE.test(q.label)) continue;
    const rawValue = resolveValue(q.label, id, profile, tables);
    const value = rawValue === null ? null : matchAnswerToOptions(rawValue, q.options);
    if (value !== null) await selectReactSelectByLabel(page, q.label, value, tools);
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
    humanHandoff: args.humanHandoff,
    humanTimeoutMs: args.humanTimeoutMs,
    policy: await import('./application-policy.mjs').then(({ loadPolicy }) => loadPolicy(args.policyPath)),
    ledgerPath: args.ledgerPath,
    adapter: 'greenhouse',
    applicationKey: args.applicationKey,
    queueId: args.queueId,
    company: args.company,
    title: args.title,
    fitScore: args.fitScore,
    liveness: args.liveness,
    prepareOnly: args.prepareOnly,
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
  const questions = await page.evaluate((standardIds) => {
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
      if (!['input', 'select', 'textarea'].includes(tag)) return;
      if (el.type === 'hidden') return;
      if (tag === 'textarea') out.push({ kind: 'textarea', id: el.id, label: labelFor(el), required: req(el), options: [] });
      else if (tag === 'select') out.push({
        kind: 'select',
        id: el.id,
        label: labelFor(el),
        required: req(el),
        options: Array.from(el.options).map((option) => option.textContent.trim()).filter(Boolean),
      });
      else if (el.type === 'radio' || el.type === 'checkbox') {
        if (seenRadio.has(el.name)) return; seenRadio.add(el.name);
        const options = el.name
          ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)).map(optionLabel).filter(Boolean)
          : [];
        out.push({ kind: el.type, name: el.name, id: el.id, label: labelFor(el), required: req(el), options: [...new Set(options)] });
      } else {
        const kind = el.getAttribute('role') === 'combobox' ? 'combobox' : 'text';
        out.push({ kind, id: el.id, label: labelFor(el), required: req(el) });
      }
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
      const options = [...new Set(Array.from(node.querySelectorAll('[role="option"], .select__option')).map((option) => option.textContent.trim()).filter(Boolean))];
      out.push({ kind: 'combobox', id: inputId, label, required, options });
    });

    // De-dup by label (a react-select can also expose a hidden native mirror).
    const byLabel = new Map();
    for (const q of out) if (q.label && !byLabel.has(q.label)) byLabel.set(q.label, q);
    return Array.from(byLabel.values());
  }, [...STANDARD_IDS, 'country']);
  const optionCache = new Map();
  for (const question of questions) {
    if (question.kind !== 'combobox' || question.options?.length || !String(question.id || '').startsWith('question_')) continue;
    const cacheKey = question.id || question.label;
    if (!optionCache.has(cacheKey)) {
      optionCache.set(cacheKey, await readReactSelectOptions(page, {
        id: question.id,
        label: question.label,
      }));
    }
    const options = optionCache.get(cacheKey);
    if (options?.length) question.options = options;
  }
  return questions;
}

function cssId(id) {
  return id.replace(/([^\w-])/g, '\\$1');
}

// React-select: open the field's combobox (scoped by its label), type the value,
// and click the matching option WITHIN the aria-controls listbox / control menu.
async function selectReactSelectByLabel(page, labelText, value, tools, inputSelector = '') {
  if (!value) { tools.review(labelText, 'no value in profile'); return; }
  const input = inputSelector
    ? page.locator(inputSelector).first()
    : page
      .locator('div')
      .filter({ has: page.locator('.select__control') })
      .filter({ hasText: labelText })
      .last()
      .locator('.select__control input')
      .first();
  const control = input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " select__control ")][1]');
  if (!(await control.count())) { tools.skip(labelText, 'no combobox'); return; }

  const wrapper = control.locator('xpath=..');
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
      if (hit) {
        await scope.nth(i).click({ force: true });
        await page.waitForTimeout(150);
        if (!(await control.locator('.select__single-value').count())) {
          await input.press('Enter').catch(() => {});
          await page.waitForTimeout(150);
        }
        picked = Boolean(await control.locator('.select__single-value').count());
        break;
      }
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

async function checkCheckboxesByValue(page, name, values, label, tools) {
  if (!Array.isArray(values) || !values.length) {
    tools.review(label, 'no checkbox options were selected');
    return;
  }
  const failures = [];
  for (const value of values) {
    const inputs = page.locator(`input[name="${name}"]`);
    const count = await inputs.count();
    let input = null;
    for (let index = 0; index < count; index++) {
      const candidate = inputs.nth(index);
      const candidateValue = String(await candidate.getAttribute('value') || '').trim();
      const candidateId = await candidate.getAttribute('id');
      const optionLabel = candidateId
        ? String(await page.locator(`label[for="${candidateId}"]`).first().innerText().catch(() => '')).trim()
        : '';
      if ([candidateValue, optionLabel].some((text) => text.toLowerCase() === String(value).toLowerCase())) {
        input = candidate;
        break;
      }
    }
    if (!input) {
      failures.push(`no option "${value}"`);
      continue;
    }
    try {
      await input.check();
    } catch (error) {
      failures.push(`"${value}" failed: ${error.message}`);
    }
  }
  if (failures.length) tools.review(label, failures.join('; '));
  else tools.ok(label, name);
}

main().catch((err) => { console.error(err); process.exit(1); });
