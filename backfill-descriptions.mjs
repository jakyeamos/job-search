#!/usr/bin/env node
// @ts-check
/**
 * backfill-descriptions.mjs — fetch job descriptions for queue items that were
 * scored from title/company metadata alone, then rescore them.
 *
 * This is the repair tool for items that were already ingested without a description.
 * New candidates are enriched at ingest time by posting-fetch.mjs, which this shares
 * its fetching with — so this should only ever be needed for the historical backlog
 * or for items whose source was unreachable on the day they arrived.
 *
 * It fetches the real posting for each one and re-runs scoreCandidate against it, so
 * the blocker rules (experience floor, location, defense, language gate) finally see
 * the actual text. Expect items to move in BOTH directions: some rise into `ready`,
 * many drop to `excluded`. Both are correct — a metadata-only score was never
 * evidence of fit.
 *
 * Identity is preserved: stableQueueId() hashes company+title, so correcting a
 * garbage company name would otherwise mint a new id and orphan the item's history.
 * The original id, source, and first-seen timestamps always survive a rescore.
 *
 * Usage:
 *   node backfill-descriptions.mjs --dry-run            # report only, write nothing
 *   node backfill-descriptions.mjs --score 3.7          # only the title-match-only cluster
 *   node backfill-descriptions.mjs --limit 25           # cap the number fetched
 *   node backfill-descriptions.mjs --concurrency 2      # parallel fetches (default 2)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildQueueItem, loadProfile, readQueueState, writeQueueState } from './queue-lib.mjs';
import { fetchPosting, pool } from './posting-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');

/**
 * Merge fetched fields into an item and rescore, preserving identity and history.
 * @param {Record<string, any>} item
 * @param {Record<string, string>} fields
 * @param {string} liveness
 * @param {Record<string, any>} profile
 */
export function rescoreItem(item, fields, liveness, profile) {
  const candidate = {
    ...item,
    // Alert-derived company/title are frequently email-subject garbage; prefer the
    // posting's own values whenever the fetch supplied one.
    title: fields.title || item.title,
    company: fields.company || item.company,
    location: fields.location || item.location,
    description: fields.description,
    liveness,
    url: item.canonicalUrl,
  };
  const rebuilt = buildQueueItem(candidate, profile, ROOT);
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
    selectedForToday: item.selectedForToday,
    queueRank: item.queueRank,
    // buildQueueItem mints a fresh outreach block; keep any discovered contacts
    // and only take the recomputed `suggested` flag.
    outreach: { ...(item.outreach || {}), ...rebuilt.outreach, discovery: item.outreach?.discovery },
    descriptionFetchedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (merged.status === 'excluded' || merged.status === 'stale') {
    merged.selectedForToday = false;
    merged.queueRank = null;
  }
  return merged;
}

function parseArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at === -1 ? fallback : Number(argv[at + 1]);
  };
  const hostAt = argv.indexOf('--host');
  return {
    dryRun: has('--dry-run'),
    host: hostAt === -1 ? null : String(argv[hostAt + 1] || ''),
    score: argv.includes('--score') ? value('--score', NaN) : null,
    limit: value('--limit', Number.MAX_SAFE_INTEGER),
    concurrency: value('--concurrency', 2),
    gapMs: value('--gap-ms', 600),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = loadProfile(ROOT);
  const state = readQueueState(QUEUE_PATH);
  const items = Array.isArray(state.items) ? state.items : [];
  const byId = new Map(items.map((item) => [item.id, item]));

  const targets = items.filter((item) => item.status === 'in_review'
    && !String(item.description || '').trim()
    && (options.score === null || Number(item.fitScore) === options.score)
    && (!options.host || String(item.canonicalUrl || '').includes(options.host)))
    .slice(0, options.limit);

  if (!targets.length) {
    console.log('Nothing to backfill: no description-less in_review items matched.');
    return;
  }

  const before = targets.map((item) => ({ id: item.id, score: item.fitScore, status: item.status }));
  console.log(`Backfilling ${targets.length} item(s)${options.dryRun ? ' (dry run)' : ''} at concurrency ${options.concurrency}...`);

  const outcomes = { updated: 0, expired: 0, unsupported: 0, blocked: 0, empty: 0, error: 0 };
  const updates = [];
  let done = 0;

  await pool(targets, options.concurrency, options.gapMs, async (item) => {
    const result = await fetchPosting(item.canonicalUrl || item.applyUrl || item.sourceUrl || '');
    done += 1;
    if (done % 25 === 0) console.log(`  ...${done}/${targets.length}`);

    if (!result.ok) {
      outcomes[result.outcome] += 1;
      if (result.outcome === 'expired') {
        updates.push({ ...item, status: 'stale', liveness: 'expired', actionNote: result.reason, updatedAt: new Date().toISOString() });
      }
      return;
    }
    outcomes.updated += 1;
    updates.push(rescoreItem(item, result.fields, result.liveness, profile));
  });

  for (const update of updates) byId.set(update.id, update);
  const nextItems = items.map((item) => byId.get(item.id) || item);

  console.log('\nFetch outcomes:');
  for (const [key, count] of Object.entries(outcomes)) if (count) console.log(`  ${key}: ${count}`);

  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const moved = { toReady: 0, toExcluded: 0, stayedInReview: 0, toStale: 0 };
  const risers = [];
  for (const update of updates) {
    const prior = beforeById.get(update.id);
    if (!prior) continue;
    if (update.status === 'ready') moved.toReady += 1;
    else if (update.status === 'excluded') moved.toExcluded += 1;
    else if (update.status === 'stale') moved.toStale += 1;
    else moved.stayedInReview += 1;
    if (Number(update.fitScore) > Number(prior.score)) {
      risers.push({ delta: Number(update.fitScore) - Number(prior.score), item: update, prior });
    }
  }

  console.log('\nStatus movement:');
  console.log(`  → ready:      ${moved.toReady}`);
  console.log(`  → in_review:  ${moved.stayedInReview}`);
  console.log(`  → excluded:   ${moved.toExcluded}`);
  console.log(`  → stale:      ${moved.toStale}`);

  risers.sort((a, b) => Number(b.item.fitScore) - Number(a.item.fitScore));
  if (risers.length) {
    console.log('\nTop risers:');
    for (const { item, prior } of risers.slice(0, 15)) {
      console.log(`  ${prior.score} → ${item.fitScore}  ${item.status.padEnd(9)} ${item.company} | ${item.title}`);
    }
  }

  const excludedReasons = {};
  for (const update of updates) {
    if (update.status !== 'excluded') continue;
    for (const blocker of update.blockers || []) excludedReasons[blocker] = (excludedReasons[blocker] || 0) + 1;
  }
  if (Object.keys(excludedReasons).length) {
    console.log('\nNewly visible blockers:');
    for (const [reason, count] of Object.entries(excludedReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}  ${reason}`);
    }
  }

  if (options.dryRun) {
    console.log('\nDry run — no changes written.');
    return;
  }

  const backup = `${QUEUE_PATH}.bak-${Date.now()}`;
  writeFileSync(backup, readFileSync(QUEUE_PATH, 'utf8'), 'utf8');
  writeQueueState(QUEUE_PATH, { ...state, items: nextItems });
  console.log(`\nWrote ${updates.length} updated item(s). Backup: ${path.relative(ROOT, backup)}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`backfill-descriptions: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
