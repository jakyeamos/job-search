import test from 'node:test';
import assert from 'node:assert/strict';

import { rescoreStoredItem } from '../rescore-queue.mjs';

/** @param {Record<string, any>} overrides */
function item(overrides) {
  return {
    id: 'stable-id',
    source: 'gmail:linkedin',
    sourceMessageId: 'msg-9',
    canonicalUrl: 'https://boards.example.test/jobs/1',
    company: 'Acme',
    title: 'Backend Engineer',
    location: 'Remote US',
    description: 'Build backend APIs and data pipelines.',
    liveness: 'active',
    status: 'excluded',
    fitScore: 0,
    blockers: ['posting states a 3+ year experience floor'],
    discoveredAt: '2026-07-01T00:00:00.000Z',
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    descriptionFetchedAt: '2026-07-02T00:00:00.000Z',
    outreach: { suggested: false, discovery: { status: 'found', contacts: [{ email: 'a@acme.test' }] } },
    ...overrides,
  };
}

test('a stale blocker is cleared when the rules that produced it change', () => {
  const rescored = rescoreStoredItem(item({}), {});

  assert.equal(rescored.blockers.length, 0);
  assert.equal(rescored.status, 'ready');
  assert.ok(rescored.fitScore > 0);
});

test('rescoring preserves identity, history, and discovered contacts', () => {
  const original = item({});
  const rescored = rescoreStoredItem(original, {});

  assert.equal(rescored.id, 'stable-id', 'id must survive so history is not orphaned');
  assert.equal(rescored.source, 'gmail:linkedin');
  assert.equal(rescored.sourceMessageId, 'msg-9');
  assert.equal(rescored.discoveredAt, '2026-07-01T00:00:00.000Z');
  assert.equal(rescored.firstSeenAt, '2026-07-01T00:00:00.000Z');
  assert.equal(
    rescored.descriptionFetchedAt,
    '2026-07-02T00:00:00.000Z',
    'no fetch happened, so the fetch timestamp must not move',
  );
  assert.deepEqual(rescored.outreach.discovery, original.outreach.discovery);
});

test('a decision already taken is never reversed by a rule change', () => {
  for (const status of ['applied', 'skipped', 'snoozed', 'archived']) {
    const rescored = rescoreStoredItem(item({ status, fitScore: 3.7 }), {});
    assert.equal(rescored.status, status, status);
    assert.ok(rescored.fitScore > 3.7, `${status} still gets a refreshed score`);
  }
});

test('an item that newly fails a blocker drops off the daily slate', () => {
  const rescored = rescoreStoredItem(
    item({
      status: 'ready',
      fitScore: 4.7,
      blockers: [],
      selectedForToday: true,
      queueRank: 2,
      description: 'We need 12+ years of professional backend engineering experience.',
    }),
    {},
  );

  assert.equal(rescored.status, 'excluded');
  assert.equal(rescored.selectedForToday, false);
  assert.equal(rescored.queueRank, null);
});
