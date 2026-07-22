import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { inspectApplicationFlow, inspectApplicationPage, normalizeJobTitle } from '../apply/form-inspection.mjs';

test('normalizes source annotations from queue titles before comparison', () => {
  assert.equal(normalizeJobTitle('\\[C\\] Data Engineer, Safeguards'), 'Data Engineer, Safeguards');
  assert.equal(normalizeJobTitle('[C] Backend Engineer'), 'Backend Engineer');
  assert.equal(normalizeJobTitle('Senior Backend Engineer'), 'Senior Backend Engineer');
});

test('extracts the rendered application-page job description without reading form values', async (t) => {
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
      <main>
        <h1>Backend Engineer</h1>
        <section data-testid="job-description">
          <h2>About the role</h2>
          <p>Build reliable Python and TypeScript services, APIs, data pipelines, PostgreSQL workflows, automated tests, and production systems with product and engineering partners. Own systems from design through operation and improve the developer experience.</p>
        </section>
        <form>
          <label for="answer">Why are you interested?</label>
          <textarea id="answer">Do not read this current value.</textarea>
          <button type="submit">Submit application</button>
        </form>
      </main>
    `);

    const inspection = await inspectApplicationPage(page, { expectedTitle: 'Backend Engineer' });
    assert.equal(inspection.titleVisible, true);
    assert.equal(inspection.jobDescriptionSource, 'application-page:selector');
    assert.match(inspection.jobDescription, /Build reliable Python and TypeScript services/);
    assert.doesNotMatch(inspection.jobDescription, /Do not read this current value/);
  } finally {
    await browser.close();
  }
});

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
