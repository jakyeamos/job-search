#!/usr/bin/env node

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_LEDGER_PATH = path.join(ROOT, 'data', 'application-question-ledger.json');
export const QUESTION_LEDGER_SCHEMA_VERSION = 2;

const SENSITIVE_RE = /authoriz|visa|sponsor|relocat|salary|compensation|background|legal|degree|education|citizenship|demographic|gender|race|veteran|disab|self[-\s]?identif|criminal|conviction|consent/i;
const EVIDENCE_BACKED_ANSWER_STATUS = 'evidence-backed';
const QUESTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'at', 'be', 'can', 'could', 'do', 'does', 'for', 'from',
  'have', 'how', 'i', 'if', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'please',
  'select', 'the', 'this', 'to', 'us', 'was', 'what', 'when', 'where', 'which',
  'who', 'will', 'with', 'would', 'you', 'your',
]);
const QUESTION_SYNONYMS = new Map([
  ['based', 'location'],
  ['city', 'location'],
  ['currently', 'current'],
  ['expect', 'plan'],
  ['expected', 'plan'],
  ['intend', 'plan'],
  ['intended', 'plan'],
  ['location', 'location'],
  ['mobile', 'phone'],
  ['planning', 'plan'],
  ['plans', 'plan'],
  ['receiving', 'receive'],
  ['requirement', 'require'],
  ['requires', 'require'],
  ['sponsor', 'sponsorship'],
  ['sponsored', 'sponsorship'],
  ['sponsorship', 'sponsorship'],
  ['textual', 'text'],
  ['texts', 'text'],
  ['visa', 'sponsorship'],
  ['where', 'location'],
]);
const AI_TOOLS_QUESTION_RE = /\b(?:ai|llm)\s+tools?\b/i;
const AI_DIRECT_USAGE_RE = /\b(?:use|uses|using|used)\s+(?:ai|llm)\b/i;
const AI_USAGE_CONTEXT_RE = /\b(?:today|current(?:ly)?|role|experiment(?:s)?|production)\b/i;
const PRODUCTION_SYSTEM_RE = /\b(?:production|live|shipped)\b/i;
const END_USER_RE = /\bend[-\s]?user[-\s]?facing\b|\bcustomer[-\s]?facing\b|\buser[-\s]?facing\b/i;
const OWNERSHIP_RE = /\b(?:owned|led|built|responsible)\b/i;
const END_TO_END_RE = /\bend[-\s]?to[-\s]?end\b/i;
const AGENTIC_SYSTEM_RE = /\bagentic\s+systems?\b/i;
const AGENTIC_EXPERIENCE_RE = /\b(?:hands[-\s]?on|build(?:ing)?|evaluat(?:e|ed|ing))\b/i;
const PYTHON_PROJECT_RE = /\bpython\b[\s\S]{0,80}\b(?:project|system|application|service|product)\b|\b(?:project|system|application|service|product)\b[\s\S]{0,80}\bpython\b/i;
const PRODUCTION_SHIPPING_RE = /\b(?:production|shipped|shipping|deployed|deployment|live)\b/i;
const ANSWER_STATUS_RANK = {
  unanswered: 0,
  unconfirmed: 1,
  [EVIDENCE_BACKED_ANSWER_STATUS]: 2,
  confirmed: 3,
};

/** @param {string} file */
export function loadLedger(file = DEFAULT_LEDGER_PATH) {
  if (!existsSync(file)) return { schemaVersion: QUESTION_LEDGER_SCHEMA_VERSION, entries: [], path: file };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      schemaVersion: QUESTION_LEDGER_SCHEMA_VERSION,
      entries: Array.isArray(parsed?.entries)
        ? parsed.entries.filter((entry) => entry && typeof entry === 'object').map(normalizeEntry)
        : [],
      path: file,
    };
  } catch {
    return { schemaVersion: QUESTION_LEDGER_SCHEMA_VERSION, entries: [], path: file, loadError: 'question ledger is not valid JSON' };
  }
}

/** @param {string} file @param {{ entries: Array<Record<string, unknown>> }} ledger */
export function saveLedger(file, ledger) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ schemaVersion: QUESTION_LEDGER_SCHEMA_VERSION, entries: ledger.entries }, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** @param {Record<string, unknown>} entry */
function normalizeEntry(entry) {
  const answer = entry.answer === null || entry.answer === undefined ? null : String(entry.answer);
  const hasAnswer = answer !== null && answer !== '';
  const explicitlyConfirmed = entry.answerStatus === 'confirmed'
    || entry.answerSource === 'user'
    || entry.source === 'profile-confirmed';
  const evidenceBacked = entry.answerStatus === EVIDENCE_BACKED_ANSWER_STATUS
    || entry.answerSource === 'career-ops-evidence';
  return {
    ...entry,
    answer,
    answerVersion: hasAnswer ? Math.max(1, Number(entry.answerVersion || 1)) : 0,
    answerStatus: hasAnswer && explicitlyConfirmed
      ? 'confirmed'
      : hasAnswer && evidenceBacked
        ? EVIDENCE_BACKED_ANSWER_STATUS
        : hasAnswer ? 'unconfirmed' : 'unanswered',
    answerVariants: Array.isArray(entry.answerVariants)
      ? entry.answerVariants.filter((variant) => variant && typeof variant === 'object').map((variant) => ({
        ...variant,
        answer: variant.answer === null || variant.answer === undefined ? null : String(variant.answer),
        answerVersion: variant.answer === null || variant.answer === undefined || variant.answer === ''
          ? 0
          : Math.max(1, Number(variant.answerVersion || 1)),
        answerStatus: variant.answerStatus === 'confirmed' || variant.answerSource === 'user' || variant.source === 'profile-confirmed' || entry.source === 'profile-confirmed'
          ? 'confirmed'
          : variant.answerStatus === EVIDENCE_BACKED_ANSWER_STATUS || variant.answerSource === 'career-ops-evidence'
            ? EVIDENCE_BACKED_ANSWER_STATUS
            : variant.answer ? 'unconfirmed' : 'unanswered',
      }))
      : [],
  };
}

/** @param {Record<string, unknown>} entry @param {Record<string, unknown>} [answer] */
export function answerReference(entry, answer = entry) {
  if (!entry?.id || answer?.answer === null || answer?.answer === undefined || answer?.answer === '') return null;
  return `question-ledger:${entry.id}@v${Math.max(1, Number(answer.answerVersion || 1))}`;
}

/** @param {Record<string, unknown>} entry @param {Record<string, unknown>} [answer] */
export function isConfirmedAnswer(entry, answer = entry) {
  return answer?.answerStatus === 'confirmed'
    || answer?.answerSource === 'user'
    || entry?.source === 'profile-confirmed'
    || (answer?.answerStatus === EVIDENCE_BACKED_ANSWER_STATUS && String(entry?.sensitivity || 'normal') !== 'high');
}

/** @param {Record<string, unknown>} entry */
function answerVariants(entry) {
  if (Array.isArray(entry.answerVariants) && entry.answerVariants.length) return entry.answerVariants;
  return entry.answer === null || entry.answer === undefined || entry.answer === '' ? [] : [entry];
}

/** @param {Record<string, unknown>} variant @param {{ company?: string, role?: string, url?: string }} options */
function matchesAnswerScope(variant, options) {
  if (variant.scope === 'question' || variant.scope === 'global') return true;
  if (variant.scope === 'company') return normalizeKey(variant.company) === normalizeKey(options.company);
  if (variant.scope === 'role') {
    return normalizeKey(variant.role) === normalizeKey(options.role)
      && (!variant.company || !options.company || normalizeKey(variant.company) === normalizeKey(options.company));
  }
  if (variant.scope === 'posting') return Boolean(variant.url && variant.url === options.url);
  return false;
}

/** @param {Record<string, unknown>} variant */
function answerContextKey(variant) {
  return [variant.scope || 'question', normalizeKey(variant.company), normalizeKey(variant.role), String(variant.url || '')].join('|');
}

/** @param {string} question */
export function normalizeQuestion(question) {
  return String(question || '').replace(/[\u200b\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} question */
export function questionId(question) {
  return `q_${createHash('sha256').update(normalizeQuestion(question).toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** @param {string} question */
export function isAiUsageQuestion(question) {
  const normalized = normalizeQuestion(question);
  if (/\bcreative\b/i.test(normalized)) return false;
  return (AI_TOOLS_QUESTION_RE.test(normalized) && /\b(?:use|uses|using|used|today|current(?:ly)?|production)\b/i.test(normalized))
    || (AI_DIRECT_USAGE_RE.test(normalized) && AI_USAGE_CONTEXT_RE.test(normalized));
}

/** @param {string} question */
export function isProductionSystemQuestion(question) {
  const normalized = normalizeQuestion(question);
  return PRODUCTION_SYSTEM_RE.test(normalized)
    && END_USER_RE.test(normalized)
    && OWNERSHIP_RE.test(normalized)
    && END_TO_END_RE.test(normalized);
}

/** @param {string} question */
export function isAgenticSystemsQuestion(question) {
  const normalized = normalizeQuestion(question);
  return AGENTIC_SYSTEM_RE.test(normalized) && AGENTIC_EXPERIENCE_RE.test(normalized);
}

/** @param {string} question */
export function isPythonProductionQuestion(question) {
  const normalized = normalizeQuestion(question);
  return PYTHON_PROJECT_RE.test(normalized) && PRODUCTION_SHIPPING_RE.test(normalized);
}

/**
 * Produce a conservative semantic key without changing the legacy question id.
 * Exact ids remain stable; this key only lets new observations attach to an
 * existing canonical question when the core intent is the same.
 * @param {string} question
 */
export function canonicalQuestionKey(question) {
  const normalized = normalizeQuestion(question);
  if (isAiUsageQuestion(normalized)) return 'ai usage';
  if (isProductionSystemQuestion(normalized)) return 'production end-user system';
  if (isAgenticSystemsQuestion(normalized)) return 'agentic systems experience';
  if (isPythonProductionQuestion(normalized)) return 'python production project';
  const core = normalized
    .replace(/^yes\s*[-–—:]\s*/i, '')
    .replace(/\bplease note\b[\s\S]*$/i, '')
    .replace(/\b(?:for employment|in the united states|in the us)\b[\s\S]*$/i, '')
    .replace(/\bsite reliability engineering\b/gi, 'sre')
    .replace(/\([^)]*\)/g, ' ')
    .split('?')[0]
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+.#-]+/g, ' ');
  const tokens = core.split(/\s+/)
    .map((token) => QUESTION_SYNONYMS.get(token) || token)
    .filter((token) => token && !QUESTION_STOP_WORDS.has(token))
    .filter((token) => token !== 'now' && token !== 'future' && token !== 'time');
  return [...new Set(tokens)].sort().join(' ');
}

/** @param {string} question @returns {string} */
export function questionFingerprint(question) {
  return createHash('sha256').update(canonicalQuestionKey(question)).digest('hex').slice(0, 16);
}

/** @param {string} question */
export function isSensitiveQuestion(question) {
  return SENSITIVE_RE.test(normalizeQuestion(question));
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} question
 * @param {{ fieldKind?: string, options?: string[], sensitivity?: string }} [metadata]
 */
export function questionMatchScore(entry, question, metadata = {}) {
  if (!compatibleQuestion(entry, metadata)) return 0;
  const target = normalizeQuestion(question).toLowerCase();
  const canonical = normalizeQuestion(String(entry.question || '')).toLowerCase();
  const aliases = Array.isArray(entry.aliases) ? entry.aliases.map((value) => normalizeQuestion(String(value)).toLowerCase()) : [];
  if (target === canonical || aliases.includes(target)) return 1;
  const pattern = normalizeQuestion(String(entry.pattern || '')).toLowerCase();
  if (pattern.length >= 5 && !['location', 'search', 'other', 'phone', 'email'].includes(pattern)
    && (target.includes(pattern) || pattern.includes(target))) return 0.9;

  const left = canonicalQuestionKey(question);
  const right = canonicalQuestionKey(String(entry.question || ''));
  if (!left || !right) return 0;
  const patternTokens = new Set(canonicalQuestionKey(String(entry.pattern || '')).split(' ').filter(Boolean));
  const targetTokens = new Set(left.split(' ').filter(Boolean));
  const genericPatternTokens = new Set(['experience', 'familiar', 'knowledge', 'used', 'using', 'years', 'year']);
  const meaningfulPatternTokens = [...patternTokens].filter((token) => !genericPatternTokens.has(token));
  if (meaningfulPatternTokens.length && meaningfulPatternTokens.every((token) => targetTokens.has(token))) return 0.88;
  if (left === right) return 0.94;
  const leftTokens = new Set(left.split(' '));
  const rightTokens = new Set(right.split(' '));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = union ? overlap / union : 0;
  return overlap >= 3 && jaccard >= 0.72 ? 0.78 + (jaccard - 0.72) * 0.3 : 0;
}

/** @param {Record<string, unknown>} entry @param {string} question @param {number} score */
function matchTypeFor(entry, question, score) {
  if (score !== 1) return 'semantic';
  const target = normalizeQuestion(question).toLowerCase();
  const canonical = normalizeQuestion(String(entry.question || '')).toLowerCase();
  return target === canonical ? 'exact' : 'alias';
}

/**
 * @param {string} question
 * @param {{ entries: Array<Record<string, unknown>> }} ledger
 * @param {{ fieldKind?: string, options?: string[], sensitivity?: string }} [metadata]
 */
export function findQuestionMatch(question, ledger, metadata = {}) {
  const candidates = ledger.entries
    .map((entry) => ({ entry, score: questionMatchScore(entry, question, metadata) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || String(left.entry.id || '').localeCompare(String(right.entry.id || '')));
  if (!candidates.length) return null;
  const best = candidates[0];
  const next = candidates[1];
  if (next && best.score < 1 && best.score - next.score < 0.06) return null;
  return { ...best, matchType: matchTypeFor(best.entry, question, best.score) };
}

/**
 * Record one observed question in an already-loaded ledger. This is the
 * packet builder's dry-run-safe path: callers can inspect the returned entry
 * without persisting the observation.
 * @param {{ entries: Array<Record<string, unknown>> }} ledger
 * @param {string} question
 * @param {Record<string, unknown>} [metadata]
 */
export function recordQuestionInLedger(ledger, question, metadata = {}) {
  const normalized = normalizeQuestion(question);
  if (!normalized || /^EEO\s*:/i.test(normalized)) return null;
  const matched = findQuestionMatch(normalized, ledger, {
    fieldKind: String(metadata.fieldKind || ''),
    options: Array.isArray(metadata.options) ? metadata.options.map(String) : [],
    sensitivity: String(metadata.sensitivity || (isSensitiveQuestion(normalized) ? 'high' : 'normal')),
  });
  const id = matched?.entry.id || questionId(normalized);
  const now = new Date().toISOString();
  const existing = matched?.entry || ledger.entries.find((entry) => entry.id === id);
  const canonicalQuestion = String(existing?.question || normalized);
  const aliases = [...new Set([
    ...(Array.isArray(existing?.aliases) ? existing.aliases.map(String) : []),
    ...(normalizeQuestion(canonicalQuestion).toLowerCase() === normalized.toLowerCase() ? [] : [normalized]),
  ])];
  const context = {
    company: metadata.company || null,
    role: metadata.role || null,
    url: metadata.url || null,
    queueId: metadata.queueId || null,
    jdHash: metadata.jdHash || null,
    required: metadata.required === true,
    fieldKind: metadata.fieldKind || null,
    source: metadata.source || 'application-form',
    recordedAt: now,
  };
  const contexts = [...(Array.isArray(existing?.contexts) ? existing.contexts : [])]
    .filter((item) => item && typeof item === 'object')
    .filter((item) => String(item.queueId || '') !== String(context.queueId || '')
      || String(item.url || '') !== String(context.url || ''));
  if (context.company || context.role || context.url || context.queueId) contexts.push(context);
  const normalizedExisting = existing ? normalizeEntry(existing) : null;
  const entry = normalizeEntry({
    id,
    question: canonicalQuestion,
    aliases,
    questionKey: canonicalQuestionKey(canonicalQuestion),
    questionFingerprint: questionFingerprint(canonicalQuestion),
    pattern: metadata.pattern || existing?.pattern || canonicalQuestion,
    answer: normalizedExisting?.answer ?? null,
    status: normalizedExisting?.status || 'unanswered',
    scope: existing?.scope || 'question',
    sensitivity: existing?.sensitivity || (isSensitiveQuestion(normalized) ? 'high' : 'normal'),
    company: existing?.company || metadata.company || null,
    role: existing?.role || metadata.role || null,
    url: existing?.url || metadata.url || null,
    queueId: existing?.queueId || metadata.queueId || null,
    contexts,
    options: Array.isArray(metadata.options) && metadata.options.length
      ? [...new Set(metadata.options.map((value) => String(value).trim()).filter(Boolean))]
      : Array.isArray(existing?.options) ? existing.options : [],
    fieldKind: existing?.fieldKind || metadata.fieldKind || null,
    required: existing?.required === true || metadata.required === true,
    blockerReason: existing?.blockerReason || metadata.reason || null,
    source: existing?.source || metadata.source || 'application-form',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    usageCount: Number(existing?.usageCount || 0),
    lastUsedAt: existing?.lastUsedAt || null,
    expiresAt: normalizedExisting?.expiresAt || metadata.expiresAt || null,
    answerVersion: normalizedExisting?.answerVersion || 0,
    answerStatus: normalizedExisting?.answerStatus || 'unanswered',
    answerSource: normalizedExisting?.answerSource || null,
    evidenceRefs: Array.isArray(normalizedExisting?.evidenceRefs)
      ? normalizedExisting.evidenceRefs
      : Array.isArray(existing?.evidenceRefs) ? existing.evidenceRefs : [],
    answerVariants: Array.isArray(normalizedExisting?.answerVariants)
      ? normalizedExisting.answerVariants
      : [],
    answeredAt: normalizedExisting?.answeredAt || null,
  });
  ledger.entries = existing
    ? ledger.entries.map((item) => (item.id === id ? entry : item))
    : [...ledger.entries, entry];
  return entry;
}

/** @param {Record<string, unknown>} entry */
function answerStatusRank(entry) {
  return ANSWER_STATUS_RANK[String(entry.answerStatus || 'unanswered')] || 0;
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function preferredLedgerEntry(left, right) {
  const leftRank = answerStatusRank(left);
  const rightRank = answerStatusRank(right);
  if (rightRank !== leftRank) return rightRank > leftRank ? right : left;
  const leftContexts = Array.isArray(left.contexts) ? left.contexts.length : 0;
  const rightContexts = Array.isArray(right.contexts) ? right.contexts.length : 0;
  if (rightContexts !== leftContexts) return rightContexts > leftContexts ? right : left;
  const leftUsage = Number(left.usageCount || 0);
  const rightUsage = Number(right.usageCount || 0);
  return rightUsage > leftUsage ? right : left;
}

/** @param {Array<Record<string, unknown>>} values @param {(value: Record<string, unknown>) => string} keyFor */
function uniqueObjects(values, keyFor) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value || typeof value !== 'object') return false;
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Collapse legacy duplicate observations that now resolve to the same
 * conservative semantic key. Confirmed answers win over evidence-backed and
 * unanswered entries; conflicting answer variants remain visible so the
 * resolver can fail closed instead of silently choosing one.
 * @param {{ entries: Array<Record<string, unknown>> }} ledger
 * @returns {{ ledger: { entries: Array<Record<string, unknown>> }, mergedCount: number }}
 */
export function compactLedger(ledger) {
  const groups = new Map();
  let mergedCount = 0;
  for (const rawEntry of ledger.entries || []) {
    const entry = normalizeEntry(rawEntry);
    const key = canonicalQuestionKey(String(entry.question || ''));
    const groupKey = key
      ? `${key}|${String(entry.sensitivity || 'normal')}|${fieldKindFamily(String(entry.fieldKind || ''))}`
      : `id:${String(entry.id || '')}`;
    const existing = groups.get(groupKey);
    if (!existing) {
      groups.set(groupKey, entry);
      continue;
    }

    const primary = preferredLedgerEntry(existing, entry);
    const secondary = primary.id === existing.id ? entry : existing;
    const aliases = uniqueObjects([
      ...(Array.isArray(primary.aliases) ? primary.aliases.map((value) => ({ value: String(value) })) : []),
      ...(Array.isArray(secondary.aliases) ? secondary.aliases.map((value) => ({ value: String(value) })) : []),
      normalizeQuestion(String(primary.question || '')) === normalizeQuestion(String(secondary.question || ''))
        ? null
        : { value: normalizeQuestion(String(secondary.question || '')) },
    ].filter(Boolean), (value) => value.value.toLowerCase()).map((value) => value.value);
    const contexts = uniqueObjects([
      ...(Array.isArray(primary.contexts) ? primary.contexts : []),
      ...(Array.isArray(secondary.contexts) ? secondary.contexts : []),
    ], (value) => [value.queueId, value.url, value.company, value.role].map((item) => String(item || '')).join('|'));
    const answerVariants = uniqueObjects([
      ...answerVariantsForMerge(primary),
      ...answerVariantsForMerge(secondary),
    ], (value) => `${answerContextKey(value)}|${String(value.answer || '')}`);
    const updatedAt = [primary.updatedAt, secondary.updatedAt]
      .map((value) => String(value || ''))
      .sort()
      .pop() || primary.updatedAt || secondary.updatedAt || null;
    const merged = normalizeEntry({
      ...primary,
      aliases,
      contexts,
      options: [...new Set([
        ...(Array.isArray(primary.options) ? primary.options.map(String) : []),
        ...(Array.isArray(secondary.options) ? secondary.options.map(String) : []),
      ].filter(Boolean))],
      required: primary.required === true || secondary.required === true,
      usageCount: Number(primary.usageCount || 0) + Number(secondary.usageCount || 0),
      updatedAt,
      answerVariants,
      questionKey: canonicalQuestionKey(String(primary.question || '')),
      questionFingerprint: questionFingerprint(String(primary.question || '')),
    });
    groups.set(groupKey, merged);
    mergedCount += 1;
  }
  ledger.entries = [...groups.values()].map((entry) => ({
    ...entry,
    questionKey: canonicalQuestionKey(String(entry.question || '')),
    questionFingerprint: questionFingerprint(String(entry.question || '')),
  }));
  return { ledger, mergedCount };
}

/** @param {Record<string, unknown>} entry */
function answerVariantsForMerge(entry) {
  return answerVariants(entry).filter((variant) => variant && variant.answer !== null && variant.answer !== undefined && variant.answer !== '');
}

/**
 * Record an answer derived from explicit Career Ops evidence. These answers
 * are reusable for normal questions, but sensitive/legal/identity questions
 * remain human-confirmed only.
 * @param {{ entries: Array<Record<string, unknown>> }} ledger
 * @param {string|Record<string, unknown>} target
 * @param {string} answer
 * @param {{ scope?: string, company?: string, role?: string, url?: string, queueId?: string, evidenceRefs?: string[], source?: string }} [options]
 * @returns {{ entry: Record<string, unknown>, answer: Record<string, unknown>, answerRef: string }|null}
 */
export function recordEvidenceBackedAnswerInLedger(ledger, target, answer, options = {}) {
  const answerText = String(answer ?? '').trim();
  if (!answerText) return null;
  const targetId = typeof target === 'object' ? String(target.id || '') : String(target || '');
  const targetQuestion = typeof target === 'object' ? String(target.question || '') : String(target || '');
  let entry = targetId ? ledger.entries.find((candidate) => String(candidate.id || '') === targetId) : null;
  if (!entry && targetQuestion) {
    entry = findQuestionMatch(targetQuestion, ledger)?.entry || null;
  }
  if (!entry || String(entry.sensitivity || 'normal') === 'high' || isSensitiveQuestion(String(entry.question || ''))) return null;

  const requestedScope = String(options.scope || (options.role ? 'role' : 'question'));
  const scope = ['question', 'global', 'company', 'role', 'posting'].includes(requestedScope) ? requestedScope : 'question';
  const now = new Date().toISOString();
  const context = {
    scope,
    company: options.company || entry.company || null,
    role: options.role || entry.role || null,
    url: options.url || entry.url || null,
    queueId: options.queueId || entry.queueId || null,
  };
  const existingVariants = answerVariants(entry);
  const contextMatches = (candidate) => answerContextKey(candidate) === answerContextKey(context);
  const sameContext = existingVariants.find((candidate) => contextMatches(candidate));
  if (sameContext && String(sameContext.answer || '') !== answerText && isConfirmedAnswer(entry, sameContext)) return null;

  const evidenceRefs = [...new Set([
    ...(Array.isArray(sameContext?.evidenceRefs) ? sameContext.evidenceRefs.map(String) : []),
    ...(Array.isArray(options.evidenceRefs) ? options.evidenceRefs.map(String) : []),
  ].filter(Boolean))];
  const maxVersion = Math.max(Number(entry.answerVersion || 0), ...existingVariants.map((variant) => Number(variant.answerVersion || 0)));
  const nextVersion = sameContext && String(sameContext.answer || '') === answerText
    ? Math.max(1, Number(sameContext.answerVersion || 1))
    : Math.max(1, maxVersion + 1);
  const variant = {
    ...(sameContext || {}),
    answer: answerText,
    answerStatus: EVIDENCE_BACKED_ANSWER_STATUS,
    answerVersion: nextVersion,
    answerSource: options.source || 'career-ops-evidence',
    evidenceRefs,
    answeredAt: sameContext?.answeredAt || now,
    updatedAt: now,
    ...context,
  };
  const variants = existingVariants.length
    ? (sameContext
      ? existingVariants.map((candidate) => (contextMatches(candidate) ? { ...candidate, ...variant } : candidate))
      : [...existingVariants, variant])
    : [variant];

  const topLevelConfirmed = isConfirmedAnswer(entry, entry) && entry.answerStatus === 'confirmed';
  const updated = normalizeEntry({
    ...entry,
    answer: topLevelConfirmed ? entry.answer : answerText,
    status: 'answered',
    answerStatus: topLevelConfirmed ? entry.answerStatus : EVIDENCE_BACKED_ANSWER_STATUS,
    answerVersion: topLevelConfirmed ? entry.answerVersion : nextVersion,
    answerSource: topLevelConfirmed ? entry.answerSource : options.source || 'career-ops-evidence',
    evidenceRefs: topLevelConfirmed ? entry.evidenceRefs : evidenceRefs,
    answeredAt: topLevelConfirmed ? entry.answeredAt : (entry.answeredAt || now),
    updatedAt: now,
    answerVariants: variants,
  });
  ledger.entries = ledger.entries.map((candidate) => (candidate.id === entry.id ? updated : candidate));
  const selectedAnswer = updated.answerVariants.find((candidate) => contextMatches(candidate)) || variant;
  return {
    entry: updated,
    answer: selectedAnswer,
    answerRef: answerReference(updated, selectedAnswer),
  };
}

/**
 * Merge observed questions and evidence-backed variants from a staging ledger
 * into a canonical ledger without replacing user-confirmed answers.
 * @param {{ entries: Array<Record<string, unknown>> }} target
 * @param {{ entries: Array<Record<string, unknown>> }} source
 * @returns {{ entries: Array<Record<string, unknown>> }}
 */
export function mergeLedgerObservations(target, source) {
  compactLedger(target);
  for (const incoming of source.entries || []) {
    const observed = recordQuestionInLedger(target, String(incoming.question || ''), {
      company: incoming.company,
      role: incoming.role,
      url: incoming.url,
      queueId: incoming.queueId,
      jdHash: incoming.contexts?.[0]?.jdHash || null,
      source: incoming.source || 'application-packet:form-inspection',
      options: Array.isArray(incoming.options) ? incoming.options : [],
      fieldKind: incoming.fieldKind,
      required: incoming.required === true,
      sensitivity: incoming.sensitivity,
      pattern: incoming.pattern,
    });
    if (!observed) continue;
    const targetEntry = target.entries.find((candidate) => candidate.id === observed.id);
    if (!targetEntry) continue;
    targetEntry.aliases = [...new Set([
      ...(Array.isArray(targetEntry.aliases) ? targetEntry.aliases.map(String) : []),
      ...(Array.isArray(incoming.aliases) ? incoming.aliases.map(String) : []),
    ])];
    const contextKey = (context) => [context.queueId, context.url, context.company, context.role].map((value) => String(value || '')).join('|');
    const contexts = [...(Array.isArray(targetEntry.contexts) ? targetEntry.contexts : [])];
    for (const context of Array.isArray(incoming.contexts) ? incoming.contexts : []) {
      if (!context || typeof context !== 'object') continue;
      if (!contexts.some((candidate) => contextKey(candidate) === contextKey(context))) contexts.push(context);
    }
    targetEntry.contexts = contexts;
    targetEntry.options = [...new Set([
      ...(Array.isArray(targetEntry.options) ? targetEntry.options.map(String) : []),
      ...(Array.isArray(incoming.options) ? incoming.options.map(String) : []),
    ].filter(Boolean))];

    const incomingAnswers = Array.isArray(incoming.answerVariants) && incoming.answerVariants.length
      ? incoming.answerVariants
      : [incoming];
    for (const candidate of incomingAnswers) {
      if (!candidate?.answer || candidate.answerStatus !== EVIDENCE_BACKED_ANSWER_STATUS) continue;
      recordEvidenceBackedAnswerInLedger(target, targetEntry.id, String(candidate.answer), {
        scope: candidate.scope,
        company: candidate.company,
        role: candidate.role,
        url: candidate.url,
        queueId: candidate.queueId,
        evidenceRefs: candidate.evidenceRefs,
        source: candidate.answerSource || 'career-ops-evidence',
      });
    }
  }
  compactLedger(target);
  return target;
}

/**
 * @param {string} file
 * @param {string} question
 * @param {Record<string, unknown>} [metadata]
 */
export function recordQuestion(file, question, metadata = {}) {
  const ledger = loadLedger(file);
  const entry = recordQuestionInLedger(ledger, question, metadata);
  if (entry) saveLedger(file, ledger);
  return entry;
}

/**
 * @param {string} file
 * @param {string} target
 * @param {string} answer
 * @param {{ scope?: string, company?: string, role?: string, url?: string, queueId?: string, pattern?: string, expiresAt?: string, confirmSensitive?: boolean }} [options]
 */
export function answerQuestion(file, target, answer, options = {}) {
  const ledger = loadLedger(file);
  const normalizedTarget = normalizeQuestion(target);
  const targetId = normalizedTarget.startsWith('q_') ? normalizedTarget : questionId(normalizedTarget);
  let entry = ledger.entries.find((item) => item.id === targetId);
  if (!entry) entry = ledger.entries.find((item) => normalizeQuestion(String(item.question || '')).toLowerCase() === normalizedTarget.toLowerCase());
  if (!entry) entry = findQuestionMatch(normalizedTarget, ledger)?.entry;
  if (!entry) throw new Error(`question not found: ${target}`);
  if (entry.sensitivity === 'high' && options.scope === 'global' && !options.confirmSensitive) {
    throw new Error('sensitive answers need --confirm-sensitive before being reused globally');
  }
  const now = new Date().toISOString();
  const requestedScope = options.scope || entry.scope || 'question';
  const scope = ['question', 'global', 'company', 'role', 'posting'].includes(requestedScope)
    ? requestedScope
    : 'role';
  const existingVariants = answerVariants(entry);
  const maxVersion = Math.max(Number(entry.answerVersion || 0), ...existingVariants.map((variant) => Number(variant.answerVersion || 0)));
  const nextVersion = Math.max(1, maxVersion + 1);
  const variant = {
    answer: String(answer),
    answerStatus: 'confirmed',
    answerVersion: nextVersion,
    answerSource: 'user',
    answeredAt: now,
    updatedAt: now,
    scope,
    company: options.company || entry.company || null,
    role: options.role || entry.role || null,
    url: options.url || entry.url || null,
  };
  const matchingVariantIndex = existingVariants.findIndex((candidate) => answerContextKey(candidate) === answerContextKey(variant));
  const variants = existingVariants.length
    ? existingVariants.map((candidate, index) => (index === matchingVariantIndex ? { ...candidate, ...variant } : candidate))
    : [];
  if (existingVariants.length && matchingVariantIndex < 0) variants.push(variant);
  const updated = normalizeEntry({
    ...entry,
    answer: String(answer),
    status: 'answered',
    answerStatus: 'confirmed',
    answerVersion: nextVersion,
    scope,
    company: options.company || entry.company || null,
    role: options.role || entry.role || null,
    url: options.url || entry.url || null,
    queueId: options.queueId || entry.queueId || null,
    pattern: options.pattern || entry.pattern || entry.question,
    expiresAt: options.expiresAt || entry.expiresAt || null,
    answerSource: 'user',
    answeredAt: now,
    updatedAt: now,
    answerVariants: variants,
  });
  saveLedger(file, { entries: ledger.entries.map((item) => (item.id === entry.id ? updated : item)) });
  return updated;
}

/**
 * @param {string} question
 * @param {{ entries: Array<Record<string, unknown>> }} ledger
 * @param {{ company?: string, role?: string, url?: string }} [context]
 */
export function lookupAnswer(question, ledger, context = {}) {
  return findReusableAnswer(question, ledger, context)?.answer || null;
}

/**
 * Resolve a reusable answer with provenance so packet builders can explain why
 * a value was suggested. The public lookupAnswer API remains string-only for
 * existing adapters.
 * @param {string} question
 * @param {{ entries: Array<Record<string, unknown>> }} ledger
 * @param {{ company?: string, role?: string, url?: string, fieldKind?: string, options?: string[], sensitivity?: string }} [context]
 */
export function findReusableAnswer(question, ledger, context = {}) {
  const now = Date.now();
  const candidates = ledger.entries.flatMap((entry) => answerVariants(entry).map((answer) => ({ entry, answer })))
    .filter(({ entry, answer }) => {
      if (answer.answer === null || answer.answer === undefined || answer.answer === '' || !isConfirmedAnswer(entry, answer)) return false;
      if (answer.expiresAt && Date.parse(String(answer.expiresAt)) <= now) return false;
      if (!questionMatchScore(entry, question, context)) return false;
      return matchesAnswerScope(answer, context);
    }).map(({ entry, answer }) => ({
      entry,
      answer,
      score: questionMatchScore(entry, question, context),
    })).sort((a, b) => b.score - a.score
      || scopeRank(b.answer.scope) - scopeRank(a.answer.scope)
      || String(b.answer.updatedAt || b.entry.updatedAt || '').localeCompare(String(a.answer.updatedAt || a.entry.updatedAt || '')));
  if (!candidates.length) return null;
  const best = candidates[0];
  const competing = candidates.find((candidate) => candidate !== best
    && scopeRank(candidate.answer.scope) === scopeRank(best.answer.scope)
    && Math.abs(candidate.score - best.score) < 0.04
    && String(candidate.answer.answer) !== String(best.answer.answer));
  if (competing) return null;
  const chosen = best.entry;
  best.answer.usageCount = Number(best.answer.usageCount || 0) + 1;
  best.answer.lastUsedAt = new Date().toISOString();
  return {
    answer: String(best.answer.answer),
    answerStatus: best.answer.answerStatus || null,
    evidenceRefs: Array.isArray(best.answer.evidenceRefs) ? best.answer.evidenceRefs.map(String) : [],
    entry: chosen,
    answerRef: answerReference(chosen, best.answer),
    matchType: matchTypeFor(chosen, question, best.score),
    confidence: best.score,
  };
}

/** @param {{ entries: Array<Record<string, unknown>> }} ledger @param {{ company?: string, role?: string, url?: string }} [context] */
export function answerTable(ledger, context = {}) {
  return ledger.entries.flatMap((entry) => answerVariants(entry).map((answer) => ({ entry, answer })))
    .filter(({ entry, answer }) => answer.answer !== null && isConfirmedAnswer(entry, answer) && matchesAnswerScope(answer, context))
    .map(({ entry, answer }) => ({
      re: new RegExp(escapeRegex(String(entry.pattern || entry.question)).replace(/\s+/g, '\\s+'), 'i'),
      value: String(answer.answer),
      source: answerReference(entry, answer),
      match: (question) => {
        const resolved = findReusableAnswer(question, { entries: [entry] }, context);
        return Boolean(resolved?.entry.id === entry.id && resolved?.answerRef === answerReference(entry, answer));
      },
      questionId: entry.id,
      answerRef: answerReference(entry, answer),
    }));
}

/**
 * Group unresolved or unconfirmed questions so repeated form wording is shown
 * once while retaining every posting context that produced it.
 * @param {{ entries: Array<Record<string, unknown>> }} ledger
 * @param {{ company?: string, role?: string, url?: string }} [context]
 */
export function pendingQuestions(ledger, context = {}) {
  return ledger.entries
    .filter((entry) => (entry.answer === null || entry.answer === undefined || !isConfirmedAnswer(entry))
      && (!context.company || matchesScope({ ...entry, scope: 'company' }, context) || (Array.isArray(entry.contexts) && entry.contexts.some((item) => normalizeKey(item.company) === normalizeKey(context.company)))))
    .map((entry) => ({
      questionId: entry.id,
      question: entry.question,
      answerStatus: entry.answer ? 'needs-confirmation' : 'unanswered',
      proposedAnswer: entry.answer || null,
      fieldKind: entry.fieldKind || null,
      required: entry.required === true,
      options: Array.isArray(entry.options) ? entry.options : [],
      sensitivity: entry.sensitivity || 'normal',
      contexts: Array.isArray(entry.contexts) ? entry.contexts : [],
      answerRef: answerReference(entry),
    }));
}

/** @param {Record<string, unknown>} entry @param {{ fieldKind?: string, options?: string[], sensitivity?: string }} metadata */
function compatibleQuestion(entry, metadata) {
  const entrySensitivity = String(entry.sensitivity || 'normal');
  const targetSensitivity = String(metadata.sensitivity || (metadata.fieldKind ? 'normal' : entrySensitivity));
  if (entrySensitivity !== targetSensitivity) return false;

  const entryKind = fieldKindFamily(String(entry.fieldKind || ''));
  const targetKind = fieldKindFamily(String(metadata.fieldKind || ''));
  if (entryKind && targetKind && entryKind !== targetKind) return false;

  const entryOptions = optionKeys(entry.options);
  const targetOptions = optionKeys(metadata.options);
  if (entryOptions.length && targetOptions.length && !entryOptions.some((option) => targetOptions.includes(option))) return false;
  return true;
}

/** @param {string} kind */
function fieldKindFamily(kind) {
  if (!kind) return '';
  if (kind === 'text' || kind === 'textarea') return 'free-text';
  if (kind === 'radio' || kind === 'checkbox' || kind === 'select' || kind === 'combobox') return 'choice';
  return kind;
}

/** @param {unknown} values */
function optionKeys(values) {
  return Array.isArray(values)
    ? values.map((value) => normalizeQuestion(String(value)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean)
    : [];
}

/** @param {string} file */
function printLedger(file) {
  const ledger = loadLedger(file);
  for (const entry of ledger.entries) {
    console.log(`${entry.id}\t${entry.status}\t${entry.answerStatus}\t${entry.scope}\t${entry.question}${entry.answer ? `\t${entry.answer}` : ''}${answerReference(entry) ? `\t${answerReference(entry)}` : ''}`);
  }
}

/** @param {string} file */
function printPending(file) {
  console.log(JSON.stringify(pendingQuestions(loadLedger(file)), null, 2));
}

function matchesScope(entry, context) {
  if (entry.scope === 'question') return true;
  if (entry.scope === 'global') return true;
  if (entry.scope === 'company') return normalizeKey(entry.company) === normalizeKey(context.company);
  if (entry.scope === 'role') return normalizeKey(entry.role) === normalizeKey(context.role);
  if (entry.scope === 'posting') return Boolean(entry.url && entry.url === context.url);
  return false;
}

function scopeRank(scope) {
  return { posting: 4, role: 3, company: 2, global: 1 }[scope] || 0;
}

function normalizeKey(value) {
  return normalizeQuestion(String(value || '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const command = process.argv[2] || 'list';
  const file = process.env.CAREER_OPS_QUESTION_LEDGER || DEFAULT_LEDGER_PATH;
  if (command === 'list') {
    printLedger(file);
  } else if (command === 'pending') {
    printPending(file);
  } else if (command === 'compact') {
    const ledger = loadLedger(file);
    const result = compactLedger(ledger);
    saveLedger(file, ledger);
    console.log(`Compacted ${result.mergedCount} duplicate question group${result.mergedCount === 1 ? '' : 's'}.`);
  } else if (command === 'answer') {
    const target = process.argv[3];
    const answer = process.argv[4];
    if (!target || answer === undefined) throw new Error('Usage: node apply/question-ledger.mjs answer <question-id-or-text> <answer> [--scope global|company|role]');
    const scopeIndex = process.argv.indexOf('--scope');
    const scope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : undefined;
    const companyIndex = process.argv.indexOf('--company');
    const company = companyIndex >= 0 ? process.argv[companyIndex + 1] : undefined;
    const roleIndex = process.argv.indexOf('--role');
    const role = roleIndex >= 0 ? process.argv[roleIndex + 1] : undefined;
    const entry = answerQuestion(file, target, answer, {
      scope,
      company,
      role,
      confirmSensitive: process.argv.includes('--confirm-sensitive'),
    });
    console.log(`Answered ${entry.id} (${entry.scope}).`);
  } else {
    console.error('Usage: node apply/question-ledger.mjs list|pending|compact|answer');
    process.exitCode = 1;
  }
}
