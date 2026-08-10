#!/usr/bin/env node
// @ts-check

/**
 * Threshold-gated Jack & Jill archive planning.
 *
 * This module never changes the Jack & Jill account. It joins a fresh,
 * read-only board snapshot with the local scored tracker and emits an
 * append-only ledger that Computer Use can execute as a narrow, reviewable
 * browser action.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeJackBoardCards } from './application-ingest.mjs';
import { normalizeJackJobUrl } from './jackandjill-lib.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_THRESHOLD = 4.0;
export const DEFAULT_BOARD_MAX_AGE_DAYS = 3;
export const LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_LEDGER_FILE = path.join(ROOT, 'data', 'jackandjill-archive-ledger.jsonl');
const ACTIVE_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer']);
const DISPOSED_STATUSES = new Set(['SKIP', 'Discarded']);
const BOARD_APPLICATION_STATUSES = new Set(['Applied', 'In Process', 'Offer', 'Interview']);

/** @param {unknown} value */
function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value */
function normalized(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** @param {unknown} value */
function roleIdentity(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @param {unknown} value */
function roleVariantIdentity(value) {
  return roleIdentity(value)
    .replace(/\b(?:new grad|entry level|junior|senior|staff|principal|lead|ii|iii|iv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {unknown} value */
function scoreValue(value) {
  const match = text(value).match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  if (!match) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) ? score : null;
}

/** @param {string} root */
export function configuredThreshold(root = ROOT) {
  const file = path.join(root, 'config', 'profile.yml');
  if (!existsSync(file)) return DEFAULT_THRESHOLD;
  const match = readFileSync(file, 'utf8').match(/^\s*apply_threshold:\s*(\d+(?:\.\d+)?)/m);
  const value = match ? Number(match[1]) : DEFAULT_THRESHOLD;
  return Number.isFinite(value) ? value : DEFAULT_THRESHOLD;
}

/** @param {Record<string, unknown>} card */
export function archiveSourceKey(card) {
  const sourceId = text(card.sourceId || card.id || card.jobId || card.reviewId);
  if (sourceId) return `jackandjill:id:${sourceId}`;
  const canonical = normalizeJackJobUrl(card.url || card.sourceUrl || card.canonicalUrl);
  if (canonical) return `jackandjill:url:${canonical}`;
  const company = normalized(card.company);
  const role = roleIdentity(card.role || card.title);
  return `jackandjill:card:${company}:${role}`;
}

/** @param {string} reportCell @param {string} root */
function reportFile(reportCell, root) {
  const match = text(reportCell).match(/\]\(([^)]+)\)/);
  if (!match) return '';
  const raw = match[1].trim();
  const candidate = raw.startsWith('../') ? path.resolve(root, 'data', raw) : path.resolve(root, raw);
  const reportsRoot = path.resolve(root, 'reports');
  return candidate.startsWith(`${reportsRoot}${path.sep}`) ? candidate : '';
}

/** @param {Record<string, unknown>} row @param {string} root */
function evidenceForRow(row, root) {
  const file = reportFile(text(row.report), root);
  if (file && existsSync(file)) {
    const content = readFileSync(file, 'utf8');
    const verification = content.match(/^\*\*Verification:\*\*\s*(.+)$/im)?.[1]?.trim() || '';
    if (/\bconfirmed\b|\bactive\b/i.test(verification)) {
      return { strength: 'report', verified: true, source: path.relative(root, file), verification };
    }
    return { strength: 'report', verified: false, source: path.relative(root, file), verification };
  }
  const notes = text(row.notes);
  if (/\bofficial\b.*\b(?:live|posting|accepting|closed|no longer accepting)\b/i.test(notes)) {
    return { strength: 'tracker-note', verified: true, source: 'data/applications.md', verification: notes };
  }
  return { strength: 'unknown', verified: false, source: '', verification: '' };
}

/** @param {string} root */
export function readTrackerRows(root = ROOT) {
  const file = path.join(root, 'data', 'applications.md');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean);
}

/** @param {string} root */
export function readBoardSnapshot(root = ROOT) {
  const file = path.join(root, 'data', 'jackandjill-board.json');
  if (!existsSync(file)) throw new Error(`Jack & Jill board snapshot is missing: ${file}`);
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Jack & Jill board snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { snapshot, cards: normalizeJackBoardCards(snapshot, text(snapshot.observedAt) || new Date().toISOString()) };
}

/** @param {string} root */
export function readBoardCards(root = ROOT) {
  return readBoardSnapshot(root).cards;
}

/** @param {Array<Record<string, unknown>>} rows @param {Record<string, unknown>} card */
function matchTrackerRow(rows, card) {
  const company = normalized(card.company);
  const role = roleIdentity(card.role || card.title);
  const candidates = rows.filter((row) => normalized(row.company) === company);
  const exact = candidates.filter((row) => roleIdentity(row.role) === role);
  if (exact.length === 1) return exact[0];
  const variant = candidates.filter((row) => roleVariantIdentity(row.role) === roleVariantIdentity(card.role || card.title));
  if (variant.length === 1) return variant[0];
  const fuzzy = candidates.filter((row) => roleFuzzyMatch(text(row.role), text(card.role || card.title)));
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

/** @param {Record<string, unknown>} item @param {{ threshold?: number, root?: string, ledgerEvents?: Array<Record<string, unknown>>, observedAt?: string }} [options] */
export function decideArchive(item, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const root = options.root || ROOT;
  const card = item.card || item;
  const row = item.trackerRow || null;
  const key = archiveSourceKey(/** @type {Record<string, unknown>} */ (card));
  const boardStatus = text(card.status || card.boardStatus);
  const company = text(card.company);
  const role = text(card.role || card.title);
  const base = {
    sourceKey: key,
    source: 'jackandjill',
    company,
    role,
    boardStatus,
    ...(text(card.ageText) ? { ageText: text(card.ageText) } : {}),
    ...(text(card.sourceUrl) ? { sourceUrl: text(card.sourceUrl) } : {}),
    ...(row ? {
      trackerNum: Number(row.num),
      trackerStatus: text(row.status),
      fitScore: scoreValue(row.score),
      trackerNotes: text(row.notes),
    } : {}),
  };

  if (BOARD_APPLICATION_STATUSES.has(boardStatus)) {
    return { ...base, decision: 'blocked', action: 'leave', reasonCodes: ['application-stage'], reasoning: `Board stage is ${boardStatus}; external archive is blocked for application or offer state.` };
  }
  if (!row) {
    return { ...base, decision: 'blocked', action: 'leave', reasonCodes: ['no-scored-evaluation'], reasoning: 'No unique local tracker evaluation matched this Jack & Jill card; do not archive an unscored finding.' };
  }
  const score = scoreValue(row.score);
  const status = text(row.status);
  if (score === null) {
    return { ...base, decision: 'blocked', action: 'leave', reasonCodes: ['missing-fit-score'], reasoning: 'The matched tracker row has no numeric fit score; do not infer threshold eligibility.' };
  }
  if (score >= threshold) {
    return { ...base, decision: 'retain', action: 'leave', reasonCodes: ['at-or-above-threshold'], reasoning: `Fit score ${score.toFixed(1)}/5 meets the ${threshold.toFixed(1)}/5 application threshold.` };
  }
  if (ACTIVE_STATUSES.has(status)) {
    return { ...base, decision: 'blocked', action: 'leave', reasonCodes: ['active-tracker-status'], reasoning: `Fit score ${score.toFixed(1)}/5 is below threshold, but tracker status is ${status}; preserve the active application state.` };
  }
  if (!DISPOSED_STATUSES.has(status)) {
    return { ...base, decision: 'blocked', action: 'leave', reasonCodes: ['tracker-not-disposed'], reasoning: `Fit score ${score.toFixed(1)}/5 is below threshold, but tracker status is ${status || 'blank'}; require an explicit SKIP or Discarded disposition first.` };
  }
  const evidence = evidenceForRow(row, root);
  if (!evidence.verified) {
    return { ...base, decision: 'blocked', action: 'leave', evidence, reasonCodes: ['official-posting-evidence-unresolved'], reasoning: 'The score is below threshold, but the official-posting evidence is not bound to a confirmed report or explicit tracker note.' };
  }
  return {
    ...base,
    decision: 'eligible',
    action: 'archive',
    evidence,
    threshold,
    reasonCodes: ['below-threshold', `tracker-status-${status.toLowerCase()}`],
    reasoning: `Fit score ${score.toFixed(1)}/5 is below the ${threshold.toFixed(1)}/5 threshold. ${text(row.notes) || `Tracker status is ${status}.`}`,
  };
}

/** @param {string} file */
export function readLedger(file = DEFAULT_LEDGER_FILE) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || parsed.schemaVersion !== LEDGER_SCHEMA_VERSION || !parsed.sourceKey) throw new Error('invalid ledger record');
      return parsed;
    } catch (error) {
      throw new Error(`Jack & Jill archive ledger line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** @param {Array<Record<string, unknown>>} events */
function latestByKey(events) {
  const latest = new Map();
  for (const event of events) latest.set(String(event.sourceKey), event);
  return latest;
}

/** @param {string} file @param {Array<Record<string, unknown>>} events */
export function appendLedgerEvents(file, events) {
  if (!events.length) return 0;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  return events.length;
}

/** @param {{ root?: string, threshold?: number, ledgerFile?: string, observedAt?: string, write?: boolean }} [options] */
export function buildArchivePlan(options = {}) {
  const root = options.root || ROOT;
  const threshold = options.threshold ?? configuredThreshold(root);
  const ledgerFile = options.ledgerFile || path.join(root, 'data', 'jackandjill-archive-ledger.jsonl');
  const observedAt = options.observedAt || new Date().toISOString();
  const events = readLedger(ledgerFile);
  const latest = latestByKey(events);
  const rows = readTrackerRows(root);
  const board = readBoardSnapshot(root);
  const boardObservedAt = text(board.snapshot.observedAt);
  const nowMs = Date.parse(observedAt);
  const boardMs = Date.parse(boardObservedAt);
  const boardFresh = Number.isFinite(nowMs) && Number.isFinite(boardMs)
    && nowMs >= boardMs
    && nowMs - boardMs <= DEFAULT_BOARD_MAX_AGE_DAYS * 86_400_000;
  if (!boardFresh) {
    const stale = {
      sourceKey: `jackandjill:snapshot:${boardObservedAt || 'unknown'}`,
      source: 'jackandjill',
      boardObservedAt: boardObservedAt || null,
      decision: 'blocked',
      action: 'leave',
      reasonCodes: ['stale-board-snapshot'],
      reasoning: `Board snapshot is stale or missing a valid observedAt; refresh the authenticated board before considering archive actions.`,
    };
    const ledgerEvents = options.write ? [{
      schemaVersion: LEDGER_SCHEMA_VERSION,
      eventType: 'decision',
      observedAt,
      fingerprint: decisionFingerprint(stale),
      externalAction: 'blocked',
      ...stale,
    }] : [];
    if (ledgerEvents.length) appendLedgerEvents(ledgerFile, ledgerEvents);
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      observedAt,
      threshold,
      ledgerFile,
      boardObservedAt: boardObservedAt || null,
      boardFresh: false,
      counts: { considered: 0, eligible: 0, blocked: 1, retained: 0 },
      pendingArchive: [],
      decisions: [stale],
      ledgerAppended: ledgerEvents.length,
    };
  }
  const cards = board.cards;
  const decisions = cards.map((card) => decideArchive({ card, trackerRow: matchTrackerRow(rows, card) }, { root, threshold, ledgerEvents: events, observedAt }));
  const closedExternalActions = new Set(['archived', 'blocked', 'left']);
  const pending = decisions.filter((decision) => decision.decision === 'eligible' && !closedExternalActions.has(latest.get(decision.sourceKey)?.externalAction));
  const ledgerEvents = options.write
    ? decisions
      .filter((decision) => {
        const previous = latest.get(decision.sourceKey);
        if (closedExternalActions.has(previous?.externalAction)) return false;
        return !previous || previous.fingerprint !== decisionFingerprint(decision);
      })
      .map((decision) => ({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        eventType: 'decision',
        observedAt,
        fingerprint: decisionFingerprint(decision),
        externalAction: decision.decision === 'eligible' ? 'pending' : decision.action === 'leave' ? 'blocked' : 'not-needed',
        ...decision,
      }))
    : [];
  if (ledgerEvents.length) appendLedgerEvents(ledgerFile, ledgerEvents);
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    observedAt,
    threshold,
    ledgerFile,
    boardObservedAt,
    boardFresh: true,
    counts: {
      considered: decisions.length,
      eligible: pending.length,
      blocked: decisions.filter((decision) => decision.decision === 'blocked').length,
      retained: decisions.filter((decision) => decision.decision === 'retain').length,
    },
    pendingArchive: pending,
    decisions,
    ledgerAppended: ledgerEvents.length,
  };
}

/** @param {Record<string, unknown>} decision */
function decisionFingerprint(decision) {
  return [decision.sourceKey, decision.decision, decision.trackerNum || '', decision.fitScore ?? '', decision.boardStatus, ...(Array.isArray(decision.reasonCodes) ? decision.reasonCodes : [])].join('|');
}

/** @param {{ ledgerFile?: string, sourceKey: string, outcome: string, observedAt?: string, note?: string }} options */
export function recordArchiveOutcome(options) {
  const ledgerFile = options.ledgerFile || DEFAULT_LEDGER_FILE;
  const events = readLedger(ledgerFile);
  const latest = latestByKey(events).get(options.sourceKey);
  if (!latest) throw new Error(`no archive decision exists for source key: ${options.sourceKey}`);
  if (options.outcome === 'archived' && latest.externalAction !== 'pending') {
    throw new Error(`source key is not pending archive; latest ledger action is ${latest.externalAction}`);
  }
  const event = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    eventType: 'external-outcome',
    observedAt: options.observedAt || new Date().toISOString(),
    sourceKey: options.sourceKey,
    company: latest.company,
    role: latest.role,
    trackerNum: latest.trackerNum,
    fitScore: latest.fitScore,
    threshold: latest.threshold,
    decision: latest.decision,
    externalAction: options.outcome,
    ...(text(options.note) ? { note: text(options.note) } : {}),
  };
  appendLedgerEvents(ledgerFile, [event]);
  return event;
}

/** @param {string[]} args */
function parseArgs(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) continue;
    const equals = value.indexOf('=');
    if (equals > 2) { flags.set(value.slice(2, equals), value.slice(equals + 1)); continue; }
    const name = value.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith('--')) { flags.set(name, next); index += 1; }
    else flags.set(name, true);
  }
  return flags;
}

/** @param {Map<string, string|boolean>} flags @param {string} name @param {string} fallback */
function flag(flags, name, fallback = '') {
  const value = flags.get(name);
  return value === undefined || value === true ? fallback : String(value);
}

/** @param {string[]} args */
export async function main(args = []) {
  const command = args[0] || 'plan';
  const flags = parseArgs(args.slice(1));
  const root = flag(flags, 'root', ROOT);
  const ledgerFile = flag(flags, 'ledger', path.join(root, 'data', 'jackandjill-archive-ledger.jsonl'));
  if (command === 'plan') {
    const rawThreshold = flag(flags, 'threshold');
    const threshold = rawThreshold ? Number(rawThreshold) : configuredThreshold(root);
    return buildArchivePlan({ root, ledgerFile, threshold, write: flags.get('write') === true });
  }
  if (command === 'record') {
    const sourceKey = flag(flags, 'key');
    const outcome = flag(flags, 'outcome');
    if (!sourceKey || !outcome) throw new Error('Usage: node jackandjill-archive.mjs record --key <source-key> --outcome archived|blocked|left');
    return recordArchiveOutcome({ ledgerFile, sourceKey, outcome, note: flag(flags, 'note') });
  }
  if (command === 'ledger') return { schemaVersion: LEDGER_SCHEMA_VERSION, ledgerFile, records: readLedger(ledgerFile) };
  throw new Error(`Unknown command: ${command}. Use plan, record, or ledger.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
