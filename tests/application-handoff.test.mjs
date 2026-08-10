import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handoffEligible,
  handoffPreparationResult,
  launchPersistentHandoffContext,
  mergeHandoffObservation,
  persistentContextOptions,
  publishHandoffPreparation,
  shouldWatchPreparedHandoff,
} from '../application-handoff.mjs';

test('headed handoff launches Chrome with a persistent context profile', async () => {
  const calls = [];
  const context = {};
  const browserType = {
    async launchPersistentContext(profileDir, options) {
      calls.push({ profileDir, options });
      return context;
    },
  };

  assert.equal(
    await launchPersistentHandoffContext(browserType, '/tmp/application-handoff-profile', 43123, 'chrome'),
    context,
  );
  assert.deepEqual(calls, [{
    profileDir: '/tmp/application-handoff-profile',
    options: {
      headless: false,
      channel: 'chrome',
      args: ['--remote-debugging-port=43123'],
    },
  }]);
  assert.equal(persistentContextOptions(43123, 'chrome').args.some((arg) => arg.startsWith('--user-data-dir=')), false);
});

test('question-blocked applications remain eligible for browser handoff', () => {
  assert.equal(handoffEligible({ applicationState: 'blocked_by_question' }), true);
});

test('a prepared question-blocked tab remains open for human answers and submission', () => {
  const page = {};
  assert.equal(shouldWatchPreparedHandoff({
    ok: true,
    page,
    result: {
      state: 'blocked_by_question',
      reason: 'required field needs an answer',
    },
  }), true);
});

test('handoff preparation publishes unanswered questions before waiting for the human review window', () => {
  const calls = [];
  const state = { items: [] };
  const item = { id: 'role-1' };
  const result = {
    state: 'blocked_by_question',
    reason: 'one required field needs an answer',
    needsReview: [{ label: 'Why this role?', required: true }],
  };
  const persisted = publishHandoffPreparation(state, item, result, (...args) => {
    calls.push(args);
    return { state: args[2].state };
  });

  assert.equal(persisted.state, 'blocked_by_question');
  assert.deepEqual(calls, [[state, item, result]]);
});

test('a ready handoff is normalized to the reusable review state', () => {
  assert.deepEqual(handoffPreparationResult({ state: 'handoff_ready', reason: 'ready' }), {
    state: 'prepared_for_review',
    reason: 'ready',
  });
});

test('closing or timing out a handoff does not erase its unanswered questions', () => {
  const preparation = {
    state: 'blocked_by_question',
    reason: 'one required field needs an answer',
    needsReview: [{ label: 'Why this role?', required: true }],
  };
  const merged = mergeHandoffObservation(preparation, {
    state: 'human_handoff_timeout',
    reason: 'no confirmation observed',
    evidence: { confirmed: false },
  });

  assert.equal(merged.state, 'blocked_by_question');
  assert.deepEqual(merged.needsReview, preparation.needsReview);
  assert.deepEqual(merged.handoffObservation, {
    state: 'human_handoff_timeout',
    reason: 'no confirmation observed',
    evidence: { confirmed: false },
  });
});

test('a confirmed submission clears the preparation questions', () => {
  const merged = mergeHandoffObservation({
    state: 'blocked_by_question',
    needsReview: [{ label: 'Why this role?', required: true }],
  }, {
    state: 'submitted',
    reason: 'confirmation detected',
    evidence: { confirmed: true },
  });

  assert.equal(merged.state, 'submitted');
  assert.deepEqual(merged.needsReview, []);
});
