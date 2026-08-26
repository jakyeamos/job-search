import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQueueUiReloadArgs,
  buildScheduledHealthArgs,
  buildScheduledBrowserPolicy,
  buildScheduledApplicationFillRequest,
  shouldStartScheduledApplicationFill,
  QUEUE_UI_LAUNCH_AGENT,
  SCHEDULED_APPLICATION_LIMIT,
  SCHEDULED_HEALTH_LIMIT,
  SCHEDULED_HUMAN_TIMEOUT_SECONDS,
  SCHEDULED_BROWSER_ACTION,
} from '../scripts/queue-ui-launch.mjs';

test('scheduled launcher rechecks the oldest queue URLs without entering the application flow', () => {
  const args = buildScheduledHealthArgs();
  assert.match(args[0], /[\\/]queue\.mjs$/);
  assert.deepEqual(args.slice(1), [
    'health',
    '--limit',
    String(SCHEDULED_HEALTH_LIMIT),
    '--apply',
    '--browser',
  ]);
  assert.equal(SCHEDULED_HEALTH_LIMIT, 100);
});

test('scheduled launcher requests the bounded daily fill with a workday review window', () => {
  assert.deepEqual(buildScheduledApplicationFillRequest(), {
    limit: SCHEDULED_APPLICATION_LIMIT,
    humanTimeoutSeconds: SCHEDULED_HUMAN_TIMEOUT_SECONDS,
  });
  assert.equal(SCHEDULED_APPLICATION_LIMIT, 6);
  assert.equal(SCHEDULED_HUMAN_TIMEOUT_SECONDS, 8 * 60 * 60);
  assert.equal(shouldStartScheduledApplicationFill(false), true);
  assert.equal(shouldStartScheduledApplicationFill(true), false);
});

test('a fresh daily fill reloads the persistent queue service before use', () => {
  assert.deepEqual(buildQueueUiReloadArgs(501), [
    'kickstart',
    '-k',
    `gui/501/${QUEUE_UI_LAUNCH_AGENT}`,
  ]);
});

test('scheduled launcher leaves browser ownership to Daily Front Page', () => {
  assert.deepEqual(buildScheduledBrowserPolicy(), {
    action: SCHEDULED_BROWSER_ACTION,
    opensBrowser: false,
    owner: 'Daily Front Page',
    queueUrl: 'http://127.0.0.1:47831/',
  });
  assert.equal(SCHEDULED_BROWSER_ACTION, 'front-page-owned');
});
