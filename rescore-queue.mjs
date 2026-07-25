#!/usr/bin/env node
// @ts-check
/**
 * rescore-queue.mjs — re-run scoreCandidate over queue items that already have a
 * stored description, without touching the network.
 *
 * Queue items persist their `fitScore`, `status`, and `blockers`, so a change to
 * the scoring rules does NOT reach the items already in `data/job-queue.json`.
 * They keep carrying whatever verdict was current on the day they were ingested.
 * This is the offline companion to `backfill-descriptions.mjs`: that one exists to
 * fetch missing descriptions, this one exists to re-judge descriptions we already
 * have after a rule change.
 *
 * Dispositions the user (or the pipeline) has already made are never reversed —
 * `applied`, `skipped`, `snoozed`, `archived`, and `stale` items get their score
 * and blockers refreshed for transparency but keep their status.
 *
 * Usage:
 *   node rescore-queue.mjs --dry-run     # report the movement, write nothing
 *   node rescore-queue.mjs               # apply, with a timestamped backup
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildQueueItem, loadProfile, readQueueState, writeQueueState } from './queue-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');

/** Statuses that reflect a decision already taken, not a score. */
const STICKY_STATUSES = new Set(['applied', 'skipped', 'snoozed', 'archived', 'stale']);

/**
 * Rescore one item against its stored description, preserving identity and history.
 * @param {Record<string, any>} item
 * @param {Record<string, any>} profile
 * @returns {Record<string, any>}
 */
export function rescoreStoredItem(item, profile) {
  const rebuilt = buildQueueItem({ ...item, url: item.canonicalUrl }, profile, ROOT);
  const sticky = STICKY_STATUSES.has(String(item.status || ''));
  const merged = {
    ...item,
    ...rebuilt,
    id: item.id,
    source: item.source,
    sourceLabel: item.sourceLabel,
    sourceMessageId: item.sourceMessageId,
    sourceUrl: item.sourceUrl,
    canonicalUrl: item.canonicalUrl,
    discoveredAt: item.discoveredAt,
    firstSeenAt: item.firstSeenAt,
    descriptionFetchedAt: item.descriptionFetchedAt,
    selectedForToday: item.selectedForToday,
    queueRank: item.queueRank,
    status: sticky ? item.status : rebuilt.status,
    outreach: { ...(item.outreach || {}), ...rebuilt.outreach, discovery: item.outreach?.discovery },
    updatedAt: new Date().toISOString(),
  };
  if (merged.status === 'excluded' || merged.status === 'stale') {
    merged.selectedForToday = false;
    merged.queueRank = null;
  }
  return merged;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const profile = loadProfile(ROOT);
  const state = readQueueState(QUEUE_PATH);
  const items = Array.isArray(state.items) ? state.items : [];

  const nextItems = [];
  const changes = [];
  let skipped = 0;

  for (const item of items) {
    if (!String(item.description || '').trim()) {
      skipped += 1;
      nextItems.push(item);
      continue;
    }
    const rescored = rescoreStoredItem(item, profile);
    const scoreMoved = Number(rescored.fitScore) !== Number(item.fitScore);
    const statusMoved = rescored.status !== item.status;
    if (scoreMoved || statusMoved) changes.push({ before: item, after: rescored });
    nextItems.push(scoreMoved || statusMoved ? rescored : item);
  }

  console.log(`Rescored ${items.length - skipped} item(s) with stored descriptions (${skipped} skipped for having none).`);
  console.log(`Changed: ${changes.length}`);

  const movement = new Map();
  for (const { before, after } of changes) {
    if (before.status === after.status) continue;
    const key = `${before.status} → ${after.status}`;
    movement.set(key, (movement.get(key) || 0) + 1);
  }
  if (movement.size) {
    console.log('\nStatus movement:');
    for (const [key, count] of [...movement].sort((a, b) => b[1] - a[1])) console.log(`  ${count.toString().padStart(4)}  ${key}`);
  }

  const risers = changes
    .filter(({ before, after }) => Number(after.fitScore) > Number(before.fitScore))
    .sort((a, b) => Number(b.after.fitScore) - Number(a.after.fitScore));
  if (risers.length) {
    console.log('\nTop risers:');
    for (const { before, after } of risers.slice(0, 15)) {
      console.log(`  ${Number(before.fitScore).toFixed(1)} → ${Number(after.fitScore).toFixed(1)}  ${String(after.status).padEnd(9)} ${after.company} | ${after.title}`);
    }
  }

  if (dryRun) {
    console.log('\nDry run — no changes written.');
    return;
  }
  if (!changes.length) {
    console.log('\nNothing to write.');
    return;
  }

  const backup = `${QUEUE_PATH}.bak-${Date.now()}`;
  writeFileSync(backup, readFileSync(QUEUE_PATH, 'utf8'), 'utf8');
  writeQueueState(QUEUE_PATH, { ...state, items: nextItems });
  console.log(`\nWrote ${changes.length} updated item(s). Backup: ${path.relative(ROOT, backup)}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`rescore-queue: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
