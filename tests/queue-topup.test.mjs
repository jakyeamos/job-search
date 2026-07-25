import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLY_THRESHOLD, DEFAULT_QUEUE_LIMIT, selectDailyQueue, topUpSelection } from '../queue-lib.mjs';

/** @param {Record<string, unknown>} overrides */
function item(overrides) {
  return {
    id: 'x',
    company: 'Acme',
    title: 'Backend Engineer',
    status: 'ready',
    source: 'greenhouse',
    fitScore: 4.5,
    freshness: 'fresh',
    ...overrides,
  };
}

test('constants are the documented defaults', () => {
  assert.equal(APPLY_THRESHOLD, 4.0);
  assert.equal(DEFAULT_QUEUE_LIMIT, 10);
});

test('items below the fit-score floor are never selected', () => {
  const pool = [
    item({ id: 'high', fitScore: 4.4 }),
    item({ id: 'low', company: 'Globex', title: 'Data Engineer', fitScore: 3.9 }),
  ];
  const selected = selectDailyQueue(pool, { limit: 10 });
  assert.deepEqual(selected.map((entry) => entry.id), ['high']);
});

test('the floor is configurable and lets sub-threshold items through when lowered', () => {
  const pool = [item({ id: 'low', fitScore: 3.7 })];
  assert.equal(selectDailyQueue(pool, { limit: 10 }).length, 0);
  assert.equal(selectDailyQueue(pool, { limit: 10, minFitScore: 3.5 }).length, 1);
});

test('ineligible statuses are excluded regardless of score', () => {
  const pool = [
    item({ id: 'applied', status: 'applied', fitScore: 5 }),
    item({ id: 'skipped', company: 'Globex', title: 'Data Engineer', status: 'skipped', fitScore: 5 }),
    item({ id: 'excluded', company: 'Initech', title: 'Site Reliability Engineer', status: 'excluded', fitScore: 5 }),
    item({ id: 'ok', company: 'Umbrella', title: 'Platform Engineer', fitScore: 4.1 }),
  ];
  assert.deepEqual(selectDailyQueue(pool, { limit: 10 }).map((entry) => entry.id), ['ok']);
});

test('pinned incumbents lead the selection and bypass the floor', () => {
  const incumbent = item({ id: 'pinned-low', fitScore: 3.2 });
  const pool = [incumbent, item({ id: 'fresh', company: 'Globex', title: 'Data Engineer', fitScore: 4.6 })];
  const selected = selectDailyQueue(pool, { limit: 10, pinned: [incumbent] });
  assert.deepEqual(selected.map((entry) => entry.id), ['pinned-low', 'fresh']);
});

test('the per-company cap holds across the pin boundary', () => {
  const incumbent = item({ id: 'acme-1', fitScore: 4.1 });
  const pool = [incumbent, item({ id: 'acme-2', title: 'Platform Engineer', fitScore: 4.9 })];
  const selected = selectDailyQueue(pool, { limit: 10, pinned: [incumbent] });
  assert.deepEqual(selected.map((entry) => entry.id), ['acme-1']);
});

/** @param {number} count @param {Record<string, unknown>} overrides */
function pool(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => item({
    id: `pool-${index}`,
    company: `Company ${index}`,
    title: `Backend Engineer ${index}`,
    fitScore: 4.5,
    ...overrides,
  }));
}

test('a full selection is left alone', () => {
  const items = pool(12).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 10,
    queueRank: index < 10 ? index + 1 : null,
  }));
  const result = topUpSelection({ items });
  assert.equal(result.added, 0);
  assert.equal(result.shortBy, 0);
  assert.deepEqual(
    result.state.items.filter((entry) => entry.selectedForToday).map((entry) => entry.id),
    items.slice(0, 10).map((entry) => entry.id),
  );
});

test('a drained selection is topped back up to ten', () => {
  const items = pool(30).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 5,
    queueRank: index < 5 ? index + 1 : null,
  }));
  const result = topUpSelection({ items });
  assert.equal(result.added, 5);
  assert.equal(result.shortBy, 0);
  assert.equal(result.state.items.filter((entry) => entry.selectedForToday).length, 10);
});

test('incumbents keep their slots and their relative order', () => {
  const items = pool(30).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 3,
    queueRank: index < 3 ? 3 - index : null,
  }));
  const result = topUpSelection({ items });
  const ranked = result.state.items
    .filter((entry) => entry.selectedForToday)
    .sort((left, right) => left.queueRank - right.queueRank);
  assert.deepEqual(ranked.slice(0, 3).map((entry) => entry.id), ['pool-2', 'pool-1', 'pool-0']);
});

test('queue ranks come out contiguous from one', () => {
  const items = pool(30).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 4,
    queueRank: index < 4 ? (index + 1) * 7 : null,
  }));
  const result = topUpSelection({ items });
  const ranks = result.state.items
    .filter((entry) => entry.selectedForToday)
    .map((entry) => entry.queueRank)
    .sort((left, right) => left - right);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(result.state.items.every((entry) => entry.selectedForToday || entry.queueRank === null));
});

test('the per-company cap survives the top-up', () => {
  const items = [
    { ...item({ id: 'acme-1', fitScore: 4.1 }), selectedForToday: true, queueRank: 1 },
    item({ id: 'acme-2', title: 'Platform Engineer', fitScore: 4.9 }),
    item({ id: 'globex', company: 'Globex', title: 'Data Engineer', fitScore: 4.2 }),
  ];
  const result = topUpSelection({ items });
  assert.deepEqual(
    result.state.items.filter((entry) => entry.selectedForToday).map((entry) => entry.id),
    ['acme-1', 'globex'],
  );
});

test('an exhausted pool reports shortBy instead of throwing', () => {
  const result = topUpSelection({ items: [] });
  assert.equal(result.added, 0);
  assert.equal(result.shortBy, 10);
  assert.deepEqual(result.state.items, []);
});

test('sub-threshold items are not used to pad a short queue', () => {
  const items = pool(30, { fitScore: 3.9 });
  const result = topUpSelection({ items });
  assert.equal(result.added, 0);
  assert.equal(result.shortBy, 10);
});

test('the input state is not mutated', () => {
  const items = pool(20).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 2,
    queueRank: index < 2 ? index + 1 : null,
  }));
  const state = { items, generatedAt: '2026-07-25T00:00:00.000Z' };
  const result = topUpSelection(state);
  assert.equal(state.items.filter((entry) => entry.selectedForToday).length, 2);
  assert.equal(result.state.generatedAt, '2026-07-25T00:00:00.000Z');
});
