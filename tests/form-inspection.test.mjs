import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { inspectApplicationFlow } from '../apply/form-inspection.mjs';

test('read-only flow traverses an optional page and stops before required inputs', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="intro">
        <p>Review this application.</p>
        <button id="continue" type="button">Continue</button>
      </form>
      <script>
        document.querySelector('#continue').addEventListener('click', () => {
          document.body.innerHTML = '<form><label for="why">Why are you interested?</label><textarea id="why" required></textarea><button type="submit">Submit application</button><button type="button">Next</button></form>';
        });
      </script>
    `);

    const flow = await inspectApplicationFlow(page, { settleMs: 10 });
    assert.equal(flow.pageCount, 2);
    assert.equal(flow.blocked, true);
    assert.match(flow.blockedReason, /required application fields/);
    assert.equal(flow.pages[0].buttons[0].nextLike, true);
    assert.equal(flow.pages[1].controls[0].required, true);
    assert.equal(flow.pages[1].buttons[0].submitLike, true);
    assert.equal(page.url(), flow.pages[1].url);
  } finally {
    await browser.close();
  }
});

test('read-only flow stops on login and challenge signals', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<form><h1>Sign in to continue</h1><input autocomplete="username"><input type="password"></form>');
    const login = await inspectApplicationFlow(page, { settleMs: 10 });
    assert.equal(login.blocked, true);
    assert.match(login.blockedReason, /login|account verification/);

    await page.setContent('<main><h1>Verify you are human</h1><p>Complete the CAPTCHA to continue.</p></main>');
    const challenge = await inspectApplicationFlow(page, { settleMs: 10 });
    assert.equal(challenge.blocked, true);
    assert.match(challenge.blockedReason, /CAPTCHA|identity verification/);
  } finally {
    await browser.close();
  }
});
