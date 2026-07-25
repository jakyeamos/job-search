import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
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
