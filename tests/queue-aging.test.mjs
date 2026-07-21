import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPostingAging, postingAgeReference, postingFreshness } from '../queue-aging.mjs';
import { buildQueue, stableQueueId } from '../queue-lib.mjs';

const NOW = '2026-07-21T00:00:00.000Z';

function item(overrides = {}) {
  return {
    id: overrides.id || 'role-1',
    status: 'in_review',
    company: 'Example AI',
    title: 'Backend Engineer',
    firstSeenAt: '2026-06-01T00:00:00.000Z',
    selectedForToday: true,
    queueRank: 1,
    ...overrides,
  };
}

test('posting freshness moves from fresh to aging, recheck, stale, and archivable', () => {
  assert.equal(postingFreshness(item({ firstSeenAt: '2026-07-15T00:00:00.000Z' }), NOW).state, 'fresh');
  assert.equal(postingFreshness(item({ firstSeenAt: '2026-07-01T00:00:00.000Z' }), NOW).state, 'aging');
  assert.equal(postingFreshness(item({ firstSeenAt: '2026-06-15T00:00:00.000Z' }), NOW).state, 'recheck_due');
  assert.equal(postingFreshness(item({ firstSeenAt: '2026-06-01T00:00:00.000Z' }), NOW).state, 'stale');
  assert.equal(postingFreshness(item({ firstSeenAt: '2026-05-20T00:00:00.000Z' }), NOW).state, 'archivable');
});

test('freshness uses the newest observation or positive verification', () => {
  const reference = postingAgeReference(item({
    lastSeenAt: '2026-05-01T00:00:00.000Z',
    lastConfirmedActiveAt: '2026-07-20T00:00:00.000Z',
  }));
  assert.equal(reference, '2026-07-20T00:00:00.000Z');
  assert.equal(postingFreshness(item({
    lastSeenAt: '2026-05-01T00:00:00.000Z',
    lastConfirmedActiveAt: '2026-07-20T00:00:00.000Z',
  }), NOW).state, 'fresh');
});

test('healthy refresh marks old verified roles stale and preserves history', () => {
  const state = { items: [item({ firstSeenAt: '2026-06-01T00:00:00.000Z' }), item({ id: 'applied', status: 'applied', firstSeenAt: '2026-01-01T00:00:00.000Z' })] };
  const summary = applyPostingAging(state, { now: NOW, sourceScanHealthy: true });
  assert.equal(summary.stale, 1);
  assert.equal(state.items[0].status, 'stale');
  assert.equal(state.items[0].selectedForToday, false);
  assert.equal(state.items[1].status, 'applied');
});

test('source failures suspend age-out transitions', () => {
  const state = { items: [item({ firstSeenAt: '2026-06-01T00:00:00.000Z' })] };
  const summary = applyPostingAging(state, { now: NOW, sourceScanHealthy: false });
  assert.equal(summary.suspended, 1);
  assert.equal(state.items[0].status, 'in_review');
  assert.equal(state.items[0].selectedForToday, true);
  assert.equal(state.items[0].freshness, undefined);
});

test('alert-only roles leave the active selection before archiving without claiming closure', () => {
  const state = { items: [item({ liveness: 'source-alert', firstSeenAt: '2026-06-01T00:00:00.000Z' })] };
  applyPostingAging(state, { now: NOW, sourceScanHealthy: true });
  assert.equal(state.items[0].status, 'in_review');
  assert.equal(state.items[0].freshness, 'stale');
  assert.equal(state.items[0].selectedForToday, false);

  const archived = { items: [item({ liveness: 'source-alert', status: 'stale', firstSeenAt: '2026-05-20T00:00:00.000Z' })] };
  applyPostingAging(archived, { now: NOW, sourceScanHealthy: true });
  assert.equal(archived.items[0].status, 'archived');
  assert.match(archived.items[0].archivedReason, /not observed|positively verified/);
});

test('an observed reappearance reactivates an aged role instead of duplicating it', () => {
  const id = stableQueueId({ url: 'https://jobs.example.com/role-1', company: 'Example AI', title: 'Backend Engineer' });
  const state = buildQueue([{
    id,
    source: 'greenhouse',
    title: 'Backend Engineer',
    company: 'Example AI',
    location: 'Remote US',
    canonicalUrl: 'https://jobs.example.com/role-1',
    applyUrl: 'https://jobs.example.com/role-1',
    liveness: 'active',
    observedAt: NOW,
    fitScore: 4.2,
    fitConfidence: 'high',
    fitReasons: ['test'],
    blockers: [],
    lane: 'backend_ai_platform',
    status: 'ready',
  }], {
    items: [{
      id,
      status: 'archived',
      company: 'Example AI',
      title: 'Backend Engineer',
      firstSeenAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-01T00:00:00.000Z',
      staleAt: '2026-06-15T00:00:00.000Z',
      archivedAt: '2026-07-01T00:00:00.000Z',
      freshness: 'archived',
    }],
  }, { limit: 1, now: NOW, retainUnseen: true });
  const reactivated = state.items.find((candidate) => candidate.id === id);
  assert.equal(reactivated.status, 'ready');
  assert.equal(reactivated.lastSeenAt, NOW);
  assert.equal(reactivated.archivedAt, undefined);
  assert.equal(reactivated.selectedForToday, true);
});

test('unseen roles remain recoverable until the age policy moves them out', () => {
  const id = stableQueueId({ url: 'https://jobs.example.com/role-2', company: 'Example AI', title: 'Data Engineer' });
  const state = buildQueue([], {
    items: [{
      id,
      status: 'in_review',
      company: 'Example AI',
      title: 'Data Engineer',
      firstSeenAt: '2026-07-10T00:00:00.000Z',
      selectedForToday: true,
      queueRank: 1,
    }],
  }, { limit: 1, now: NOW, retainUnseen: true });
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].id, id);
});
