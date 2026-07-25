#!/usr/bin/env node
// @ts-check
/**
 * backfill-descriptions.mjs — fetch job descriptions for queue items that were
 * scored from title/company metadata alone, then rescore them.
 *
 * Email-alert ingestion (gmail:linkedin in particular) stores a title, a URL, and
 * whatever the alert subject line happened to contain — no description. Those items
 * all collapse onto the same title-match-only fit score, which makes them
 * indistinguishable from each other and invisible to the daily selection.
 *
 * This fetches the real posting for each one and re-runs scoreCandidate against it,
 * so the blocker rules (experience floor, location, defense, language gate) finally
 * see the actual text. Expect items to move in BOTH directions: some rise into
 * `ready`, many drop to `excluded`. Both are correct — a metadata-only score was
 * never evidence of fit.
 *
 * Sources:
 *   - LinkedIn  → the public unauthenticated guest posting endpoint. No login, no
 *                 session, no paywall. The `/comm/` tracking prefix on alert URLs is
 *                 rewritten to the canonical job id first.
 *   - Greenhouse / Lever / Ashby → the same public ATS JSON APIs used by
 *                 liveness-api.mjs, via resolveAtsApi().
 *   - Anything else → reported as unsupported and left untouched.
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
import { resolveAtsApi } from './liveness-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const MIN_DESCRIPTION_CHARS = 200;

/** Collapse HTML into readable plain text. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&rdquo;|&ldquo;/g, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    // Dropped block tags leave leading padding on each line (" - Python" from "<ul><li>").
    .split('\n').map((line) => line.trim()).join('\n')
    .trim();
}

/**
 * Pull the numeric posting id out of any LinkedIn job URL shape, including the
 * `/comm/` tracking variant that email alerts use.
 * @param {string} url
 * @returns {string | null}
 */
export function linkedinJobId(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (!/(^|\.)linkedin\.com$/.test(parsed.hostname)) return null;
  const fromPath = parsed.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/);
  if (fromPath) return fromPath[1];
  const fromQuery = parsed.searchParams.get('currentJobId');
  return fromQuery && /^\d{6,}$/.test(fromQuery) ? fromQuery : null;
}

/** Parse the guest posting page into candidate fields. */
export function parseLinkedinPosting(html) {
  const pick = (re) => { const m = String(html).match(re); return m ? htmlToText(m[1]) : ''; };
  const description = pick(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const criteria = [...String(html).matchAll(
    /description__job-criteria-subheader[^>]*>([\s\S]*?)<[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)</g,
  )].map((m) => `${htmlToText(m[1])}: ${htmlToText(m[2])}`);
  return {
    title: pick(/<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/),
    company: pick(/topcard__org-name-link[^>]*>([\s\S]*?)</),
    location: pick(/topcard__flavor--bullet[^>]*>([\s\S]*?)</),
    // The criteria block carries the seniority level, which the blocker rules read.
    description: criteria.length ? `${description}\n\n${criteria.join('\n')}` : description,
  };
}

/** @param {string} url @returns {Promise<Response>} */
async function timedFetch(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {{ ok: true, fields: Record<string, string>, liveness: string }
 *   | { ok: false, outcome: 'expired'|'unsupported'|'blocked'|'empty'|'error', reason: string }} FetchOutcome
 */

/** @param {string} url @returns {Promise<FetchOutcome>} */
async function fetchLinkedin(url) {
  const id = linkedinJobId(url);
  if (!id) return { ok: false, outcome: 'unsupported', reason: 'no LinkedIn job id in URL' };
  let res;
  try {
    res = await timedFetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
    });
  } catch (error) {
    return { ok: false, outcome: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
  if (res.status === 404 || res.status === 410) {
    return { ok: false, outcome: 'expired', reason: `guest endpoint ${res.status} — posting removed` };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, outcome: 'blocked', reason: `guest endpoint ${res.status} — throttled or unavailable` };
  }
  if (!res.ok) return { ok: false, outcome: 'error', reason: `guest endpoint ${res.status}` };
  const fields = parseLinkedinPosting(await res.text());
  if (fields.description.length < MIN_DESCRIPTION_CHARS) {
    return { ok: false, outcome: 'empty', reason: `description too short (${fields.description.length} chars)` };
  }
  return { ok: true, fields, liveness: 'active' };
}

/**
 * Some companies embed a Greenhouse board on their own domain and keep only the
 * `gh_jid` query param (nuro.ai/careersitem?gh_jid=..., seatgeek.com/jobs/N?gh_jid=N).
 * The board token is usually the registrable name, so guess it — a wrong guess just
 * 404s, and callers treat a guessed 404 as unsupported rather than as a dead posting.
 * @param {string} rawUrl
 */
export function resolveEmbeddedGreenhouse(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const jobId = u.searchParams.get('gh_jid');
  if (!jobId || !/^\d{4,}$/.test(jobId)) return null;
  const labels = u.hostname.split('.').filter((label) => label && label !== 'www');
  const board = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  if (!board || !/^[a-z0-9-]+$/i.test(board)) return null;
  return {
    ats: 'greenhouse',
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`,
    parts: { board, jobId },
    guessedBoard: true,
  };
}

/** @param {string} url @returns {Promise<FetchOutcome>} */
async function fetchAts(url) {
  const resolved = resolveAtsApi(url) || resolveEmbeddedGreenhouse(url);
  if (!resolved) return { ok: false, outcome: 'unsupported', reason: 'not a known ATS posting URL' };
  let res;
  try {
    res = await timedFetch(resolved.apiUrl, { 'user-agent': 'career-ops-backfill/1.0', accept: 'application/json' });
  } catch (error) {
    return { ok: false, outcome: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
  if (res.status === 404 || res.status === 410) {
    // A guessed board name is a likely cause of 404 here, so don't call the posting dead.
    return resolved.guessedBoard
      ? { ok: false, outcome: 'unsupported', reason: `guessed Greenhouse board "${resolved.parts.board}" returned ${res.status}` }
      : { ok: false, outcome: 'expired', reason: `${resolved.ats} API ${res.status} — posting removed` };
  }
  if (!res.ok) return { ok: false, outcome: 'error', reason: `${resolved.ats} API ${res.status}` };

  let json;
  try { json = await res.json(); } catch { return { ok: false, outcome: 'error', reason: 'unparseable API body' }; }

  let raw = '';
  let fields = {};
  if (resolved.ats === 'greenhouse') {
    raw = json?.content || '';
    fields = { title: json?.title || '', location: json?.location?.name || '' };
  } else if (resolved.ats === 'lever') {
    raw = [json?.descriptionPlain || json?.description || '', ...(json?.lists || []).map(
      (l) => `${l?.text || ''}\n${l?.content || ''}`,
    )].join('\n');
    fields = { title: json?.text || '', location: json?.categories?.location || '' };
  } else if (resolved.ats === 'ashby') {
    const job = (json?.jobs || []).find((j) => String(j?.id).toLowerCase() === String(resolved.parts.jobId).toLowerCase());
    if (!job) return { ok: false, outcome: 'expired', reason: 'Ashby posting no longer listed on the board' };
    raw = job.descriptionHtml || job.descriptionPlain || '';
    fields = { title: job.title || '', location: job.location || '' };
  }

  const description = htmlToText(raw);
  if (description.length < MIN_DESCRIPTION_CHARS) {
    return { ok: false, outcome: 'empty', reason: `description too short (${description.length} chars)` };
  }
  return { ok: true, fields: { ...fields, description }, liveness: 'active' };
}

/** @param {string} url */
async function fetchDescription(url) {
  if (linkedinJobId(url)) return fetchLinkedin(url);
  if (resolveAtsApi(url) || resolveEmbeddedGreenhouse(url)) return fetchAts(url);
  return { ok: false, outcome: 'unsupported', reason: 'no public description source for this host' };
}

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

/** Run `worker` over `items` with bounded concurrency and a polite inter-request gap. */
async function pool(items, concurrency, gapMs, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
      if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  });
  await Promise.all(runners);
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
    const result = await fetchDescription(item.canonicalUrl || item.applyUrl || item.sourceUrl || '');
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
