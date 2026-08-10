import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeQuestionPropagation,
  parseQueueUiProcesses,
  renderQuestionPropagationReport,
  resolveQuestionWindow,
} from '../question-propagation-doctor.mjs';
import { queueUiHealthPayload } from '../queue-ui.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/question-propagation/today-15-nine-missing.json', import.meta.url),
  'utf8',
));

function fixtureWindow() {
  return resolveQuestionWindow(fixture.since);
}

function analyze(overrides = {}) {
  return analyzeQuestionPropagation({
    ledger: fixture.ledger,
    queue: fixture.queue,
    window: fixtureWindow(),
    service: fixture.service,
    generatedAt: fixture.generatedAt,
    ...overrides,
  });
}

test('question propagation fixture reproduces 15 captures and nine unpublished answerable questions', () => {
  const result = analyze();
  const expected = fixture.expected;

  assert.equal(result.captured.canonicalQuestions, expected.canonicalQuestions);
  assert.equal(result.captured.observations, expected.observations);
  assert.equal(result.captured.roles, expected.roles);
  assert.equal(result.classification.answerableQuestions, expected.answerableQuestions);
  assert.equal(result.classification.humanOnlyFields, expected.humanOnlyFields);
  assert.equal(result.classification.alreadyAnsweredQuestions, expected.alreadyAnsweredQuestions);
  assert.equal(
    result.propagation.capturedButUnpublishedQuestions,
    expected.capturedButUnpublishedQuestions,
  );
  assert.equal(result.propagation.capturedButUnpublishedOccurrences, 10);
  assert.equal(result.propagation.publishedOccurrences, 0);
  assert.equal(result.service.predatesSource, true);
  assert.equal(result.status, 'issues');
  assert.equal(result.exitCode, 1);
});

test('human-only and already-answered fields are separated from propagation failures', () => {
  const result = analyze();

  assert.equal(result.exclusions.humanOnly.length, 4);
  assert.deepEqual(
    [...new Set(result.exclusions.humanOnly.map((entry) => entry.reason))].sort(),
    ['communication-consent', 'legal-attestation'],
  );
  assert.equal(result.exclusions.alreadyAnswered.length, 2);
  assert.ok(result.propagation.missing.every((entry) => entry.id.startsWith('q_answerable_')));
});

test('fully persisted and UI-eligible questions produce a healthy diagnostic', () => {
  const queue = structuredClone(fixture.queue);
  for (const entry of fixture.ledger.entries.slice(0, 9)) {
    for (const context of entry.contexts) {
      const item = queue.items.find((candidate) => candidate.id === context.queueId);
      item.applicationResult.needsReview.push({
        label: entry.question,
        required: context.required === true,
        kind: 'text',
      });
    }
  }
  const service = {
    ...fixture.service,
    freshness: 'current',
    predatesSource: false,
    startedAt: '2026-08-04T15:00:00.000Z',
  };
  const result = analyze({ queue, service });

  assert.equal(result.propagation.fullyPublishedQuestions, 9);
  assert.equal(result.propagation.publishedOccurrences, 10);
  assert.equal(result.propagation.capturedButUnpublishedQuestions, 0);
  assert.equal(result.status, 'healthy');
  assert.equal(result.exitCode, 0);
});

test('unavailable queue evidence is incomplete instead of reporting false missing questions', () => {
  const service = { ...fixture.service, freshness: 'current', predatesSource: false };
  const result = analyze({ queue: { items: [] }, queueAvailable: false, service });

  assert.equal(result.propagation.capturedButUnpublishedQuestions, 0);
  assert.equal(result.propagation.unknownQuestions, 9);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.exitCode, 2);
});

test('report is read-only and never prints stored answer values', () => {
  const report = renderQuestionPropagationReport(analyze());

  assert.match(report, /Read-only: no queue, ledger, service, or application state was changed\./);
  assert.doesNotMatch(report, /Fixture resolved value/);
});

test('today window starts at Eastern midnight and process parsing identifies the queue UI', () => {
  const window = resolveQuestionWindow('', new Date('2026-08-04T15:00:00.000Z'));
  assert.equal(window.since, '2026-08-04T04:00:00.000Z');

  const root = '/Users/example/career-ops';
  const processes = parseQueueUiProcesses(
    '45227 Tue Aug  4 08:05:26 2026 /usr/local/bin/node /Users/example/career-ops/queue-ui.mjs --serve\n',
    root,
  );
  assert.deepEqual(processes, [{ pid: 45227, startedAt: '2026-08-04T12:05:26.000Z' }]);
});

test('queue UI health contract exposes the process start time for future freshness checks', () => {
  assert.deepEqual(queueUiHealthPayload('2026-08-04T15:00:00.000Z'), {
    ok: true,
    service: 'career-ops-queue-ui',
    startedAt: '2026-08-04T15:00:00.000Z',
  });
});
