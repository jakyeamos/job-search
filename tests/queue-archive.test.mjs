import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  ARCHIVE_SCHEMA_VERSION,
  EVICTABLE_STATUSES,
  archiveStub,
  evictToArchive,
  readArchive,
  writeArchive,
} from '../queue-archive.mjs';
import { collectQueueErrors, rehydrateQueue, saveQueue } from '../queue.mjs';
import { buildQueue, writeQueueState } from '../queue-lib.mjs';

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
    blockers: [],
    lane: 'backend',
    description: 'a long job description',
    firstSeenAt: '2026-07-04T00:00:00.000Z',
    lastSeenAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'queue-archive-'));
}

test('the evictable set is exactly excluded and archived', () => {
  assert.deepEqual([...EVICTABLE_STATUSES].sort(), ['archived', 'excluded']);
});

test('a stub carries the documented keys and nothing else', () => {
  const stub = archiveStub(item({ status: 'excluded' }), '2026-07-25T00:00:00.000Z');
  assert.deepEqual(Object.keys(stub).sort(), [
    'archivedAt', 'blockers', 'company', 'firstSeenAt', 'fitScore',
    'id', 'lane', 'lastSeenAt', 'status', 'title', 'url',
  ]);
  assert.equal(stub.url, 'https://example.com/jobs/1');
  assert.equal(stub.archivedAt, '2026-07-25T00:00:00.000Z');
});

test('a stub keeps an existing archivedAt rather than restamping it', () => {
  const stub = archiveStub(item({ status: 'archived', archivedAt: '2026-07-10T00:00:00.000Z' }), '2026-07-25T00:00:00.000Z');
  assert.equal(stub.archivedAt, '2026-07-10T00:00:00.000Z');
});

test('excluded and archived rows are evicted, everything else stays live', () => {
  const state = {
    items: [
      item({ id: 'ready', status: 'ready' }),
      item({ id: 'in_review', status: 'in_review' }),
      item({ id: 'snoozed', status: 'snoozed' }),
      item({ id: 'stale', status: 'stale' }),
      item({ id: 'skipped', status: 'skipped' }),
      item({ id: 'applied', status: 'applied' }),
      item({ id: 'excluded', status: 'excluded' }),
      item({ id: 'archived', status: 'archived' }),
    ],
  };
  const result = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.equal(result.evicted, 2);
  assert.deepEqual(
    result.state.items.map((entry) => entry.id),
    ['ready', 'in_review', 'snoozed', 'stale', 'skipped', 'applied'],
  );
  assert.deepEqual(result.index.map((stub) => stub.id).sort(), ['archived', 'excluded']);
});

test('the archive keeps the full record, description included', () => {
  const state = { items: [item({ id: 'excluded', status: 'excluded' })] };
  const result = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.equal(result.archive.records.length, 1);
  assert.equal(result.archive.records[0].description, 'a long job description');
  assert.equal(result.archive.schemaVersion, ARCHIVE_SCHEMA_VERSION);
});

test('evicting the same record twice does not duplicate it', () => {
  const state = { items: [item({ id: 'excluded', status: 'excluded' })] };
  const first = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  const second = evictToArchive(state, first.archive, { now: '2026-07-26T00:00:00.000Z' });
  assert.equal(second.archive.records.length, 1);
  assert.equal(second.index.length, 1);
});

test('an existing archivedIndex survives an eviction that adds to it', () => {
  const state = {
    archivedIndex: [archiveStub(item({ id: 'old', status: 'excluded' }), '2026-07-01T00:00:00.000Z')],
    items: [item({ id: 'new', status: 'excluded' })],
  };
  const result = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.deepEqual(result.index.map((stub) => stub.id).sort(), ['new', 'old']);
});

test('the input state is not mutated', () => {
  const state = { items: [item({ id: 'excluded', status: 'excluded' })] };
  evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.equal(state.items.length, 1);
  assert.equal(state.archivedIndex, undefined);
});

test('a missing archive file reads as empty', () => {
  const dir = tempDir();
  const archive = readArchive(path.join(dir, 'job-queue-archive.json'));
  assert.deepEqual(archive.records, []);
  assert.equal(archive.schemaVersion, ARCHIVE_SCHEMA_VERSION);
});

test('an unparseable archive throws instead of reading as empty', () => {
  const dir = tempDir();
  const file = path.join(dir, 'job-queue-archive.json');
  writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => readArchive(file), /unreadable/);
});

test('an archive without a records array throws', () => {
  const dir = tempDir();
  const file = path.join(dir, 'job-queue-archive.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1 }), 'utf8');
  assert.throws(() => readArchive(file), /not a valid archive/);
});

test('an archive round-trips through write and read', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'job-queue-archive.json');
  writeArchive(file, { schemaVersion: 1, updatedAt: '2026-07-25T00:00:00.000Z', records: [item({ id: 'excluded', status: 'excluded' })] });
  const archive = readArchive(file);
  assert.equal(archive.records.length, 1);
  assert.equal(archive.records[0].id, 'excluded');
  assert.equal(archive.updatedAt, '2026-07-25T00:00:00.000Z');
});

/** @param {Record<string, unknown>} overrides */
function candidate(overrides) {
  return {
    id: 'c1',
    company: 'Acme',
    title: 'Backend Engineer',
    applyUrl: 'https://example.com/jobs/1',
    canonicalUrl: 'https://example.com/jobs/1',
    status: 'ready',
    source: 'greenhouse',
    fitScore: 4.5,
    freshness: 'fresh',
    ...overrides,
  };
}

test('buildQueue carries the archived index through a refresh', () => {
  const index = [archiveStub(item({ id: 'gone', status: 'excluded' }), '2026-07-01T00:00:00.000Z')];
  const result = buildQueue([candidate({})], { items: [], archivedIndex: index }, { now: '2026-07-25T00:00:00.000Z' });
  assert.deepEqual(result.archivedIndex.map((stub) => stub.id), ['gone']);
});

test('buildQueue returns an empty index when there was none', () => {
  const result = buildQueue([candidate({})], {}, { now: '2026-07-25T00:00:00.000Z' });
  assert.deepEqual(result.archivedIndex, []);
});

test('an archived id that is not observed now is dropped from the merge', () => {
  const index = [archiveStub(item({ id: 'c1', status: 'excluded' }), '2026-07-01T00:00:00.000Z')];
  const result = buildQueue(
    [candidate({ id: 'c1', observedAt: null, lastSeenAt: null, liveness: 'uncertain' })],
    { items: [], archivedIndex: index },
    { now: '2026-07-25T00:00:00.000Z' },
  );
  assert.deepEqual(result.items.map((entry) => entry.id), []);
  assert.deepEqual(result.archivedIndex.map((stub) => stub.id), ['c1']);
});

test('an archived id observed again reactivates with its original firstSeenAt', () => {
  const index = [archiveStub(
    item({ id: 'c1', status: 'excluded', firstSeenAt: '2026-07-04T00:00:00.000Z' }),
    '2026-07-10T00:00:00.000Z',
  )];
  const result = buildQueue(
    [candidate({ id: 'c1', observedAt: '2026-07-25T00:00:00.000Z' })],
    { items: [], archivedIndex: index },
    { now: '2026-07-25T00:00:00.000Z' },
  );
  assert.deepEqual(result.items.map((entry) => entry.id), ['c1']);
  assert.equal(result.items[0].firstSeenAt, '2026-07-04T00:00:00.000Z');
  assert.equal(result.items[0].reactivatedAt, '2026-07-25T00:00:00.000Z');
  assert.deepEqual(result.archivedIndex, []);
});

test('a reactivated row keeps the freshly scored status, not the archived one', () => {
  const index = [archiveStub(item({ id: 'c1', status: 'excluded' }), '2026-07-10T00:00:00.000Z')];
  const result = buildQueue(
    [candidate({ id: 'c1', status: 'ready', observedAt: '2026-07-25T00:00:00.000Z' })],
    { items: [], archivedIndex: index },
    { now: '2026-07-25T00:00:00.000Z' },
  );
  assert.equal(result.items[0].status, 'ready');
});

test('unseen retention still works for rows that are not archived', () => {
  const previous = { items: [{ ...item({ id: 'kept', status: 'in_review' }), selectedForToday: false }], archivedIndex: [] };
  const result = buildQueue([candidate({ id: 'c1' })], previous, { now: '2026-07-25T00:00:00.000Z', retainUnseen: true });
  assert.deepEqual(result.items.map((entry) => entry.id).sort(), ['c1', 'kept']);
});

/** @returns {string} */
function tempRoot() {
  const root = tempDir();
  mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
}

test('saveQueue evicts dead rows into the sidecar and leaves stubs behind', () => {
  const root = tempRoot();
  const state = {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'live', status: 'ready' }), item({ id: 'dead', status: 'excluded' })],
  };
  const saved = saveQueue(root, state);
  assert.deepEqual(saved.items.map((entry) => entry.id), ['live']);
  assert.deepEqual(saved.archivedIndex.map((stub) => stub.id), ['dead']);

  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items.map((entry) => entry.id), ['live']);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['dead']);

  const archive = readArchive(path.join(root, 'data', 'job-queue-archive.json'));
  assert.equal(archive.records.length, 1);
  assert.equal(archive.records[0].description, 'a long job description');
});

test('saveQueue creates the archive on first eviction in a fresh tree', () => {
  const root = tempRoot();
  saveQueue(root, { schemaVersion: 1, account: { gmail: 'jakyejobs@gmail.com' }, items: [item({ id: 'dead', status: 'excluded' })] });
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 1);
});

test('saveQueue aborts and writes nothing when the archive is unparseable', () => {
  const root = tempRoot();
  const queueFile = path.join(root, 'data', 'job-queue.json');
  writeFileSync(queueFile, JSON.stringify({ schemaVersion: 1, items: [] }), 'utf8');
  writeFileSync(path.join(root, 'data', 'job-queue-archive.json'), '{ not json', 'utf8');
  assert.throws(
    () => saveQueue(root, { schemaVersion: 1, account: { gmail: 'jakyejobs@gmail.com' }, items: [item({ id: 'dead', status: 'excluded' })] }),
    /unreadable/,
  );
  assert.deepEqual(JSON.parse(readFileSync(queueFile, 'utf8')).items, []);
});

test('saveQueue leaves skipped and applied rows live', () => {
  const root = tempRoot();
  const saved = saveQueue(root, {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'skipped', status: 'skipped' }), item({ id: 'applied', status: 'applied' }), item({ id: 'stale', status: 'stale' })],
  });
  assert.deepEqual(saved.items.map((entry) => entry.id), ['skipped', 'applied', 'stale']);
  assert.deepEqual(saved.archivedIndex, []);
});

/** @param {string} root @param {Record<string, unknown>} record */
function seedArchive(root, record) {
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [],
    archivedIndex: [archiveStub(record, '2026-07-10T00:00:00.000Z')],
  });
  writeArchive(path.join(root, 'data', 'job-queue-archive.json'), {
    schemaVersion: 1,
    updatedAt: '2026-07-10T00:00:00.000Z',
    records: [record],
  });
}

test('rehydrate returns a matching record and rescored it live when it now passes', () => {
  const root = tempRoot();
  seedArchive(root, item({
    id: 'exp',
    status: 'excluded',
    description: 'Backend engineer building APIs. Remote, United States.',
    location: 'Remote, United States',
    liveness: 'active',
    blockers: ['posting states a 3+ year experience floor'],
  }));
  rehydrateQueue(root, 'experience-floor', false);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items.map((entry) => entry.id), ['exp']);
  assert.deepEqual(live.archivedIndex, []);
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 0);
});

test('a record that still fails its blocker is evicted again by the same run', () => {
  const root = tempRoot();
  seedArchive(root, item({
    id: 'exp',
    status: 'excluded',
    description: 'We require 7+ years of experience.',
    blockers: ['posting states a 3+ year experience floor'],
  }));
  rehydrateQueue(root, 'experience-floor', false);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items, []);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['exp']);
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 1);
});

test('a non-matching blocker filter rehydrates nothing', () => {
  const root = tempRoot();
  seedArchive(root, item({ id: 'exp', status: 'excluded', blockers: ['posting states a 3+ year experience floor'] }));
  rehydrateQueue(root, 'defense-contractor', false);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items, []);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['exp']);
});

test('a dry run changes neither file', () => {
  const root = tempRoot();
  seedArchive(root, item({
    id: 'exp',
    status: 'excluded',
    description: 'Backend engineer building APIs. Remote, United States.',
    location: 'Remote, United States',
    liveness: 'active',
    blockers: ['posting states a 3+ year experience floor'],
  }));
  rehydrateQueue(root, 'experience-floor', true);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items, []);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['exp']);
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 1);
});

test('a clean queue and archive report no errors', () => {
  const root = tempRoot();
  saveQueue(root, {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'live', status: 'ready' }), item({ id: 'dead', status: 'excluded' })],
  });
  assert.deepEqual(collectQueueErrors(root), []);
});

test('a stub that is also a live item is an error', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'dup', status: 'ready' })],
    archivedIndex: [archiveStub(item({ id: 'dup', status: 'excluded' }), '2026-07-10T00:00:00.000Z')],
  });
  writeArchive(path.join(root, 'data', 'job-queue-archive.json'), {
    schemaVersion: 1,
    updatedAt: null,
    records: [item({ id: 'dup', status: 'excluded' })],
  });
  assert.ok(collectQueueErrors(root).some((error) => /also a live queue item/.test(error)));
});

test('a stub with no record in the sidecar is an error', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [],
    archivedIndex: [archiveStub(item({ id: 'orphan', status: 'excluded' }), '2026-07-10T00:00:00.000Z')],
  });
  writeArchive(path.join(root, 'data', 'job-queue-archive.json'), {
    schemaVersion: 1,
    updatedAt: null,
    records: [],
  });
  assert.ok(collectQueueErrors(root).some((error) => /no record in the archive/.test(error)));
});

test('an evicted status left live is an error', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'stuck', status: 'excluded' })],
    archivedIndex: [],
  });
  assert.ok(collectQueueErrors(root).some((error) => /still live/.test(error)));
});

test('an unparseable archive is reported as an error rather than throwing', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [],
    archivedIndex: [],
  });
  writeFileSync(path.join(root, 'data', 'job-queue-archive.json'), '{ not json', 'utf8');
  assert.ok(collectQueueErrors(root).some((error) => /unreadable/.test(error)));
});
