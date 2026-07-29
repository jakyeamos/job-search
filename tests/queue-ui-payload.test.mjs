import test from 'node:test';
import assert from 'node:assert/strict';

import { archiveStub } from '../queue-archive.mjs';
import { questionPayload, queuePayload } from '../queue-ui.mjs';

/** @param {Record<string, unknown>} overrides */
function item(overrides) {
  return {
    id: 'x',
    company: 'Acme',
    title: 'Backend Engineer',
    applyUrl: 'https://example.com/jobs/1',
    canonicalUrl: 'https://example.com/jobs/1',
    status: 'ready',
    fitScore: 4.5,
    freshness: 'fresh',
    ...overrides,
  };
}

test('dead-end counts come from the archived index, not from live items', () => {
  const payload = queuePayload({
    items: [
      item({ id: 'a', status: 'ready' }),
      item({ id: 'b', status: 'in_review' }),
      item({ id: 'c', status: 'stale' }),
      item({ id: 'd', status: 'skipped' }),
    ],
    archivedIndex: [
      archiveStub(item({ id: 'e', status: 'excluded' }), '2026-07-10T00:00:00.000Z'),
      archiveStub(item({ id: 'f', status: 'excluded' }), '2026-07-10T00:00:00.000Z'),
      archiveStub(item({ id: 'g', status: 'archived' }), '2026-07-10T00:00:00.000Z'),
    ],
  });
  assert.equal(payload.totals.excluded, 2);
  assert.equal(payload.totals.archived, 1);
  assert.equal(payload.totals.stale, 1);
  assert.equal(payload.totals.skipped, 1);
  assert.equal(payload.totals.filtered, 5);
  assert.equal(payload.totals.retained, 7);
});

test('the payload does not ship the archived stub array to the browser', () => {
  const payload = queuePayload({
    items: [],
    archivedIndex: [archiveStub(item({ id: 'e', status: 'excluded' }), '2026-07-10T00:00:00.000Z')],
  });
  assert.equal(payload.archivedIndex, undefined);
});

test('a queue with no archived index reports zero filtered', () => {
  const payload = queuePayload({ items: [item({ id: 'a', status: 'ready' })] });
  assert.equal(payload.totals.filtered, 0);
  assert.equal(payload.totals.retained, 1);
});

test('privacy acknowledgements remain in handoff review but stay out of the answer queue', () => {
  const questions = questionPayload([
    item({
      id: 'privacy-review',
      applicationState: 'blocked_by_question',
      applicationResult: {
        needsReview: [
          {
            label: "Legal: I understand the information I submit will be used in accordance with Sentry's Applicant Privacy Policy.",
            reason: 'legal attestation or background question — answer manually',
          },
          {
            label: 'Why do you want to join Sentry?',
            reason: 'required field needs an answer',
          },
        ],
      },
    }),
  ], { entries: [] });

  assert.deepEqual(questions.map((question) => question.question), [
    'Why do you want to join Sentry?',
  ]);
});
