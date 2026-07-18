import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChromeRefreshScript,
  decideLaunchAction,
  refreshExistingQueueTab,
} from '../scripts/queue-ui-launch.mjs';

test('existing queue tab is refreshed instead of opened again', () => {
  assert.equal(decideLaunchAction({ tabStatus: 'refreshed', alreadyOpenedToday: true }), 'refresh');
  assert.match(buildChromeRefreshScript('Google Chrome Beta'), /reload currentTab/);
  assert.match(buildChromeRefreshScript('Google Chrome Beta'), /127\.0\.0\.1:47831/);
});

test('launcher opens only when no existing queue tab is found', () => {
  assert.equal(decideLaunchAction({ tabStatus: 'missing', alreadyOpenedToday: false }), 'open');
  assert.equal(decideLaunchAction({ tabStatus: 'missing', alreadyOpenedToday: true }), 'skip');
});

test('browser inspection tries Chrome Beta before standard Chrome', () => {
  const calls = [];
  const result = refreshExistingQueueTab(
    (applicationName) => {
      calls.push(applicationName);
      return applicationName === 'Google Chrome Beta' ? 'refreshed' : 'missing';
    },
    () => true,
  );
  assert.deepEqual(result, { status: 'refreshed', applicationName: 'Google Chrome Beta' });
  assert.deepEqual(calls, ['Google Chrome Beta']);
});

test('launcher fails closed when a running browser cannot be inspected', () => {
  const result = refreshExistingQueueTab(() => 'unavailable', () => true);
  assert.deepEqual(result, { status: 'unknown', applicationName: '' });
  assert.equal(decideLaunchAction({ tabStatus: result.status, alreadyOpenedToday: false }), 'skip');
});
