#!/usr/bin/env node
// @ts-check

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  GmailClientError,
  TARGET_GMAIL_ACCOUNT,
  createGmailClient,
} from './gmail-client.mjs';
import { hasGmailCredentials, organizeGmail } from './gmail.mjs';
import { syncApplicationIngest } from './application-ingest.mjs';
import { loadDotenvOnce, runHook } from './plugins/_engine.mjs';
import { OUTREACH_STATE_PATH, recordSubmissionSignal } from './outreach-lib.mjs';
import {
  DEFAULT_QUEUE_LIMIT,
  applicationKey,
  buildQueue,
  buildQueueItem,
  isGamblingCandidate,
  loadApplications,
  loadProfile,
  mergePipelineHistory,
  normalizeUrl,
  parsePipeline,
  parseScanHistory,
  readQueueState,
  renderQueueMarkdown,
  scoreCandidate,
  topUpSelection,
  writeQueueState,
} from './queue-lib.mjs';
import { applyPostingAging } from './queue-aging.mjs';
import { evictToArchive, readArchive, writeArchive } from './queue-archive.mjs';
import { checkPublicLiveness } from './liveness-http.mjs';
import { enrichCandidates } from './posting-fetch.mjs';
import { readHandshakeSyncStatus } from './handshake-lib.mjs';
import { readHandshakeInboxStatus } from './handshake-inbox-lib.mjs';
import { loadPluginConfig } from './plugins/_engine.mjs';
import {
  AUTHENTICATED_MARKETPLACE_SOURCE_IDS,
  readMarketplaceSyncStatus,
  resolveMarketplacePaths,
} from './authenticated-marketplace-lib.mjs';

export { checkPublicLiveness } from './liveness-http.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_JSON = path.join(ROOT, 'data', 'job-queue.json');
const QUEUE_MD = path.join(ROOT, 'data', 'job-queue.md');
const LOCK_FILE = path.join(ROOT, 'data', '.job-queue.lock');
const SCHEDULE_LABEL = 'com.jakyeamos.career-ops.queue';
const UI_SERVER_LABEL = 'com.jakyeamos.career-ops.queue-ui';

/** @param {string} value */
function flagValue(value, fallback) {
  return value && !value.startsWith('--') ? value : fallback;
}

/** @param {string[]} args @param {string} flag @param {string} fallback */
function readFlag(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index >= 0) return flagValue(args[index + 1], fallback);
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

/**
 * @param {string} script
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [options]
 */
async function runNodeScript(script, args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      timeout: options.timeoutMs || 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '', error: '' };
  } catch (error) {
    const typed = /** @type {Error & {stdout?: string, stderr?: string}} */ (error);
    return {
      ok: false,
      stdout: typed.stdout || '',
      stderr: typed.stderr || '',
      error: typed.message || String(error),
    };
  }
}

/** @param {Array<Record<string, unknown>>} candidates @param {number} limit */
async function checkPublicCandidates(candidates, limit) {
  const output = [];
  let checked = 0;
  for (const candidate of candidates) {
    if (checked >= limit) {
      output.push(candidate);
      continue;
    }
    if (candidate.liveness === 'source-alert' || candidate.liveness === 'active') {
      output.push(candidate);
      continue;
    }
    const liveness = await checkPublicLiveness(String(candidate.url || candidate.canonicalUrl || ''));
    output.push({ ...candidate, liveness });
    checked++;
  }
  return output;
}

/** @param {string} text */
function parseAtsJson(text) {
  try {
    const parsed = JSON.parse(text.trim());
    return Array.isArray(parsed.offers) ? parsed.offers : [];
  } catch { return []; }
}

/** @param {string} file */
function readText(file) { return existsSync(file) ? readFileSync(file, 'utf8') : ''; }

/**
 * @param {{ dryRun: boolean, limit: number, skipPublic: boolean }} options
 */
async function discoverPublic(options) {
  const errors = [];
  const candidates = [];
  const pipelineFile = path.join(ROOT, 'data', 'pipeline.md');
  const before = new Set(parsePipeline(readText(pipelineFile)).map((job) => job.url));

  if (!options.skipPublic) {
    const scan = await runNodeScript('scan.mjs', options.dryRun ? ['--dry-run'] : [], { timeoutMs: 300_000 });
    if (!scan.ok) errors.push(`tracked public scan failed: ${scan.error}`);
    const after = parsePipeline(readText(pipelineFile));
    const observedAt = new Date().toISOString();
    for (const job of after) {
      if (!before.has(job.url)) candidates.push({ ...job, liveness: 'uncertain', discoveredAt: observedAt, observedAt });
    }

    const atsLimit = Math.max(25, options.limit * 12);
    const atsArgs = ['--seeds', 'yc', '--since', '7', '--limit', String(atsLimit), '--json'];
    if (options.dryRun) atsArgs.push('--dry-run');
    const ats = await runNodeScript('scan-ats-full.mjs', atsArgs, { timeoutMs: 300_000 });
    if (!ats.ok) errors.push(`YC/ATS scan failed: ${ats.error}`);
    const atsObservedAt = new Date().toISOString();
    const atsOffers = parseAtsJson(ats.stdout).map((offer) => ({
      ...offer,
      canonicalUrl: offer.url,
      source: offer.source || 'yc',
      liveness: 'uncertain',
      discoveredAt: atsObservedAt,
      observedAt: atsObservedAt,
    }));
    candidates.push(...atsOffers);
  }

  const checked = await checkPublicCandidates(candidates, Math.max(50, options.limit * 8));
  return { candidates: checked, errors };
}

/** @param {{ dryRun: boolean, limit: number }} options */
async function ingestGmail(options) {
  const errors = [];
  const candidates = [];
  const sourceCounts = {};
  const sourceErrors = /** @type {Record<string, string[]>} */ ({
    gmail: [],
    jackandjill: [],
    applications: [],
    ...Object.fromEntries(AUTHENTICATED_MARKETPLACE_SOURCE_IDS.map((source) => [source, []])),
  });
  const marketplaceSyncStatuses = {};
  const pluginConfig = await loadPluginConfig(ROOT);
  let handshakeSyncStatus = null;
  let handshakeInboxStatus = null;
  let gmailAccessAvailable = false;
  try {
    const organized = await organizeGmail({ root: ROOT, dryRun: options.dryRun, limit: Math.max(1000, options.limit * 20) });
    if (organized.authenticated) {
      gmailAccessAvailable = true;
    } else {
      const message = 'Gmail organizer skipped: OAuth credentials are not configured';
      errors.push(message);
      sourceErrors.gmail.push(message);
    }
  } catch (error) {
    const message = `Gmail organizer failed: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(message);
    sourceErrors.gmail.push(message);
  }

  try {
    const results = await runHook('ingest', null, {
      root: ROOT,
      dryRun: options.dryRun,
      timeoutMs: 120_000,
    });
    for (const result of results) {
      if (!['gmail', 'jackandjill', ...AUTHENTICATED_MARKETPLACE_SOURCE_IDS].includes(result.id)) continue;
      if (!result.ok) {
        const message = `${result.id} ingest failed: ${result.error || 'unknown error'}`;
        errors.push(message);
        (sourceErrors[result.id] ||= []).push(message);
        continue;
      }
      if (result.id === 'gmail') gmailAccessAvailable = true;
      if (result.id === 'handshake') {
        handshakeSyncStatus = readHandshakeSyncStatus(path.join(ROOT, 'data', 'handshake-sync-status.json'));
      }
      if (Array.isArray(result.result)) {
        const observedAt = new Date().toISOString();
        sourceCounts[result.id] = result.result.length;
        for (const candidate of result.result) {
          if (!candidate || typeof candidate !== 'object') continue;
          candidates.push({
            ...candidate,
            observedAt: candidate.observedAt || observedAt,
            lastSeenAt: candidate.lastSeenAt || candidate.observedAt || observedAt,
          });
        }
      }
    }
    handshakeSyncStatus = handshakeSyncStatus || readHandshakeSyncStatus(path.join(ROOT, 'data', 'handshake-sync-status.json'));
    handshakeInboxStatus = readHandshakeInboxStatus(path.join(ROOT, 'data', 'handshake-inbox-sync-status.json'));
    if (handshakeSyncStatus?.ok === false) {
      const message = `Handshake browser sync unavailable: ${handshakeSyncStatus.error || 'unknown bridge error'} (cached records preserved)`;
      errors.push(message);
      sourceErrors.handshake.push(message);
    } else if (!sourceCounts.handshake && !existsSync(path.join(ROOT, 'data', 'handshake-recommendations.json'))) {
      const message = 'Handshake ingest has no local cache; run node handshake.mjs sync --write from an authenticated Chrome bridge';
      errors.push(message);
      sourceErrors.handshake.push(message);
    }
    for (const source of AUTHENTICATED_MARKETPLACE_SOURCE_IDS) {
      const settings = pluginConfig?.plugins?.[source] && typeof pluginConfig.plugins[source] === 'object'
        ? pluginConfig.plugins[source]
        : {};
      const enabled = settings.enabled === true;
      const paths = resolveMarketplacePaths(settings, source);
      const status = source === 'handshake'
        ? handshakeSyncStatus
        : readMarketplaceSyncStatus(paths.statusFile);
      marketplaceSyncStatuses[source] = status;
      if (!enabled || source === 'handshake') continue;
      if (status?.ok === false) {
        const message = `${source} browser sync unavailable: ${status.error || 'unknown bridge error'} (cached records preserved)`;
        errors.push(message);
        sourceErrors[source].push(message);
      } else if (!sourceCounts[source] && !existsSync(paths.cacheFile)) {
        const message = `${source} ingest has no local cache; run node marketplace.mjs sync --source ${source} --write from an authenticated Chrome bridge`;
        errors.push(message);
        sourceErrors[source].push(message);
      }
    }
    if (!sourceCounts.gmail && !hasGmailCredentials()) {
      const message = 'Gmail queue ingest unavailable until .env OAuth values are configured';
      errors.push(message);
      sourceErrors.gmail.push(message);
    }
  } catch (error) {
    const message = `Gmail plugin failed: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(message);
    sourceErrors.gmail.push(message);
  }
  let applicationImport;
  try {
    applicationImport = await syncApplicationIngest({
      root: ROOT,
      dryRun: options.dryRun,
      skipGmail: !gmailAccessAvailable,
      limit: Math.max(100, options.limit * 20),
      logger: (...messages) => console.log(...messages),
    });
    sourceCounts.applications = applicationImport.email.signals;
    sourceCounts.jackandjillBoard = applicationImport.board.cards;
    for (const message of applicationImport.errors) {
      errors.push(message);
      sourceErrors.applications.push(message);
    }
  } catch (error) {
    const message = `application evidence ingest failed: ${error instanceof Error ? error.message : String(error)}`;
    errors.push(message);
    sourceErrors.applications.push(message);
  }
  return { candidates, errors, sourceCounts, sourceErrors, applicationImport, handshakeSyncStatus, handshakeInboxStatus, marketplaceSyncStatuses };
}

/** @param {Array<Record<string, unknown>>} input */
export function dedupCandidates(input) {
  const byUrl = new Map();
  for (const candidate of input) {
    const url = normalizeUrl(String(candidate.url || candidate.canonicalUrl || ''));
    if (!url) continue;
    const current = byUrl.get(url);
    if (!current || (candidate.description && !current.description) || candidate.liveness === 'active') {
      const merged = { ...current, ...candidate, url, canonicalUrl: url };
      if (candidate.sourceMessageId == null && current?.sourceMessageId != null) {
        merged.sourceMessageId = current.sourceMessageId;
      }
      if (candidate.sourceUrl == null && current?.sourceUrl != null) {
        merged.sourceUrl = current.sourceUrl;
      }
      if (candidate.sourceEvidence == null && current?.sourceEvidence != null) {
        merged.sourceEvidence = current.sourceEvidence;
      }
      byUrl.set(url, merged);
    }
  }
  return [...byUrl.values()];
}

/** @param {Record<string, unknown>} item */
function escapeTable(value) { return String(value || '').replace(/[|\r\n]/g, ' '); }

/** @param {string} root @param {Record<string, unknown>} item */
export function recordApplication(root, item) {
  const file = path.join(root, 'data', 'applications.md');
  if (!existsSync(file)) return { recorded: false, reason: 'data/applications.md is missing' };
  const existing = loadApplications(root);
  if (existing.has(applicationKey(item))) return { recorded: false, reason: 'company/role already exists in applications.md' };
  const text = readFileSync(file, 'utf8');
  const numbers = [...text.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((match) => Number(match[1]));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  const score = Number(item.fitScore || 0).toFixed(1);
  const line = `| ${next} | ${new Date().toISOString().slice(0, 10)} | ${escapeTable(item.company)} | ${escapeTable(item.title)} | ${score}/5 | Applied | ❌ | — | Queue applied: ${escapeTable(item.source)}; ${escapeTable(item.applyUrl || item.canonicalUrl)} |\n`;
  appendFileSync(file, text.endsWith('\n') ? line : `\n${line}`, 'utf8');
  return { recorded: true, reason: `added tracker row #${next}` };
}

/** @param {string} url */
function openUrl(url) {
  if (!url) return;
  try { execFileSync('open', [url], { stdio: 'ignore' }); }
  catch { console.log(`Open manually: ${url}`); }
}

/**
 * Writes the live queue, evicting dead rows into the archive sidecar first.
 * Returns the persisted state so callers work from the post-eviction view.
 *
 * @param {string} root @param {Record<string, unknown>} state
 */
export function saveQueue(root, state) {
  const archiveFile = path.join(root, 'data', 'job-queue-archive.json');
  const result = evictToArchive(state, readArchive(archiveFile), { now: new Date().toISOString() });
  writeQueueState(path.join(root, 'data', 'job-queue.json'), result.state);
  writeArchive(archiveFile, result.archive);
  writeFileSync(path.join(root, 'data', 'job-queue.md'), renderQueueMarkdown(result.state), 'utf8');
  return result.state;
}

/** @param {string} root @param {boolean} scheduled */
function acquireLock(root, scheduled) {
  if (!scheduled) return () => {};
  mkdirSync(path.join(root, 'data'), { recursive: true });
  if (existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      if (lock.pid) {
        try { process.kill(Number(lock.pid), 0); throw new Error(`another queue refresh is running (pid ${lock.pid})`); }
        catch (error) {
          if (error instanceof Error && error.message.startsWith('another queue')) throw error;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('another queue')) throw error;
      try { unlinkSync(LOCK_FILE); } catch { /* stale lock already gone */ }
    }
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', 'utf8');
  return () => { try { unlinkSync(LOCK_FILE); } catch { /* no-op */ } };
}

/** @param {string} root @param {number} limit @param {boolean} dryRun @param {boolean} scheduled @param {boolean} skipPublic @param {boolean} skipOutreach */
async function refresh(root, limit, dryRun, scheduled, skipPublic, skipOutreach = false) {
  const release = acquireLock(root, scheduled);
  try {
    await loadDotenvOnce();
    const previous = readQueueState(path.join(root, 'data', 'job-queue.json'));
    const gmail = await ingestGmail({ dryRun, limit });
    const publicSources = await discoverPublic({ dryRun, limit, skipPublic });
    const pipelineJobs = parsePipeline(readText(path.join(root, 'data', 'pipeline.md')));
    const history = parseScanHistory(readText(path.join(root, 'data', 'scan-history.tsv')));
    const pipelineCandidates = pipelineJobs.map((job) => mergePipelineHistory(job, history.get(job.url)));
    let candidates = dedupCandidates([...pipelineCandidates, ...publicSources.candidates, ...gmail.candidates]);
    const applications = loadApplications(root);
    candidates = candidates.filter((candidate) => !applications.has(applicationKey(candidate)) && candidate.liveness !== 'expired');
    const gamblingExcluded = candidates.filter((candidate) => isGamblingCandidate(candidate)).length;
    candidates = candidates.filter((candidate) => !isGamblingCandidate(candidate));
    const profile = loadProfile(root);
    // Email alerts arrive as a subject line and a link, nothing more. Scored on that
    // alone every one of them lands on the same title-match-only number, so they are
    // mutually indistinguishable and the digest-subject garbage in `company` survives
    // into the queue. Fetch the real posting first; a posting that is gone comes back
    // `expired` and is dropped below, and correcting the company can newly match an
    // application, so both filters are re-applied.
    const enrichment = await enrichCandidates(candidates, { log: (message) => console.log(message) });
    candidates = enrichment.candidates.filter(
      (candidate) => candidate.liveness !== 'expired' && !applications.has(applicationKey(candidate)),
    );
    const previousForBuild = {
      ...previous,
      items: Array.isArray(previous.items)
        ? previous.items.filter((item) => !isGamblingCandidate(item))
        : [],
    };
    const sourceErrors = [...gmail.errors, ...publicSources.errors];
    const candidateItems = candidates.map((candidate) => buildQueueItem(candidate, profile, root));
    const now = new Date().toISOString();
    let state = buildQueue(candidateItems, previousForBuild, { limit, now, retainUnseen: true });
    const aging = applyPostingAging(state, {
      now,
      sourceScanHealthy: sourceErrors.length === 0 && !skipPublic,
    });
    state.lastRun = {
      at: now,
      scheduled,
      dryRun,
      sources: {
        gmail: { candidates: gmail.sourceCounts.gmail || 0, errors: gmail.sourceErrors.gmail.length },
        jackandjill: { candidates: gmail.sourceCounts.jackandjill || 0, errors: gmail.sourceErrors.jackandjill.length },
        applications: { confirmations: gmail.sourceCounts.applications || 0, errors: gmail.sourceErrors.applications.length },
        jackandjillBoard: { cards: gmail.sourceCounts.jackandjillBoard || 0 },
        handshake: {
          candidates: gmail.sourceCounts.handshake || 0,
          errors: gmail.sourceErrors.handshake.length,
          status: gmail.handshakeSyncStatus?.ok === true ? 'connected' : gmail.handshakeSyncStatus?.outcome || 'cache-only-or-unavailable',
          observedAt: gmail.handshakeSyncStatus?.observedAt || null,
          inbox: {
            threads: gmail.handshakeInboxStatus?.threadCount || 0,
            unread: gmail.handshakeInboxStatus?.unreadCount || 0,
            status: gmail.handshakeInboxStatus?.ok === true ? 'connected' : gmail.handshakeInboxStatus?.outcome || 'not-checked',
            observedAt: gmail.handshakeInboxStatus?.observedAt || null,
          },
        },
        ...Object.fromEntries(AUTHENTICATED_MARKETPLACE_SOURCE_IDS
          .filter((source) => source !== 'handshake')
          .map((source) => [source, {
              candidates: gmail.sourceCounts[source] || 0,
              errors: gmail.sourceErrors[source]?.length || 0,
              status: gmail.marketplaceSyncStatuses?.[source]?.ok === true
                ? 'connected'
                : gmail.marketplaceSyncStatuses?.[source]?.outcome || 'cache-only-or-unavailable',
              observedAt: gmail.marketplaceSyncStatuses?.[source]?.observedAt || null,
            }])),
        public: { candidates: publicSources.candidates.length, errors: publicSources.errors.length },
      },
      errors: sourceErrors,
      exclusions: { gambling: gamblingExcluded },
      enrichment: enrichment.outcomes,
      aging,
    };
    if (!dryRun) state = saveQueue(root, state);
    state.lastRun.errors = sourceErrors;
    if (skipOutreach) {
      state.lastRun.outreach = { ok: true, skipped: true, output: 'outreach deferred until a confirmed application submission' };
    } else {
      const outreachArgs = ['process'];
      if (dryRun) outreachArgs.push('--dry-run');
      const outreach = await runNodeScript('outreach.mjs', outreachArgs, { timeoutMs: 180_000 });
      if (!outreach.ok) sourceErrors.push(`outreach process failed: ${outreach.error}`);
      state.lastRun.outreach = {
        ok: outreach.ok,
        output: `${outreach.stdout || ''}${outreach.stderr || ''}`.trim().slice(0, 4000),
      };
    }
    state.lastRun.errors = sourceErrors;
    if (!dryRun) state = saveQueue(root, state);
    const selected = state.items.filter((item) => item.selectedForToday);
    console.log(`Queue refresh${dryRun ? ' (dry run)' : ''}: ${selected.length} role(s) selected, ${state.items.length} total retained.`);
    if (sourceErrors.length) for (const error of sourceErrors) console.log(`  ⚠️ ${error}`);
    for (const item of selected.sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999))) console.log(`  ${item.queueRank}. ${item.company || 'Unknown'} | ${item.title} | ${item.fitScore.toFixed(1)}/5 | ${item.status} | ${item.applyUrl}`);
    if (process.env.CAREER_OPS_QUEUE_PREVIEW === '1') {
      const preview = state.items.map((item) => ({
        id: item.id,
        company: item.company,
        title: item.title,
        status: item.status,
        applicationState: item.applicationState || null,
        fitScore: item.fitScore,
        liveness: item.liveness,
        applyUrl: item.applyUrl,
        canonicalUrl: item.canonicalUrl,
        postedAt: item.postedAt,
      }));
      console.log(`CAREER_OPS_QUEUE_PREVIEW ${JSON.stringify(preview)}`);
    }
    return state;
  } finally { release(); }
}

async function clearQueue(root) {
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const items = state.items.filter((item) => item.selectedForToday).sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999));
  if (!items.length) { console.log('No roles are selected. Run `node queue.mjs refresh` first.'); return; }
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  try {
    for (const item of items) {
      if (!item.selectedForToday) continue;
      console.log(`\n[${item.queueRank}] ${item.title} — ${item.company || 'Unknown company'}`);
      console.log(`  ${item.fitScore.toFixed(1)}/5 | ${item.lane} | ${item.liveness} | ${item.applyUrl}`);
      console.log(`  ${item.fitReasons.join('; ')}`);
      const action = String(await ask('  [o]pen [a]pplied [c]onfirmed submitted [s]kip [z]snooze [q]uit: ')).trim().toLowerCase();
      if (action === 'q') break;
      if (action === 'o') { openUrl(item.applyUrl); continue; }
      if (action === 'a' || action === 'c') {
        const appliedAt = new Date().toISOString();
        item.status = 'applied';
        item.appliedAt = appliedAt;
        item.selectedForToday = false;
        item.queueRank = null;
        const recorded = recordApplication(root, item);
        recordSubmissionSignal(path.join(root, OUTREACH_STATE_PATH), item, {
          source: action === 'c' ? 'user_confirmed_submission' : 'queue_applied',
          at: appliedAt,
          confirmed: action === 'c',
        });
        item.actionNote = recorded.reason;
        console.log(action === 'c'
          ? `  Submission confirmed; outreach may now be processed (${recorded.reason}).`
          : `  Applied recorded; outreach is still waiting for submission confirmation (${recorded.reason}).`);
      } else if (action === 's') {
        item.status = 'skipped';
        item.selectedForToday = false;
        item.queueRank = null;
        item.skipReason = String(await ask('  Reason (optional): ')).trim();
      } else if (action === 'z') {
        const date = String(await ask('  Snooze until YYYY-MM-DD: ')).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.log('  Invalid date; leaving role unchanged.'); continue; }
        item.status = 'snoozed';
        item.snoozeUntil = `${date}T00:00:00.000Z`;
        item.selectedForToday = false;
        item.queueRank = null;
      }
      state.generatedAt = new Date().toISOString();
      saveQueue(root, state);
    }
  } finally { rl.close(); }
}

/** @param {string} root */
function listQueue(root) {
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const items = state.items.filter((item) => item.selectedForToday).sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999));
  console.log(`Daily queue for ${state.account?.gmail || TARGET_GMAIL_ACCOUNT}: ${items.length} role(s)`);
  for (const item of items) console.log(`${item.queueRank}. ${item.company || 'Unknown'} | ${item.title} | ${item.fitScore.toFixed(1)}/5 | ${item.status} | ${item.applyUrl}`);
}

/** @param {string} root @returns {string[]} */
export function collectQueueErrors(root) {
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const errors = [];
  if (state.schemaVersion !== 1) errors.push(`unsupported schema version ${state.schemaVersion}`);
  if (state.account?.gmail !== TARGET_GMAIL_ACCOUNT) errors.push(`queue account is not ${TARGET_GMAIL_ACCOUNT}`);
  const ids = new Set();
  let selected = 0;
  for (const item of state.items || []) {
    if (ids.has(item.id)) errors.push(`duplicate item id ${item.id}`);
    ids.add(item.id);
    if (!normalizeUrl(item.applyUrl || item.canonicalUrl)) errors.push(`invalid URL for ${item.title}`);
    if (item.selectedForToday) selected++;
    if (!['ready', 'in_review', 'applied', 'skipped', 'snoozed', 'stale', 'archived', 'excluded'].includes(item.status)) errors.push(`invalid status ${item.status}`);
    if (['archived', 'excluded'].includes(String(item.status || ''))) errors.push(`item ${item.id} has evicted status ${item.status} but is still live`);
  }
  if (selected > 10) errors.push(`selected queue exceeds 10 roles (${selected})`);
  let records = [];
  try {
    records = readArchive(path.join(root, 'data', 'job-queue-archive.json')).records;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const archivedIds = new Set(records.map((record) => record.id));
  for (const stub of Array.isArray(state.archivedIndex) ? state.archivedIndex : []) {
    if (ids.has(stub.id)) errors.push(`archived stub ${stub.id} is also a live queue item`);
    if (!archivedIds.has(stub.id)) errors.push(`archived stub ${stub.id} has no record in the archive`);
  }
  return errors;
}

/** @param {string} root */
function verifyQueue(root) {
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const errors = collectQueueErrors(root);
  if (errors.length) { for (const error of errors) console.error(`❌ ${error}`); process.exitCode = 1; return; }
  const selected = (state.items || []).filter((item) => item.selectedForToday).length;
  const archived = Array.isArray(state.archivedIndex) ? state.archivedIndex.length : 0;
  console.log(`✅ Queue valid: ${state.items.length} live item(s), ${selected} selected, ${archived} archived.`);
}

/** @param {string} value */
function blockerSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Pulls archived records back into the live queue and rescores them. The
 * following save re-evicts whatever still scores `excluded`, so this is safe
 * to run broadly.
 *
 * @param {string} root @param {string|null} blocker @param {boolean} dryRun
 */
export function rehydrateQueue(root, blocker, dryRun) {
  const profile = loadProfile(root);
  const archiveFile = path.join(root, 'data', 'job-queue-archive.json');
  const archive = readArchive(archiveFile);
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const wanted = blocker ? blockerSlug(blocker) : null;
  const matches = archive.records.filter((record) => {
    if (!wanted) return true;
    return (Array.isArray(record.blockers) ? record.blockers : [])
      .some((entry) => blockerSlug(entry).includes(wanted));
  });

  const now = new Date().toISOString();
  const rescored = matches.map((record) => {
    const evaluation = scoreCandidate(record, profile);
    return {
      ...record,
      fitScore: evaluation.score,
      fitConfidence: evaluation.confidence,
      fitReasons: evaluation.reasons,
      blockers: evaluation.blockers,
      locationFit: evaluation.locationFit,
      lane: evaluation.lane,
      status: evaluation.status,
      selectedForToday: false,
      queueRank: null,
      rehydratedAt: now,
      updatedAt: now,
    };
  });

  const label = wanted ? ` matching blocker "${blocker}"` : '';
  if (dryRun) {
    console.log(`Rehydrate (dry run): ${rescored.length} archived record(s)${label}.`);
    const counts = new Map();
    for (const entry of rescored) counts.set(entry.status, (counts.get(entry.status) || 0) + 1);
    for (const [status, count] of [...counts.entries()].sort()) console.log(`  ${status}: ${count}`);
    console.log(`  ${rescored.filter((entry) => entry.status !== 'excluded').length} would stay live after the next write.`);
    return;
  }

  const ids = new Set(rescored.map((entry) => entry.id));
  const previousItems = Array.isArray(state.items) ? state.items : [];
  const previousIndex = Array.isArray(state.archivedIndex) ? state.archivedIndex : [];
  const next = {
    ...state,
    items: [...previousItems.filter((entry) => !ids.has(entry.id)), ...rescored],
    archivedIndex: previousIndex.filter((stub) => !ids.has(stub.id)),
  };
  // The archive is trimmed before the save so the save's read-modify-write can
  // put back only the records that still score `excluded`.
  writeArchive(archiveFile, { ...archive, updatedAt: now, records: archive.records.filter((record) => !ids.has(record.id)) });
  const saved = saveQueue(root, topUpSelection(next).state);
  const live = saved.items.filter((entry) => ids.has(entry.id)).length;
  console.log(`Rehydrated ${rescored.length} record(s)${label}: ${live} stayed live, ${rescored.length - live} were evicted again.`);
}

/** @param {string} value */
function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} root @param {string} logs */
export function buildLaunchdPlist(root, logs) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${SCHEDULE_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(path.join(root, 'scripts', 'queue-ui-launch.mjs'))}</string></array>\n<key>WorkingDirectory</key><string>${xmlEscape(root)}</string>\n<key>StandardOutPath</key><string>${xmlEscape(path.join(logs, 'queue.log'))}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(path.join(logs, 'queue.err.log'))}</string>\n<key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n`;
}

/** @param {string} root @param {string} logs */
export function buildUiServerPlist(root, logs) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${UI_SERVER_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(path.join(root, 'queue-ui.mjs'))}</string><string>--serve</string></array>\n<key>WorkingDirectory</key><string>${xmlEscape(root)}</string>\n<key>StandardOutPath</key><string>${xmlEscape(path.join(logs, 'queue-ui.log'))}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(path.join(logs, 'queue-ui.err.log'))}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n</dict></plist>\n`;
}

/** @param {string} root @param {boolean} dryRun */
async function installSchedule(root, dryRun) {
  await loadDotenvOnce();
  let account = '(not verified in dry run)';
  if (hasGmailCredentials()) {
    const client = await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
    account = await client.verifyAccount();
  } else if (!dryRun) {
    throw new Error(`cannot install schedule until Gmail OAuth for ${TARGET_GMAIL_ACCOUNT} is configured`);
  }
  const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const logs = path.join(os.homedir(), 'Library', 'Logs', 'career-ops');
  const plistPath = path.join(launchAgents, `${SCHEDULE_LABEL}.plist`);
  const uiPlistPath = path.join(launchAgents, `${UI_SERVER_LABEL}.plist`);
  const plist = buildLaunchdPlist(root, logs);
  const uiPlist = buildUiServerPlist(root, logs);
  console.log(`Verified Gmail account: ${account}`);
  console.log(`Schedule: 8:00 AM local time or first login after 8:00; plist: ${plistPath}`);
  console.log(`Queue UI server: http://127.0.0.1:47831/; plist: ${uiPlistPath}`);
  if (dryRun) { console.log(plist); console.log(uiPlist); return; }
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(plistPath, plist, 'utf8');
  writeFileSync(uiPlistPath, uiPlist, 'utf8');
  const domain = `gui/${process.getuid?.() || process.env.UID}`;
  try { execFileSync('launchctl', ['bootout', `${domain}/${SCHEDULE_LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
  try { execFileSync('launchctl', ['bootout', `${domain}/${UI_SERVER_LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
  execFileSync('launchctl', ['bootstrap', domain, uiPlistPath], { stdio: 'inherit' });
  execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
  console.log(`Installed ${SCHEDULE_LABEL} and ${UI_SERVER_LABEL}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  const limit = Math.max(1, Math.min(10, Number(readFlag(args, '--limit', String(DEFAULT_QUEUE_LIMIT))) || DEFAULT_QUEUE_LIMIT));
  if (command === 'refresh') {
    await refresh(ROOT, limit, args.includes('--dry-run'), args.includes('--scheduled'), args.includes('--skip-public'), args.includes('--skip-outreach'));
    return;
  }
  if (command === 'list' || command === 'today') { listQueue(ROOT); return; }
  if (command === 'clear') { await clearQueue(ROOT); return; }
  if (command === 'verify') { verifyQueue(ROOT); return; }
  if (command === 'questions-doctor') {
    const doctor = await import('./question-propagation-doctor.mjs');
    try {
      const result = await doctor.runQuestionPropagationDoctor({
        root: ROOT,
        since: readFlag(args, '--since', ''),
        all: args.includes('--all'),
      });
      console.log(args.includes('--json')
        ? JSON.stringify(result, null, 2)
        : doctor.renderQuestionPropagationReport(result));
      process.exitCode = result.exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(args.includes('--json')
        ? JSON.stringify({ schemaVersion: 1, type: 'question-propagation-doctor', status: 'invalid', exitCode: 2, error: message })
        : `questions-doctor: ${message}`);
      process.exitCode = 2;
    }
    return;
  }
  if (command === 'rehydrate') {
    rehydrateQueue(ROOT, readFlag(args, '--blocker', '') || null, args.includes('--dry-run'));
    return;
  }
  if (command === 'health') {
    const health = await import('./queue-health.mjs');
    const healthLimit = Math.max(1, Math.min(2_000, Number(readFlag(args, '--limit', '100')) || 100));
    const result = await health.runQueueHealth({
      limit: healthLimit,
      all: args.includes('--all'),
      apply: args.includes('--apply'),
      browser: args.includes('--browser'),
      linkedinOnly: args.includes('--linkedin'),
    });
    console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : health.renderHealthReport(result));
    return;
  }
  if (command === 'status') {
    await loadDotenvOnce();
    const state = readQueueState(QUEUE_JSON);
    console.log(`Account: ${TARGET_GMAIL_ACCOUNT}`);
    console.log(`Gmail credentials: ${hasGmailCredentials() ? 'configured' : 'missing'}`);
    console.log(`Queue file: ${QUEUE_JSON}`);
    console.log(`Selected: ${(state.items || []).filter((item) => item.selectedForToday).length}`);
    console.log(`Last refresh: ${state.lastRun?.at || 'never'}`);
    console.log(`Last health check: ${state.lastHealthCheck?.at || 'never'}`);
    return;
  }
  if (command === 'install-schedule') { await installSchedule(ROOT, args.includes('--dry-run')); return; }
  throw new Error(`Unknown queue command "${command}". Use refresh, list, clear, health, status, verify, questions-doctor, or install-schedule.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { await main(); }
  catch (error) {
    console.error(`queue: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof GmailClientError && error.status === 403 ? 2 : 1;
  }
}
