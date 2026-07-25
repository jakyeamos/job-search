import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLY_THRESHOLD, DEFAULT_QUEUE_LIMIT, selectDailyQueue } from '../queue-lib.mjs';

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
