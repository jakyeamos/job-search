// @ts-check

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  canonicalQuestionKey,
  findQuestionMatch,
  findReusableAnswer,
  isSensitiveQuestion,
  loadLedger,
  questionId,
} from './apply/question-ledger.mjs';
import {
  classifyQuestionVisibility,
  hasVisibleQuestionReviews,
} from './apply/question-visibility.mjs';
import {
  normalizeChoiceFollowUpLabel,
  normalizeChoiceOptions,
} from './apply/lib/choice-shape.mjs';
import { normalizeUrl } from './queue-lib.mjs';

const EASTERN_TIME_ZONE = 'America/New_York';
const DEFAULT_HEALTH_URL = 'http://127.0.0.1:47831/api/health';

export const QUESTION_PROPAGATION_SOURCE_FILES = [
  'queue-ui.mjs',
  'application-handoff.mjs',
  'application-queue.mjs',
  'apply/lib/adapter-core.mjs',
  'apply/lib/choice-shape.mjs',
  'apply/question-ledger.mjs',
  'apply/question-visibility.mjs',
];

function validDate(value) {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date : null;
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return represented - date.getTime();
}

function easternDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function easternDayStart(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return null;
  const utcGuess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let instant = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess), EASTERN_TIME_ZONE));
  instant = new Date(utcGuess - timeZoneOffsetMs(instant, EASTERN_TIME_ZONE));
  return instant;
}

/**
 * @param {string | Date | null | undefined} value
 * @param {Date} [now]
 */
export function resolveQuestionWindow(value, now = new Date()) {
  if (value === null) return { since: null, source: 'all-history', label: 'all recorded observations' };
  if (value instanceof Date) {
    if (!validDate(value)) throw new Error('invalid --since value');
    return { since: value.toISOString(), source: 'explicit', label: `since ${value.toISOString()}` };
  }
  const raw = String(value || '').trim();
  if (!raw) {
    const dateKey = easternDateKey(now);
    const start = easternDayStart(dateKey);
    return {
      since: start?.toISOString() || null,
      source: `today-${EASTERN_TIME_ZONE}`,
      label: `${dateKey} (${EASTERN_TIME_ZONE})`,
    };
  }
  const dayStart = easternDayStart(raw);
  if (dayStart) return { since: dayStart.toISOString(), source: 'explicit-date', label: `${raw} (${EASTERN_TIME_ZONE})` };
  const parsed = validDate(raw);
  if (!parsed) throw new Error(`invalid --since value "${raw}"; use YYYY-MM-DD or an ISO timestamp`);
  return { since: parsed.toISOString(), source: 'explicit', label: `since ${parsed.toISOString()}` };
}

/** @param {string} root */
export function collectQuestionPropagationSources(root) {
  const files = [];
  const errors = [];
  for (const relativePath of QUESTION_PROPAGATION_SOURCE_FILES) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    try {
      const stats = statSync(absolutePath);
      files.push({ path: relativePath, modifiedAt: stats.mtime.toISOString(), mtimeMs: stats.mtimeMs });
    } catch (error) {
      errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const newest = [...files].sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null;
  return {
    files: files.map(({ mtimeMs: _mtimeMs, ...file }) => file),
    newest: newest ? { path: newest.path, modifiedAt: newest.modifiedAt } : null,
    errors,
  };
}

/**
 * Parse BSD/GNU `ps -axo pid=,lstart=,command=` output without invoking a shell.
 * @param {string} output
 * @param {string} root
 */
export function parseQueueUiProcesses(output, root) {
  const expectedScript = path.join(root, 'queue-ui.mjs');
  return String(output || '').split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match || !match[3].includes(expectedScript) || !/(?:^|\s)--serve(?:\s|$)/.test(match[3])) return [];
    const started = validDate(match[2]);
    return [{ pid: Number(match[1]), startedAt: started?.toISOString() || null }];
  });
}

function readProcessTable() {
  return execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,lstart=,command='], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function readHealth(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
    const payload = await response.json();
    if (payload?.service !== 'career-ops-queue-ui') return { reachable: false, error: 'unexpected health response' };
    return { reachable: true, payload };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {{
 *   root: string,
 *   sources: ReturnType<typeof collectQuestionPropagationSources>,
 *   healthUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   processTableReader?: () => string,
 * }} options
 */
export async function inspectQueueUiService(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const health = typeof fetchImpl === 'function'
    ? await readHealth(options.healthUrl || DEFAULT_HEALTH_URL, fetchImpl)
    : { reachable: false, error: 'fetch is unavailable' };
  let processes = [];
  let processInspection = 'available';
  let processError = null;
  try {
    const output = (options.processTableReader || readProcessTable)();
    processes = parseQueueUiProcesses(output, options.root);
  } catch (error) {
    processInspection = 'unavailable';
    processError = error instanceof Error ? error.message : String(error);
  }

  const running = health.reachable || processes.length > 0;
  const healthStartedAt = validDate(health.payload?.startedAt)?.toISOString() || null;
  const processStartedAt = [...processes]
    .map((process) => process.startedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const startedAt = healthStartedAt || processStartedAt;
  const newestSourceAt = options.sources.newest?.modifiedAt || null;
  const predatesSource = startedAt && newestSourceAt
    ? Date.parse(startedAt) < Date.parse(newestSourceAt)
    : null;
  const freshness = !running
    ? processInspection === 'available' ? 'not-running' : 'unknown'
    : predatesSource === true ? 'stale'
      : predatesSource === false ? 'current'
        : 'unknown';
  return {
    running,
    freshness,
    predatesSource,
    startedAt,
    startedAtSource: healthStartedAt ? 'health-api' : processStartedAt ? 'process-table' : null,
    pids: processes.map((process) => process.pid),
    health: {
      reachable: health.reachable,
      exposesStartedAt: Boolean(healthStartedAt),
      error: health.reachable ? null : health.error,
    },
    processInspection,
    processError,
    newestSource: options.sources.newest,
    sourceFiles: options.sources.files,
  };
}

function normalizedReviewLabel(review) {
  return normalizeChoiceFollowUpLabel(String(review?.label || '').replace(/^EEO:\s*/i, ''));
}

function queueItemsForContext(items, context) {
  const queueId = String(context?.queueId || '');
  if (queueId) {
    const exact = items.find((item) => String(item?.id || '') === queueId);
    if (exact) return [exact];
  }
  const contextUrl = normalizeUrl(context?.url || '');
  if (contextUrl) {
    const matches = items.filter((item) => normalizeUrl(item?.applyUrl || item?.canonicalUrl || '') === contextUrl);
    if (matches.length) return matches;
  }
  const company = String(context?.company || '').trim().toLowerCase();
  const role = String(context?.role || '').trim().toLowerCase();
  if (!company || !role) return [];
  return items.filter((item) => String(item?.company || '').trim().toLowerCase() === company
    && String(item?.title || '').trim().toLowerCase() === role);
}

function reviewMatchesEntry(review, entry, ledger) {
  const label = normalizedReviewLabel(review);
  if (!label) return false;
  if (questionId(label) === entry.id) return true;
  if (canonicalQuestionKey(label) === canonicalQuestionKey(String(entry.question || ''))) return true;
  const match = findQuestionMatch(label, ledger, {
    fieldKind: String(review?.kind || review?.fieldKind || ''),
    options: normalizeChoiceOptions(review?.options),
    sensitivity: isSensitiveQuestion(label) ? 'high' : 'normal',
  });
  return match?.entry?.id === entry.id;
}

function inspectOccurrence(entry, context, ledger, queueItems, queueAvailable) {
  if (!queueAvailable) return { projected: null, persisted: null, reason: 'queue-evidence-unavailable' };
  const candidates = queueItemsForContext(queueItems, context);
  if (!candidates.length) return { projected: false, persisted: false, reason: 'queue-item-missing' };
  const persistedItems = candidates.filter((item) => (Array.isArray(item.applicationResult?.needsReview)
    ? item.applicationResult.needsReview
    : []).some((review) => reviewMatchesEntry(review, entry, ledger)));
  if (!persistedItems.length) return { projected: false, persisted: false, reason: 'needs-review-missing' };
  if (!persistedItems.some(hasVisibleQuestionReviews)) {
    return { projected: false, persisted: true, reason: 'ui-state-ineligible' };
  }
  return { projected: true, persisted: true, reason: null };
}

function contextIdentity(context) {
  return [context?.queueId, context?.company, context?.role, normalizeUrl(context?.url || '')]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('|');
}

/**
 * Pure correlation step used by both fixtures and the live command.
 * @param {{
 *   ledger: { entries?: Array<Record<string, unknown>> },
 *   queue: { items?: Array<Record<string, unknown>> },
 *   window: ReturnType<typeof resolveQuestionWindow>,
 *   service: Record<string, unknown>,
 *   queueAvailable?: boolean,
 *   evidenceErrors?: string[],
 *   generatedAt?: string,
 * }} options
 */
export function analyzeQuestionPropagation(options) {
  const ledger = typeof structuredClone === 'function'
    ? structuredClone(options.ledger || { entries: [] })
    : JSON.parse(JSON.stringify(options.ledger || { entries: [] }));
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const queueItems = Array.isArray(options.queue?.items) ? options.queue.items : [];
  const queueAvailable = options.queueAvailable !== false;
  const sinceMs = options.window.since ? Date.parse(options.window.since) : null;
  const relevant = entries.flatMap((entry) => {
    const contexts = (Array.isArray(entry.contexts) ? entry.contexts : []).filter((context) => {
      if (sinceMs === null) return true;
      const recordedAt = Date.parse(String(context?.recordedAt || ''));
      return Number.isFinite(recordedAt) && recordedAt >= sinceMs;
    });
    return contexts.length ? [{ entry, contexts }] : [];
  });

  const answerable = [];
  const humanOnly = [];
  const informational = [];
  const alreadyAnswered = [];
  const roleKeys = new Set();
  const queueIds = new Set();
  let observations = 0;

  for (const { entry, contexts } of relevant) {
    observations += contexts.length;
    for (const context of contexts) {
      roleKeys.add([context.company, context.role].map((value) => String(value || '').trim().toLowerCase()).join('|'));
      if (context.queueId) queueIds.add(String(context.queueId));
    }
    const visibility = classifyQuestionVisibility(String(entry.question || ''));
    const base = {
      id: String(entry.id || questionId(String(entry.question || ''))),
      question: String(entry.question || ''),
      required: entry.required === true || contexts.some((context) => context.required === true),
      sensitivity: String(entry.sensitivity || (isSensitiveQuestion(String(entry.question || '')) ? 'high' : 'normal')),
      observationCount: contexts.length,
      queueIds: [...new Set(contexts.map((context) => String(context.queueId || '')).filter(Boolean))],
    };
    if (visibility.category === 'human-only') {
      humanOnly.push({ ...base, reason: visibility.reason });
      continue;
    }
    if (visibility.category !== 'answerable') {
      informational.push({ ...base, reason: visibility.reason });
      continue;
    }

    const unresolved = [];
    for (const context of contexts) {
      const reusable = findReusableAnswer(String(entry.question || ''), ledger, {
        company: String(context.company || ''),
        role: String(context.role || ''),
        url: String(context.url || ''),
        fieldKind: String(context.fieldKind || entry.fieldKind || ''),
        options: normalizeChoiceOptions(entry.options),
        sensitivity: String(entry.sensitivity || (isSensitiveQuestion(String(entry.question || '')) ? 'high' : 'normal')),
      });
      if (reusable) continue;
      const propagation = inspectOccurrence(entry, context, ledger, queueItems, queueAvailable);
      unresolved.push({
        queueId: context.queueId || null,
        company: context.company || null,
        role: context.role || null,
        required: context.required === true || entry.required === true,
        contextKey: contextIdentity(context),
        ...propagation,
      });
    }
    if (!unresolved.length) {
      alreadyAnswered.push(base);
      continue;
    }
    const missing = unresolved.filter((occurrence) => occurrence.projected === false);
    const unknown = unresolved.filter((occurrence) => occurrence.projected === null);
    answerable.push({
      ...base,
      occurrenceCount: unresolved.length,
      publishedOccurrenceCount: unresolved.filter((occurrence) => occurrence.projected === true).length,
      missingOccurrenceCount: missing.length,
      unknownOccurrenceCount: unknown.length,
      reasons: [...new Set(missing.map((occurrence) => occurrence.reason).filter(Boolean))],
      occurrences: unresolved,
    });
  }

  const missingQuestions = answerable.filter((question) => question.missingOccurrenceCount > 0);
  const unknownQuestions = answerable.filter((question) => question.unknownOccurrenceCount > 0);
  const fullyPublishedQuestions = answerable.filter((question) => question.publishedOccurrenceCount === question.occurrenceCount);
  const partiallyPublishedQuestions = answerable.filter((question) => question.publishedOccurrenceCount > 0
    && question.publishedOccurrenceCount < question.occurrenceCount);
  const issues = [];
  if (missingQuestions.length) {
    issues.push({ code: 'captured-but-unpublished', count: missingQuestions.length });
  }
  if (options.service?.freshness === 'stale') {
    issues.push({ code: 'queue-ui-predates-source', count: 1 });
  } else if (options.service?.freshness === 'not-running') {
    issues.push({ code: 'queue-ui-not-running', count: 1 });
  }
  const evidenceErrors = Array.isArray(options.evidenceErrors) ? options.evidenceErrors : [];
  const incomplete = evidenceErrors.length > 0
    || unknownQuestions.length > 0
    || options.service?.freshness === 'unknown';
  const status = issues.length ? 'issues' : incomplete ? 'incomplete' : 'healthy';
  const exitCode = status === 'healthy' ? 0 : status === 'issues' ? 1 : 2;

  return {
    schemaVersion: 1,
    type: 'question-propagation-doctor',
    readOnly: true,
    generatedAt: options.generatedAt || new Date().toISOString(),
    status,
    exitCode,
    window: options.window,
    captured: {
      observations,
      canonicalQuestions: relevant.length,
      roles: [...roleKeys].filter((key) => key !== '|').length,
      queueItems: queueIds.size,
    },
    classification: {
      answerableQuestions: answerable.length,
      humanOnlyFields: humanOnly.length,
      informationalPrompts: informational.length,
      alreadyAnsweredQuestions: alreadyAnswered.length,
    },
    propagation: {
      answerableQuestions: answerable.length,
      fullyPublishedQuestions: fullyPublishedQuestions.length,
      partiallyPublishedQuestions: partiallyPublishedQuestions.length,
      capturedButUnpublishedQuestions: missingQuestions.length,
      unknownQuestions: unknownQuestions.length,
      answerableOccurrences: answerable.reduce((count, question) => count + question.occurrenceCount, 0),
      publishedOccurrences: answerable.reduce((count, question) => count + question.publishedOccurrenceCount, 0),
      capturedButUnpublishedOccurrences: answerable.reduce((count, question) => count + question.missingOccurrenceCount, 0),
      unknownOccurrences: answerable.reduce((count, question) => count + question.unknownOccurrenceCount, 0),
      missing: missingQuestions,
      unknown: unknownQuestions,
    },
    exclusions: { humanOnly, informational, alreadyAnswered },
    service: options.service,
    issues,
    evidenceErrors,
  };
}

function readJson(file) {
  if (!existsSync(file)) throw new Error(`${path.relative(path.dirname(path.dirname(file)), file)} does not exist`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * @param {{ root: string, since?: string | Date | null, all?: boolean, now?: Date }} options
 */
export async function runQuestionPropagationDoctor(options) {
  const window = resolveQuestionWindow(options.all ? null : options.since, options.now || new Date());
  const evidenceErrors = [];
  const ledgerPath = path.join(options.root, 'data', 'application-question-ledger.json');
  const queuePath = path.join(options.root, 'data', 'job-queue.json');
  const ledger = loadLedger(ledgerPath);
  if (ledger.loadError) evidenceErrors.push(`question ledger: ${ledger.loadError}`);
  let queue = { items: [] };
  let queueAvailable = true;
  try {
    queue = readJson(queuePath);
    if (!Array.isArray(queue.items)) throw new Error('queue items are missing');
  } catch (error) {
    queueAvailable = false;
    evidenceErrors.push(`queue state: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sources = collectQuestionPropagationSources(options.root);
  evidenceErrors.push(...sources.errors.map((error) => `source snapshot: ${error}`));
  const service = await inspectQueueUiService({ root: options.root, sources });
  return analyzeQuestionPropagation({
    ledger,
    queue,
    queueAvailable,
    window,
    service,
    evidenceErrors,
  });
}

function countReasons(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.reason || 'other', (counts.get(entry.reason || 'other') || 0) + 1);
  return [...counts.entries()].map(([reason, count]) => `${reason}: ${count}`).join(', ') || 'none';
}

/** @param {ReturnType<typeof analyzeQuestionPropagation>} result */
export function renderQuestionPropagationReport(result) {
  const heading = result.status === 'healthy' ? 'HEALTHY' : result.status === 'issues' ? 'ISSUES FOUND' : 'INCOMPLETE';
  const lines = [
    `Question propagation doctor: ${heading}`,
    `Window: ${result.window.label}`,
    `Captured: ${result.captured.canonicalQuestions} canonical question(s), ${result.captured.observations} observation(s), ${result.captured.roles} role(s).`,
    `Classification: ${result.classification.answerableQuestions} answerable, ${result.classification.humanOnlyFields} human-only, ${result.classification.informationalPrompts} informational, ${result.classification.alreadyAnsweredQuestions} already answered.`,
    `Propagation: ${result.propagation.fullyPublishedQuestions}/${result.propagation.answerableQuestions} answerable question(s) fully published; ${result.propagation.capturedButUnpublishedQuestions} captured but unpublished.`,
  ];
  if (result.propagation.missing.length) {
    lines.push('Captured but unpublished:');
    for (const question of result.propagation.missing) {
      const destination = [...new Set(question.occurrences
        .filter((occurrence) => occurrence.projected === false)
        .map((occurrence) => [occurrence.company, occurrence.role].filter(Boolean).join(' — ') || occurrence.queueId || 'unknown role'))]
        .join('; ');
      lines.push(`  - ${question.required ? '[required] ' : ''}${question.id}: ${question.question}${destination ? ` (${destination})` : ''} [${question.reasons.join(', ')}]`);
    }
  }
  lines.push(`Human-only exclusions: ${countReasons(result.exclusions.humanOnly)}`);
  const service = result.service || {};
  const serviceAge = service.startedAt ? `started ${service.startedAt}` : 'start time unavailable';
  const newestSource = service.newestSource?.modifiedAt
    ? `; newest source ${service.newestSource.path} at ${service.newestSource.modifiedAt}`
    : '';
  lines.push(`Queue UI service: ${service.freshness || 'unknown'} (${serviceAge}${newestSource}).`);
  if (service.freshness === 'stale') lines.push('Reload the queue UI service before expecting current source to project questions.');
  if (result.evidenceErrors.length) {
    lines.push('Incomplete evidence:');
    for (const error of result.evidenceErrors) lines.push(`  - ${error}`);
  }
  lines.push('Read-only: no queue, ledger, service, or application state was changed.');
  return lines.join('\n');
}
