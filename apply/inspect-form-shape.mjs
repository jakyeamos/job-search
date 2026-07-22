#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createBrowserPage, launchBrowser, settle } from './lib/adapter-core.mjs';
import { inspectApplicationPage, normalizeApplicationUrl } from './form-inspection.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    browser: { type: 'string' },
    'cdp-endpoint': { type: 'string' },
    headed: { type: 'boolean', default: false },
  },
});

const url = positionals[0];
if (!url) {
  console.error('Usage: node apply/inspect-form-shape.mjs <application-url> [--browser chrome-beta] [--cdp-endpoint <url>] [--headed]');
  process.exit(1);
}

const browser = await launchBrowser(chromium, {
  headless: !values.headed,
  channel: values.browser || process.env.CAREER_OPS_BROWSER_CHANNEL || 'chrome-beta',
  cdpEndpoint: values['cdp-endpoint'] || process.env.CAREER_OPS_CDP_ENDPOINT || process.env.OPENCLI_CDP_ENDPOINT || '',
});

try {
  const cdpEndpoint = values['cdp-endpoint'] || process.env.CAREER_OPS_CDP_ENDPOINT || process.env.OPENCLI_CDP_ENDPOINT || '';
  const page = await createBrowserPage(browser, { shared: Boolean(cdpEndpoint) });
  await page.goto(normalizeApplicationUrl(url), { waitUntil: 'domcontentloaded' });
  await settle(page);
  console.log(JSON.stringify(await inspectApplicationPage(page), null, 2));
} finally {
  await browser.close();
}
