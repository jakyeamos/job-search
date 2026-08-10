import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChromeOpenArgs,
  buildQueueUiReloadArgs,
  buildScheduledHealthArgs,
  buildChromeRefreshScript,
  buildScheduledApplicationFillRequest,
  decideLaunchAction,
  refreshExistingQueueTab,
  shouldStartScheduledApplicationFill,
  QUEUE_UI_LAUNCH_AGENT,
  SCHEDULED_APPLICATION_LIMIT,
  SCHEDULED_HEALTH_LIMIT,
  SCHEDULED_HUMAN_TIMEOUT_SECONDS,
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

test('new queue tabs open in standard Chrome', () => {
  assert.deepEqual(buildChromeOpenArgs(), ['-a', 'Google Chrome', 'http://127.0.0.1:47831/']);
});

test('existing queue tab is refreshed instead of opened again', () => {
  assert.equal(decideLaunchAction({ tabStatus: 'refreshed', alreadyOpenedToday: true }), 'refresh');
  assert.match(buildChromeRefreshScript('Google Chrome'), /reload currentTab/);
  assert.match(buildChromeRefreshScript('Google Chrome'), /127\.0\.0\.1:47831/);
});

test('launcher opens only when no existing queue tab is found', () => {
  assert.equal(decideLaunchAction({ tabStatus: 'missing', alreadyOpenedToday: false }), 'open');
  assert.equal(decideLaunchAction({ tabStatus: 'missing', alreadyOpenedToday: true }), 'skip');
});

test('browser inspection uses standard Chrome', () => {
  const calls = [];
  const result = refreshExistingQueueTab(
    (applicationName) => {
      calls.push(applicationName);
      return applicationName === 'Google Chrome' ? 'refreshed' : 'missing';
    },
    () => true,
  );
  assert.deepEqual(result, { status: 'refreshed', applicationName: 'Google Chrome' });
  assert.deepEqual(calls, ['Google Chrome']);
});

test('launcher fails closed when a running browser cannot be inspected', () => {
  const result = refreshExistingQueueTab(() => 'unavailable', () => true);
  assert.deepEqual(result, { status: 'unknown', applicationName: '' });
  assert.equal(decideLaunchAction({ tabStatus: result.status, alreadyOpenedToday: false }), 'skip');
});
