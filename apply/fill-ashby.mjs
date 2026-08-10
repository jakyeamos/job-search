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
  matchAnswerToOptions, matchAnswersToOptions,
  createSummary, fillBySelector, attachFile, detectRequired, launchBrowser, createBrowserPage, reconcile, finish,
  settle, EEO_LABEL_RE, LEGAL_LABEL_RE, MARKETING_RE,
} from './lib/adapter-core.mjs';
import { normalizeChoiceField } from './lib/choice-shape.mjs';
import { readReactSelectOptions } from './lib/react-select-options.mjs';

function normalizeUrl(url) {
  if (/\/application\/?$/.test(url)) return url;
  return url.replace(/\/?$/, '') + '/application';
}

const US_STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

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

  const url = normalizeUrl(args.url);
  const browser = await launchBrowser(chromium, { headless: args.headless, channel: args.browser, cdpEndpoint: args.cdpEndpoint });
  const page = await createBrowserPage(browser, { shared: Boolean(args.cdpEndpoint) });
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
  const fields = (await collectFields(page)).map(normalizeChoiceField);
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

    const rawValue = resolveValue(f.label, f.kind, id, profile, tables);
    const value = rawValue === null
      ? null
      : f.kind === 'checkbox' && f.multiple
        ? matchAnswersToOptions(rawValue, f.options)
        : matchAnswerToOptions(rawValue, f.options);
    if (value === null) {
      if (f.required) tools.review(f.label, 'no matching profile value — answer manually', {
        options: f.options,
        kind: f.kind,
        multiple: f.multiple,
        required: true,
      });
      continue;
    }

    if (f.kind === 'combobox') {
      await fillCombobox(page, f.selector, value, f.label, tools);
    } else if (f.kind === 'text' || f.kind === 'textarea') {
      await fillByName(page, f.name, f.id, value, f.label, tools);
    } else if (f.kind === 'select') {
      await selectNativeByName(page, f.name, value, f.label, tools);
    } else if (f.kind === 'checkbox' && f.multiple) {
      await checkOptionsByText(page, f.name, value, f.label, tools, f.containerSelector);
    } else if (f.kind === 'radio' || f.kind === 'checkbox') {
      await checkOptionByText(page, f.name, value, f.label, tools, f.containerSelector);
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
    humanHandoff: args.humanHandoff,
    humanTimeoutMs: args.humanTimeoutMs,
    policy: await import('./application-policy.mjs').then(({ loadPolicy }) => loadPolicy(args.policyPath)),
    ledgerPath: args.ledgerPath,
    adapter: 'ashby',
    applicationKey: args.applicationKey,
    queueId: args.queueId,
    company: args.company,
    title: args.title,
    fitScore: args.fitScore,
    liveness: args.liveness,
    prepareOnly: args.prepareOnly,
  });
}

function resolveValue(label, kind, id, profile, tables) {
  const L = label.toLowerCase();
  // Link / phone / location values only make sense in free-text fields — never as a
  // radio/checkbox option (e.g. the "How did you hear about us?" LinkedIn checkbox).
  if (kind === 'text' || kind === 'textarea' || kind === 'combobox') {
    const links = profile.links || {};
    if (/linkedin/.test(L) && links.linkedin) return links.linkedin;
    if (/github/.test(L) && links.github) return links.github;
    if (/(website|portfolio|personal site)/.test(L) && links.website) return links.website;
    if (/phone|mobile/.test(L) && id.phone) return id.phone;
    if (/pronoun/.test(L) && id.pronouns) return id.pronouns;
    if (/location|city/.test(L) && profile.address?.city) {
      const state = profile.address.state || '';
      return [profile.address.city, US_STATE_NAMES[state.toUpperCase()] || state].filter(Boolean).join(', ');
    }
  }
  return answerFor(label, tables);
}

// -------------------------------------------------------------------------
// Field collector (page context). Skips system fields (handled directly) and
// reCAPTCHA. Groups radio/checkbox inputs by name.
// -------------------------------------------------------------------------
async function collectFields(page) {
  const fields = await page.evaluate(() => {
    let nextFieldId = 0;
    const fieldEntry = (el) => el.closest('[data-field-path], [class*="_fieldEntry"], [class*="Field"], fieldset');
    const fieldPath = (el) => {
      const box = fieldEntry(el);
      if (!box) return '';
      const path = box.getAttribute('data-field-path');
      if (path) return path;
      let id = box.getAttribute('data-codex-field-id');
      if (!id) {
        id = `codex-field-${nextFieldId++}`;
        box.setAttribute('data-codex-field-id', id);
      }
      return id;
    };
    const fieldSelector = (el) => {
      const box = fieldEntry(el);
      const path = box?.getAttribute('data-field-path');
      if (path) return `[data-field-path="${CSS.escape(path)}"]`;
      const id = fieldPath(el);
      return id ? `[data-codex-field-id="${CSS.escape(id)}"]` : '';
    };
    const groupKey = (el) => {
      const box = fieldEntry(el);
      const path = fieldPath(el);
      if (!box) return el.name || el.id || '';
      const optionInputs = Array.from(box.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      const names = new Set(optionInputs.map((input) => input.name || input.id).filter(Boolean));
      const groupByContainer = box.tagName.toLowerCase() === 'fieldset'
        || Boolean(box.querySelector('button'))
        || names.size > 1
        || !el.name;
      return groupByContainer ? `container:${path}` : `name:${path}:${el.name}`;
    };
    const fieldRequired = (box) => Boolean(box?.querySelector('[class*="_required"], [aria-required="true"]'));
    const fieldLabel = (el) => {
      const box = fieldEntry(el) || el.closest('[class*="_container"]');
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
        const box = fieldEntry(el);
        const key = groupKey(el);
        const label = /communicationConsent/i.test(el.name || '')
          ? 'Text message consent'
          : fieldLabel(el);
        if (!groups.has(key)) {
          groups.set(key, {
            kind: type,
            name: el.name,
            label,
            required: req(el) || fieldRequired(box),
            options: [],
            containerSelector: fieldSelector(el),
          });
        }
        const g = groups.get(key);
        if (req(el)) g.required = true;
        const option = optionLabel(el);
        if (option) g.options.push(option);
        if (box) {
          for (const button of box.querySelectorAll('button')) {
            const text = button.textContent.trim();
            if (/^(?:yes|no)$/i.test(text)) g.options.push(text);
          }
        }
        return;
      }
      const isCombobox = el.getAttribute('role') === 'combobox';
      if (!el.name && !el.id && !isCombobox) return; // un-addressable stray input
      const kind = isCombobox
        ? 'combobox'
        : type === 'textarea' ? 'textarea' : el.tagName.toLowerCase() === 'select' ? 'select' : 'text';
      const label = fieldLabel(el);
      if (!label) return;
      out.push({
        kind,
        name: el.name,
        id: el.id,
        label,
        required: req(el) || fieldRequired(fieldEntry(el)),
        options: el.tagName.toLowerCase() === 'select'
          ? Array.from(el.options).map((option) => option.textContent.trim()).filter(Boolean)
          : [...new Set(Array.from(fieldEntry(el)?.querySelectorAll?.('[role="option"], .select__option') || []).map((option) => option.textContent.trim()).filter(Boolean))],
        selector: isCombobox
          ? `${fieldSelector(el) ? `${fieldSelector(el)} ` : ''}input[role="combobox"]`
          : '',
      });
    });
    for (const g of groups.values()) if (g.label) out.push(g);
    return out;
  });
  const optionCache = new Map();
  for (const field of fields) {
    if (field.kind !== 'combobox' || field.options?.length) continue;
    const cacheKey = field.id || field.label;
    if (!optionCache.has(cacheKey)) {
      optionCache.set(cacheKey, await readReactSelectOptions(page, {
        id: field.id,
        label: field.label,
      }));
    }
    const options = optionCache.get(cacheKey);
    if (options?.length) field.options = options;
  }
  return fields;
}

function esc(s) { return s.replace(/(["\\])/g, '\\$1'); }

async function fillByName(page, name, id, value, label, tools) {
  const sel = id ? `[id="${esc(id)}"]` : `[name="${esc(name)}"]`;
  await fillBySelector(page, sel, value, label, tools);
}

async function fillCombobox(page, selector, value, label, tools) {
  const loc = page.locator(selector || 'input[role="combobox"]').first();
  if (!(await loc.count())) {
    tools.review(label, 'autocomplete field was not found');
    return;
  }
  try {
    await loc.fill(String(value));
    await page.waitForTimeout(500);
    const option = page.getByRole('option', { name: new RegExp(regexEscape(String(value)), 'i') }).first();
    try {
      await option.waitFor({ state: 'visible', timeout: 3000 });
      await option.click();
      tools.ok(label, selector || 'input[role="combobox"]');
      return;
    } catch {
      tools.review(label, 'autocomplete suggestion did not match; select the location manually');
    }
  } catch (err) {
    tools.review(label, `autocomplete fill failed: ${err.message}`);
  }
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
async function checkOptionByText(page, name, value, label, tools, containerSelector = '') {
  const container = containerSelector ? page.locator(containerSelector).first() : null;
  const inputs = container && await container.count()
    ? container.locator('input')
    : page.locator(`input[name="${esc(name)}"]`);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const optId = await el.getAttribute('id');
    let text = '';
    if (optId) text = (await page.locator(`label[for="${esc(optId)}"]`).first().innerText().catch(() => '')) || '';
    if (!text) text = (await el.evaluate((node) => node.closest('label')?.innerText || '').catch(() => '')) || '';
    if (!text) text = (await el.getAttribute('value')) || '';
    if (text.trim().toLowerCase() === value.toLowerCase() || text.trim().toLowerCase().includes(value.toLowerCase())) {
      const ok = await robustCheck(page, el, optId);
      if (ok) tools.ok(label, name);
      else tools.review(label, 'could not toggle option — set it manually');
      return;
    }
  }
  if (container) {
    const option = container.getByRole('button', { name: new RegExp(`^${regexEscape(String(value))}$`, 'i') }).first();
    if (await option.count()) {
      try {
        await option.click();
        tools.ok(label, containerSelector);
        return;
      } catch (err) {
        tools.review(label, `could not toggle option — ${err.message}`);
        return;
      }
    }
  }
  tools.review(label, `no option matched "${value}"`);
}

async function checkOptionsByText(page, name, values, label, tools, containerSelector = '') {
  if (!Array.isArray(values) || !values.length) {
    tools.review(label, 'no checkbox options were selected');
    return;
  }
  const optionTools = createSummary();
  for (const value of values) {
    await checkOptionByText(page, name, value, label, optionTools, containerSelector);
  }
  if (optionTools.summary.needsReview.length) {
    tools.review(label, optionTools.summary.needsReview.map((item) => item.reason).join('; '));
  } else {
    tools.ok(label, name);
  }
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
