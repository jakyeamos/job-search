#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { launchBrowser, settle } from './lib/adapter-core.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    browser: { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const url = positionals[0];
if (!url) {
  console.error('Usage: node apply/inspect-form-shape.mjs <application-url> [--browser chrome-beta] [--headed]');
  process.exit(1);
}

const browser = await launchBrowser(chromium, {
  headless: !values.headed,
  channel: values.browser || process.env.CAREER_OPS_BROWSER_CHANNEL || 'chrome-beta',
});

try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const report = await page.evaluate(() => {
    const fieldEntry = (el) => el.closest('[data-field-path], [class*="_fieldEntry"], [class*="Field"], fieldset, .application-question');
    const text = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const labelFor = (el) => {
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return text(label.textContent);
      }
      const wrapper = el.closest('label');
      if (wrapper) return text(wrapper.textContent);
      const box = fieldEntry(el);
      if (box) return text(box.querySelector('legend, label, [class*="_heading"], [class*="label"]')?.textContent);
      return text(el.getAttribute('aria-label'));
    };
    const required = (el) => el.hasAttribute('required')
      || el.getAttribute('aria-required') === 'true'
      || Boolean(fieldEntry(el)?.querySelector('[class*="_required"], [aria-required="true"]'));
    const controls = Array.from(document.querySelectorAll('input, textarea, select, [role="combobox"]'))
      .filter((el) => el.type !== 'hidden' && el.name !== 'g-recaptcha-response')
      .map((el) => {
        const box = fieldEntry(el);
        return {
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          role: el.getAttribute('role') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          label: labelFor(el),
          required: required(el),
          placeholder: el.getAttribute('placeholder') || '',
          fieldPath: box?.getAttribute('data-field-path') || '',
          containerClass: box?.className || '',
        };
      });
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'))
      .map((el) => ({
        text: text(el.textContent || el.getAttribute('value')),
        type: el.getAttribute('type') || '',
        disabled: Boolean(el.disabled),
      }))
      .filter((button) => button.text);
    const options = Array.from(document.querySelectorAll('[role="option"]'))
      .map((el) => text(el.textContent))
      .filter(Boolean);
    return {
      title: document.title,
      formCount: document.querySelectorAll('form').length,
      controls,
      buttons,
      options,
    };
  });
  console.log(JSON.stringify({ url: page.url(), ...report }, null, 2));
} finally {
  await browser.close();
}
