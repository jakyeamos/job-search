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

test('classifies checkbox-backed Yes/No controls as single-choice', async (t) => {
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
      <form>
        <div data-field-path="openSource">
          <h3>Have you contributed to open-source projects before?</h3>
          <input id="open-source-value" type="checkbox">
          <button type="button">Yes</button>
          <button type="button">No</button>
        </div>
        <button type="submit">Submit application</button>
      </form>
    `);

    const inspection = await inspectApplicationPage(page);
    assert.equal(inspection.controls[0].kind, 'checkbox');
    assert.deepEqual(inspection.controls[0].options, ['Yes', 'No']);
    assert.equal(inspection.controls[0].multiple, false);
  } finally {
    await browser.close();
  }
});

test('opens custom comboboxes read-only so choice options are captured before rendering', async (t) => {
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
      <form>
        <div class="field-wrapper">
          <label for="question_event">Which campus event did you attend? (Select 'Not applicable' if you haven't attended one yet)</label>
          <div class="select__control">
            <input id="question_event" role="combobox" aria-expanded="false" aria-haspopup="true">
          </div>
        </div>
      </form>
      <script>
        const control = document.querySelector('.select__control');
        const input = document.querySelector('#question_event');
        control.addEventListener('click', () => {
          input.setAttribute('aria-expanded', 'true');
          input.setAttribute('aria-controls', 'event-options');
          if (document.querySelector('#event-options')) return;
          const list = document.createElement('div');
          list.id = 'event-options';
          list.setAttribute('role', 'listbox');
          list.innerHTML = '<div role="option">Campus event</div><div role="option">Not applicable</div>';
          document.body.append(list);
        });
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          document.querySelector('#event-options')?.remove();
          input.setAttribute('aria-expanded', 'false');
          input.removeAttribute('aria-controls');
        });
      </script>
    `);

    const inspection = await inspectApplicationPage(page);
    const question = inspection.controls.find((control) => control.id === 'question_event');
    assert.equal(question.kind, 'combobox');
    assert.deepEqual(question.options, ['Campus event', 'Not applicable']);
    assert.equal(await page.locator('#event-options').count(), 0);
    assert.equal(await page.locator('#question_event').getAttribute('aria-expanded'), 'false');
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

test('read-only flow may click a posting-page Apply control but never a form Apply control', async (t) => {
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
        <button id="apply" type="button">Apply</button>
      </main>
      <script>
        document.querySelector('#apply').addEventListener('click', () => {
          document.body.innerHTML = '<form><label for="why">Why are you interested?</label><textarea id="why" required></textarea><button type="button">Apply</button></form>';
        });
      </script>
    `);

    const flow = await inspectApplicationFlow(page, { settleMs: 10 });
    assert.equal(flow.pageCount, 2);
    assert.equal(flow.blocked, false);
    assert.equal(flow.actions[0].reason, 'posting-page-apply-navigation');
    assert.equal(flow.pages[0].buttons[0].applyLike, true);
    assert.equal(flow.pages[0].buttons[0].submitLike, false);
    assert.equal(flow.pages[1].buttons[0].applyLike, true);
    assert.equal(flow.pages[1].buttons[0].submitLike, true);
    assert.equal(await page.locator('textarea').count(), 1);
  } finally {
    await browser.close();
  }
});

test('read-only flow refuses to guess when a posting page has multiple Apply controls', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<main><h1>Backend Engineer</h1><button type="button">Apply</button><a href="#form">Apply</a></main>');

    const flow = await inspectApplicationFlow(page, { settleMs: 10 });
    assert.equal(flow.pageCount, 1);
    assert.equal(flow.actions.length, 0);
    assert.equal(flow.blocked, true);
    assert.match(flow.blockedReason, /multiple posting-page Apply controls/);
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
