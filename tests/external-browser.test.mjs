import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser } from '../apply/lib/adapter-core.mjs';
import { createHeadedPageProvider } from '../liveness-browser.mjs';

// These are the external-content launch contract's Playwright API requirements,
// not a copy of implementation constants. No real browser or network is used.
test('external browsing uses sandboxed stable browsers in headless and headed modes', async () => {
  const { launchExternalBrowser } = await import('../external-browser.mjs');
  const launches = [];
  const page = {};
  const browser = { newContext: async () => ({ newPage: async () => page }), close: async () => {} };
  const chromium = { launch: async (options) => { launches.push(options); return browser; } };

  assert.equal(await launchExternalBrowser(chromium), browser);
  const headed = createHeadedPageProvider(chromium);
  assert.equal(await headed.get(), page);
  await headed.close();
  assert.equal(await launchBrowser(chromium, { headless: true, channel: 'msedge' }), browser);

  assert.deepEqual(launches, [
    { channel: 'chrome', headless: true, chromiumSandbox: true },
    { channel: 'chrome', headless: false, chromiumSandbox: true },
    { channel: 'msedge', headless: true, chromiumSandbox: true },
  ]);
});

test('unsupported browser channels are rejected before launch', async () => {
  const { launchExternalBrowser } = await import('../external-browser.mjs');
  let launches = 0;
  const chromium = { launch: async () => { launches++; } };
  for (const channel of ['chromium', 'chrome-beta', 'msedge-dev', '', 'unknown']) {
    await assert.rejects(launchExternalBrowser(chromium, { channel }), /stable Chrome.*Edge/);
  }
  assert.equal(launches, 0);
});

test('application launch failure never retries with another browser', async () => {
  const cause = new Error('installed browser could not start');
  let launches = 0;
  const chromium = { launch: async () => { launches++; throw cause; } };
  let failure;
  try {
    await launchBrowser(chromium, { headless: false });
  } catch (error) {
    failure = error;
  }
  assert.equal(launches, 1, 'a failed stable launch must not fall back to a pinned browser');
  assert.equal(failure?.cause, cause);
  assert.match(failure.message, /sandboxed.*chrome/i);
});

test('explicit CDP attachment remains an attachment', async () => {
  const attached = {};
  const endpoint = 'http://127.0.0.1:9222';
  const chromium = {
    launch: async () => assert.fail('an explicit attachment must not launch a second browser'),
    connectOverCDP: async (value) => { assert.equal(value, endpoint); return attached; },
  };
  assert.equal(await launchBrowser(chromium, { cdpEndpoint: endpoint }), attached);
});
