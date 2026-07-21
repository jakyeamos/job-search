#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { launchBrowser, settle } from './lib/adapter-core.mjs';
import { inspectApplicationPage, normalizeApplicationUrl } from './form-inspection.mjs';

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
  await page.goto(normalizeApplicationUrl(url), { waitUntil: 'domcontentloaded' });
  await settle(page);
  console.log(JSON.stringify(await inspectApplicationPage(page), null, 2));
} finally {
  await browser.close();
}
