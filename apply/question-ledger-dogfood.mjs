#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readQueueState, stableQueueId, normalizeUrl } from '../queue-lib.mjs';
import { buildApplicationPacket } from './application-packets.mjs';
import { applicationAdapter, normalizeApplicationUrl } from './form-inspection.mjs';
import {
  DEFAULT_LEDGER_PATH,
  loadLedger,
  pendingQuestions,
  saveLedger,
} from './question-ledger.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');
export const DEFAULT_PACKET_ROOT = path.join(ROOT, 'output', 'application-packets');
export const DEFAULT_SAMPLE_SIZE = 12;
export const MAX_SAMPLE_SIZE = 40;
export const DEFAULT_MIN_DESCRIPTION_LENGTH = 120;

const SUPPORTED_ADAPTERS = new Set(['ashby', 'greenhouse', 'lever']);
const DEFAULT_STATUSES = ['in_review', 'ready'];
const EXCLUDED_STATUSES = new Set(['excluded', 'discarded', 'stale', 'archived']);
const TERMINAL_APPLICATION_STATES = new Set([
  'applied',
  'submitted',
  'submission_unknown',
  'blocked_by_antispam',
  'rejected',
]);

/** @typedef {Record<string, unknown>} QueueItem */

/**
 * @typedef {object} DogfoodCandidate
 * @property {QueueItem} item
 * @property {string} id
 * @property {string} adapter
 * @property {string} url
 * @property {string} status
 * @property {string} liveness
 * @property {number} descriptionLength
 * @property {boolean} descriptionNeedsHydration
 * @property {number|null} fitScore
 * @property {string[]} reasons
 * @property {string[]} verificationWarnings
 * @property {boolean} eligible
 */

/**
 * @typedef {object} DogfoodSelectionOptions
 * @property {boolean} [shapeOnly]
 * @property {number} [sampleSize]
 * @property {number|null} [perAdapter]
 * @property {number} [minDescriptionLength]
 * @property {number} [minFitScore]
 * @property {string[]} [statuses]
 */

/**
 * @typedef {object} DogfoodPlan
 * @property {string} mode
 * @property {boolean} shapeOnly
 * @property {QueueItem[]} sourceItems
 * @property {DogfoodCandidate[]} classifications
 * @property {DogfoodCandidate[]} eligible
 * @property {DogfoodCandidate[]} selected
 * @property {Record<string, number>} sourceByStatus
 * @property {Record<string, number>} sourceByAdapter
 * @property {Record<string, number>} sourceByLiveness
 * @property {Record<string, number>} reasonCounts
 * @property {Record<string, number>} verificationWarningCounts
 * @property {{ sampleSize: number, perAdapter: number|null, minDescriptionLength: number, minFitScore: number, statuses: string[] }} policy
 */

/** @param {unknown} value */
function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

/** @param {unknown} value */
function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {Record<string, number>} counts @param {string} key */
function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

/** @param {QueueItem} item */
function applicationUrlForItem(item) {
  const raw = item.applyUrl || item.canonicalUrl || item.url || '';
  return normalizeApplicationUrl(normalizeUrl(String(raw || '')));
}

/** @param {QueueItem} item @param {string} url */
function idForItem(item, url) {
  const id = normalizedText(item.id);
  return id || stableQueueId({
    canonicalUrl: normalizeUrl(url),
    company: normalizedText(item.company),
    title: normalizedText(item.title),
  });
}

/** @param {unknown} value @param {number} fallback */
function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** @param {DogfoodSelectionOptions} options */
function selectionPolicy(options = {}) {
  const requestedSample = Math.max(0, Math.floor(finiteNumber(options.sampleSize, DEFAULT_SAMPLE_SIZE)));
  const sampleSize = Math.min(MAX_SAMPLE_SIZE, requestedSample);
  const requestedPerAdapter = options.perAdapter === null || options.perAdapter === undefined
    ? null
    : Math.max(1, Math.floor(finiteNumber(options.perAdapter, 1)));
  return {
    shapeOnly: options.shapeOnly === true,
    sampleSize,
    perAdapter: requestedPerAdapter,
    minDescriptionLength: Math.max(0, Math.floor(finiteNumber(options.minDescriptionLength, DEFAULT_MIN_DESCRIPTION_LENGTH))),
    minFitScore: finiteNumber(options.minFitScore, 0),
    statuses: (Array.isArray(options.statuses) && options.statuses.length ? options.statuses : DEFAULT_STATUSES)
      .map(normalized)
      .filter(Boolean),
  };
}

/** @param {QueueItem} item @param {DogfoodSelectionOptions} [options] @returns {DogfoodCandidate} */
export function classifyQueueItem(item, options = {}) {
  const policy = selectionPolicy(options);
  const status = normalized(item.status) || 'missing';
  const applicationState = normalized(item.applicationState || item.applicationStatus || item.outcome);
  const url = applicationUrlForItem(item);
  const adapter = applicationAdapter(url);
  const liveness = normalized(item.liveness) || 'unknown';
  const descriptionLength = normalizedText(item.description).length;
  const rawFitScore = Number(item.fitScore);
  const fitScore = Number.isFinite(rawFitScore) ? rawFitScore : null;
  const reasons = [];
  const verificationWarnings = [];
  const descriptionNeedsHydration = descriptionLength < policy.minDescriptionLength;

  if (EXCLUDED_STATUSES.has(status)) reasons.push(`status-${status}`);
  else if (!policy.statuses.includes(status)) reasons.push('status-not-selected');
  if (TERMINAL_APPLICATION_STATES.has(applicationState)) reasons.push(`application-state-${applicationState}`);
  if (!url) reasons.push('missing-application-url');
  else if (!SUPPORTED_ADAPTERS.has(adapter)) reasons.push('unsupported-adapter');
  if (!normalizedText(item.title)) reasons.push('missing-title');
  if (policy.minFitScore > 0 && (fitScore === null || fitScore < policy.minFitScore)) reasons.push('fit-score-below-threshold');

  if (liveness !== 'active') verificationWarnings.push(`liveness-${liveness}`);
  if (descriptionNeedsHydration) {
    verificationWarnings.push(descriptionLength === 0 ? 'missing-description' : 'description-too-short');
  }

  if (!policy.shapeOnly) {
    if (liveness !== 'active') reasons.push(`liveness-${liveness}`);
    if (descriptionNeedsHydration && !SUPPORTED_ADAPTERS.has(adapter)) {
      reasons.push(descriptionLength === 0 ? 'missing-description' : 'description-too-short');
    }
  }
  return {
    item,
    id: idForItem(item, url),
    adapter,
    url,
    status,
    liveness,
    descriptionLength,
    descriptionNeedsHydration,
    fitScore,
    reasons,
    verificationWarnings,
    eligible: reasons.length === 0,
  };
}

/** @param {DogfoodCandidate[]} candidates @param {DogfoodSelectionOptions} [options] @returns {DogfoodCandidate[]} */
export function selectDogfoodSample(candidates, options = {}) {
  const policy = selectionPolicy(options);
  const buckets = new Map();
  for (const candidate of candidates) {
    if (!candidate.eligible) continue;
    const bucket = buckets.get(candidate.adapter) || [];
    bucket.push(candidate);
    buckets.set(candidate.adapter, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const scoreDifference = (b.fitScore ?? -Infinity) - (a.fitScore ?? -Infinity);
      return scoreDifference || a.id.localeCompare(b.id);
    });
    if (policy.perAdapter !== null) bucket.splice(policy.perAdapter);
  }

  const adapters = [...buckets.keys()].sort();
  const selected = [];
  let index = 0;
  while (selected.length < policy.sampleSize && adapters.length) {
    let added = false;
    for (const adapter of adapters) {
      const candidate = buckets.get(adapter)?.[index];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length >= policy.sampleSize) break;
    }
    if (!added) break;
    index += 1;
  }
  return selected;
}

/** @param {QueueItem[]} items @param {DogfoodSelectionOptions} [options] @returns {DogfoodPlan} */
export function buildDogfoodPlan(items, options = {}) {
  const policy = selectionPolicy(options);
  const sourceItems = Array.isArray(items) ? items.filter((item) => item && typeof item === 'object') : [];
  const classifications = sourceItems.map((item) => classifyQueueItem(item, policy));
  const eligible = classifications.filter((candidate) => candidate.eligible);
  const selected = selectDogfoodSample(eligible, policy);
  const sourceByStatus = {};
  const sourceByAdapter = {};
  const sourceByLiveness = {};
  const reasonCounts = {};
  const verificationWarningCounts = {};
  for (const candidate of classifications) {
    increment(sourceByStatus, candidate.status);
    increment(sourceByAdapter, candidate.adapter);
    increment(sourceByLiveness, candidate.liveness);
    for (const reason of candidate.reasons) increment(reasonCounts, reason);
    for (const warning of candidate.verificationWarnings) increment(verificationWarningCounts, warning);
  }
  return {
    mode: 'plan',
    shapeOnly: policy.shapeOnly,
    sourceItems,
    classifications,
    eligible,
    selected,
    sourceByStatus,
    sourceByAdapter,
    sourceByLiveness,
    reasonCounts,
    verificationWarningCounts,
    policy,
  };
}

/** @param {string} candidate @param {string} protectedPath */
function isSameOrInside(candidate, protectedPath) {
  const relative = path.relative(path.resolve(protectedPath), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** @param {{ stagingRoot?: string }} [options] @returns {{ root: string, ledgerPath: string, outputRoot: string }} */
export function resolveDogfoodStaging(options = {}) {
  const root = options.stagingRoot
    ? path.resolve(options.stagingRoot)
    : mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-dogfood-'));
  const ledgerPath = path.join(root, 'question-ledger.json');
  const outputRoot = path.join(root, 'application-packets');
  const protectedPaths = [
    DEFAULT_LEDGER_PATH,
    DEFAULT_PACKET_ROOT,
    path.join(ROOT, 'data'),
    path.join(ROOT, 'output'),
  ];
  if (protectedPaths.some((protectedPath) => isSameOrInside(root, protectedPath))) {
    throw new Error(`staging root must stay outside canonical Career Ops data/output paths: ${root}`);
  }
  if (isSameOrInside(ledgerPath, DEFAULT_LEDGER_PATH) || isSameOrInside(outputRoot, DEFAULT_PACKET_ROOT)) {
    throw new Error('staging paths must not overlap the canonical question ledger or packet output');
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  return { root, ledgerPath, outputRoot };
}

/** @param {{ entries?: Array<Record<string, unknown>> }} ledger */
function ledgerStats(ledger) {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const stats = { total: entries.length, confirmed: 0, unconfirmed: 0, unanswered: 0, pendingGroups: 0 };
  for (const entry of entries) {
    const status = normalized(entry.answerStatus) || 'unanswered';
    if (status === 'confirmed') stats.confirmed += 1;
    else if (status === 'unconfirmed') stats.unconfirmed += 1;
    else stats.unanswered += 1;
  }
  stats.pendingGroups = pendingQuestions(ledger).length;
  return stats;
}

/** @param {{ entries?: Array<Record<string, unknown>> }} before @param {{ entries?: Array<Record<string, unknown>> }} after */
export function summarizeLedgerDelta(before, after) {
  const beforeEntries = Array.isArray(before.entries) ? before.entries : [];
  const afterEntries = Array.isArray(after.entries) ? after.entries : [];
  const beforeById = new Map(beforeEntries.map((entry) => [String(entry.id || ''), JSON.stringify(entry)]));
  let updatedEntries = 0;
  let unchangedExistingEntries = 0;
  let newEntries = 0;
  for (const entry of afterEntries) {
    const id = String(entry.id || '');
    const previous = beforeById.get(id);
    if (previous === undefined) newEntries += 1;
    else if (previous === JSON.stringify(entry)) unchangedExistingEntries += 1;
    else updatedEntries += 1;
  }
  return {
    newEntries,
    updatedEntries,
    unchangedExistingEntries,
    entryCountDelta: afterEntries.length - beforeEntries.length,
  };
}

/** @param {DogfoodCandidate} candidate */
function publicCandidate(candidate) {
  return {
    id: candidate.id,
    adapter: candidate.adapter,
    url: candidate.url,
    company: normalizedText(candidate.item.company),
    title: normalizedText(candidate.item.title),
    status: candidate.status,
    liveness: candidate.liveness,
    descriptionLength: candidate.descriptionLength,
    descriptionNeedsHydration: candidate.descriptionNeedsHydration,
    fitScore: candidate.fitScore,
    verificationWarnings: candidate.verificationWarnings,
  };
}

/** @param {DogfoodPlan} plan */
function publicPlan(plan) {
  return {
    shapeOnly: plan.shapeOnly,
    sourceQueueCount: plan.sourceItems.length,
    sourceByStatus: plan.sourceByStatus,
    sourceByAdapter: plan.sourceByAdapter,
    sourceByLiveness: plan.sourceByLiveness,
    eligibleCount: plan.eligible.length,
    sampleCount: plan.selected.length,
    sample: plan.selected.map(publicCandidate),
    preflight: {
      blockingReasonCounts: plan.reasonCounts,
      verificationWarningCounts: plan.verificationWarningCounts,
    },
    policy: plan.policy,
  };
}

/** @param {unknown} result @param {DogfoodCandidate} candidate */
function summarizePacketResult(result, candidate) {
  const record = result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
  const questions = Array.isArray(record.questions) ? record.questions : [];
  const unresolved = Array.isArray(record.unresolved) ? record.unresolved : [];
  const warnings = Array.isArray(record.warnings) ? record.warnings.map(String) : [];
  return {
    id: candidate.id,
    adapter: candidate.adapter,
    url: candidate.url,
    company: normalizedText(candidate.item.company),
    title: normalizedText(candidate.item.title),
    ok: record.ok === true,
    status: normalized(record.status) || (record.ok === false ? 'error' : 'unknown'),
    questionCount: questions.length,
    unresolvedCount: unresolved.length,
    requiredUnresolvedCount: unresolved.filter((question) => question && question.required === true).length,
    descriptionLength: Number(record.target && typeof record.target === 'object' ? record.target.descriptionLength : 0) || 0,
    descriptionSource: record.target && typeof record.target === 'object'
      ? normalizedText(record.target.descriptionSource)
      : '',
    pendingGroups: Number(record.ledger && typeof record.ledger === 'object' ? record.ledger.pendingGroups : 0) || 0,
    warnings: warnings.slice(0, 8),
    reason: normalizedText(record.reason),
    packetPath: record.paths && typeof record.paths === 'object'
      ? normalizedText(record.paths.json)
      : '',
  };
}

/** @param {string} file */
function fileHash(file) {
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Run or plan a bounded question-ledger dogfood pass. The default run copies
 * the canonical ledger into a staging root and never writes back to it.
 * @param {{ mode?: 'plan'|'run', shapeOnly?: boolean, queuePath?: string, sourceLedgerPath?: string, stagingRoot?: string, sampleSize?: number, perAdapter?: number|null, minDescriptionLength?: number, minFitScore?: number, statuses?: string[], browser?: string, headed?: boolean, cdpEndpoint?: string, profilePath?: string, maxPages?: number, buildPacket?: typeof buildApplicationPacket }} [options]
 * @returns {Promise<{ report: Record<string, unknown>, plan: DogfoodPlan }>}
 */
export async function runLedgerDogfood(options = {}) {
  const mode = options.mode === 'run' ? 'run' : 'plan';
  const queuePath = path.resolve(options.queuePath || DEFAULT_QUEUE_PATH);
  const sourceLedgerPath = path.resolve(options.sourceLedgerPath || DEFAULT_LEDGER_PATH);
  const queueState = readQueueState(queuePath);
  const items = Array.isArray(queueState.items)
    ? queueState.items.filter((item) => item && typeof item === 'object')
    : [];
  const plan = buildDogfoodPlan(items, options);
  const sourceQueueHashBefore = fileHash(queuePath);
  const sourceLedgerHashBefore = fileHash(sourceLedgerPath);
  const report = {
    schemaVersion: 1,
    type: 'application-question-ledger-dogfood',
    generatedAt: new Date().toISOString(),
    mode,
    verificationMode: plan.shapeOnly ? 'shape-only-unverified' : 'active-posting-required',
    queuePath,
    sourceLedgerPath,
    ...publicPlan(plan),
    staging: {
      root: null,
      ledgerPath: null,
      outputRoot: null,
      canonicalQueueTouched: false,
      canonicalLedgerTouched: false,
      canonicalOutputTouched: false,
    },
    runs: [],
    ledger: {
      before: null,
      after: null,
      delta: null,
    },
    safety: {
      browserActions: 'read-only form inspection; no fill, select, upload, apply, submit, or send',
      promotion: 'staging ledger is never promoted automatically',
      sampleCap: MAX_SAMPLE_SIZE,
    },
  };

  if (mode !== 'run' || plan.selected.length === 0) {
    report.warnings = mode === 'run' && plan.selected.length === 0
      ? ['No queue items passed the selected dogfood preflight; no staging files were created.']
      : ['Plan mode is read-only; no browser was opened and no files were written.'];
    return { report, plan };
  }

  const staging = resolveDogfoodStaging({ stagingRoot: options.stagingRoot });
  const before = loadLedger(sourceLedgerPath);
  saveLedger(staging.ledgerPath, before);
  report.staging = {
    root: staging.root,
    ledgerPath: staging.ledgerPath,
    outputRoot: staging.outputRoot,
    canonicalQueueTouched: false,
    canonicalLedgerTouched: false,
    canonicalOutputTouched: false,
  };
  report.ledger.before = ledgerStats(before);
  const buildPacket = options.buildPacket || buildApplicationPacket;
  const runs = [];
  for (const candidate of plan.selected) {
    try {
      const result = await buildPacket(candidate.item, {
        browser: options.browser,
        headed: options.headed === true,
        cdpEndpoint: options.cdpEndpoint,
        ledgerPath: staging.ledgerPath,
        profilePath: options.profilePath,
        outputRoot: staging.outputRoot,
        generateArtifacts: false,
        generateCoverLetter: false,
        dryRun: false,
        maxPages: options.maxPages,
      });
      runs.push(summarizePacketResult(result, candidate));
    } catch (error) {
      runs.push({
        id: candidate.id,
        adapter: candidate.adapter,
        url: candidate.url,
        company: normalizedText(candidate.item.company),
        title: normalizedText(candidate.item.title),
        ok: false,
        status: 'error',
        questionCount: 0,
        unresolvedCount: 0,
        requiredUnresolvedCount: 0,
        pendingGroups: 0,
        warnings: [],
        reason: error instanceof Error ? error.message : String(error),
        packetPath: '',
      });
    }
  }
  const after = loadLedger(staging.ledgerPath);
  report.runs = runs;
  report.ledger.after = ledgerStats(after);
  report.ledger.delta = {
    ...summarizeLedgerDelta(before, after),
    observedQuestionCount: runs.reduce((total, run) => total + Number(run.questionCount || 0), 0),
  };
  report.sourceQueueHashBefore = sourceQueueHashBefore;
  report.sourceQueueHashAfter = fileHash(queuePath);
  report.sourceLedgerHashBefore = sourceLedgerHashBefore;
  report.sourceLedgerHashAfter = fileHash(sourceLedgerPath);
  report.warnings = plan.shapeOnly
    ? ['Shape-only mode intentionally sampled postings without active/liveness/JD verification; do not use these results as ready application evidence.', 'Review staged entries before any manual promotion.']
    : ['Review staged entries before any manual promotion.'];
  return { report, plan };
}

/** @param {string[]} argv @returns {Record<string, unknown>} */
function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      'shape-only': { type: 'boolean', default: false },
      sample: { type: 'string' },
      'per-adapter': { type: 'string' },
      'min-description-length': { type: 'string' },
      'min-fit-score': { type: 'string' },
      statuses: { type: 'string' },
      queue: { type: 'string' },
      'source-ledger': { type: 'string' },
      'staging-root': { type: 'string' },
      browser: { type: 'string' },
      headed: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      'cdp-endpoint': { type: 'string' },
      profile: { type: 'string' },
      'max-pages': { type: 'string' },
    },
  });
  if (values.run === true && values.plan === true) throw new Error('choose --run or --plan, not both');
  if (values.headed === true && values.headless === true) throw new Error('choose --headed or --headless, not both');
  const sampleSize = values.sample === undefined ? DEFAULT_SAMPLE_SIZE : finiteNumber(values.sample, NaN);
  if (!Number.isFinite(sampleSize) || sampleSize < 0) throw new Error('--sample must be a non-negative number');
  const perAdapter = values['per-adapter'] === undefined ? null : finiteNumber(values['per-adapter'], NaN);
  if (perAdapter !== null && (!Number.isFinite(perAdapter) || perAdapter < 1)) throw new Error('--per-adapter must be a positive number');
  const minDescriptionLength = values['min-description-length'] === undefined
    ? DEFAULT_MIN_DESCRIPTION_LENGTH
    : finiteNumber(values['min-description-length'], NaN);
  if (!Number.isFinite(minDescriptionLength) || minDescriptionLength < 0) throw new Error('--min-description-length must be non-negative');
  const minFitScore = values['min-fit-score'] === undefined ? 0 : finiteNumber(values['min-fit-score'], NaN);
  if (!Number.isFinite(minFitScore) || minFitScore < 0) throw new Error('--min-fit-score must be non-negative');
  const maxPages = values['max-pages'] === undefined ? undefined : finiteNumber(values['max-pages'], NaN);
  if (maxPages !== undefined && (!Number.isFinite(maxPages) || maxPages < 1)) throw new Error('--max-pages must be positive');
  const statuses = values.statuses
    ? String(values.statuses).split(',').map(normalized).filter(Boolean)
    : undefined;
  return {
    mode: values.run === true ? 'run' : 'plan',
    shapeOnly: values['shape-only'] === true,
    sampleSize,
    perAdapter,
    minDescriptionLength,
    minFitScore,
    statuses,
    queuePath: values.queue,
    sourceLedgerPath: values['source-ledger'],
    stagingRoot: values['staging-root'],
    browser: values.browser,
    headed: values.headed === true && values.headless !== true,
    cdpEndpoint: values['cdp-endpoint'],
    profilePath: values.profile,
    maxPages,
  };
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  try {
    const { report } = await runLedgerDogfood(parseCli(process.argv.slice(2)));
    console.log(`CAREER_OPS_LEDGER_DOGFOOD ${JSON.stringify(report)}`);
  } catch (error) {
    console.error(`CAREER_OPS_LEDGER_DOGFOOD_ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
