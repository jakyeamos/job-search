// @ts-check

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

export const ARCHIVE_SCHEMA_VERSION = 1;

/**
 * Statuses evicted from the live queue on the next write. `skipped` and
 * `applied` are never evicted: that record is the only thing standing between
 * the user and a job they already rejected walking back into the daily
 * selection. `stale` stays live as the 45-to-60-day waiting room.
 */
export const EVICTABLE_STATUSES = Object.freeze(['excluded', 'archived']);

const EVICTABLE = new Set(EVICTABLE_STATUSES);

/** @param {Record<string, unknown>} item @param {string} [now] */
export function archiveStub(item, now = new Date().toISOString()) {
  return {
    id: item.id,
    company: item.company || '',
    title: item.title || '',
    url: item.applyUrl || item.canonicalUrl || null,
    status: item.status,
    fitScore: typeof item.fitScore === 'number' ? item.fitScore : null,
    blockers: Array.isArray(item.blockers) ? item.blockers : [],
    lane: item.lane || null,
    firstSeenAt: item.firstSeenAt || null,
    lastSeenAt: item.lastSeenAt || null,
    archivedAt: item.archivedAt || now,
  };
}

/** @param {Array<Record<string, unknown>>} entries */
function byId(entries) {
  return new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
}

/**
 * Splits evictable rows out of the live state into the archive sidecar,
 * leaving a stub behind in `archivedIndex`. Read-modify-write on the archive,
 * keyed by id, so a record evicted twice does not duplicate.
 *
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} [archive]
 * @param {{ now?: string }} [options]
 */
export function evictToArchive(state, archive = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const items = Array.isArray(state.items) ? state.items : [];
  const live = [];
  const stubs = [];
  const evicted = [];
  for (const item of items) {
    if (!item?.id || !EVICTABLE.has(String(item.status || ''))) { live.push(item); continue; }
    stubs.push(archiveStub(item, now));
    evicted.push(item);
  }

  const index = byId(Array.isArray(state.archivedIndex) ? state.archivedIndex : []);
  for (const stub of stubs) index.set(stub.id, stub);
  const nextIndex = [...index.values()];

  const records = byId(Array.isArray(archive.records) ? archive.records : []);
  for (const record of evicted) records.set(record.id, record);

  return {
    state: { ...state, items: live, archivedIndex: nextIndex },
    archive: {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      updatedAt: now,
      records: [...records.values()],
    },
    evicted: stubs.length,
    index: nextIndex,
  };
}

/**
 * Strict read. Unlike `readQueueState`, an unparseable archive throws — the
 * caller must abort rather than evict live records into a void.
 *
 * @param {string} file
 */
export function readArchive(file) {
  if (!existsSync(file)) return { schemaVersion: ARCHIVE_SCHEMA_VERSION, updatedAt: null, records: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`archive at ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
    throw new Error(`archive at ${file} is not a valid archive document`);
  }
  return {
    schemaVersion: parsed.schemaVersion ?? ARCHIVE_SCHEMA_VERSION,
    updatedAt: parsed.updatedAt || null,
    records: parsed.records,
  };
}

/** @param {string} file @param {Record<string, unknown>} archive */
export function writeArchive(file, archive) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}
