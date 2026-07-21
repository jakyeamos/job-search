#!/usr/bin/env node

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_LEDGER_PATH = path.join(ROOT, 'data', 'application-question-ledger.json');

const SENSITIVE_RE = /authorization|visa|sponsor|relocat|salary|compensation|background|legal|degree|education|citizenship|demographic|gender|race|veteran|disab|self[-\s]?identif|criminal|conviction|consent/i;
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

/** @param {string} file */
export function loadLedger(file = DEFAULT_LEDGER_PATH) {
  if (!existsSync(file)) return { schemaVersion: 1, entries: [], path: file };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      schemaVersion: 1,
      entries: Array.isArray(parsed?.entries) ? parsed.entries.filter((entry) => entry && typeof entry === 'object') : [],
      path: file,
    };
  } catch {
    return { schemaVersion: 1, entries: [], path: file, loadError: 'question ledger is not valid JSON' };
  }
}

/** @param {string} file @param {{ entries: Array<Record<string, unknown>> }} ledger */
export function saveLedger(file, ledger) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, entries: ledger.entries }, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** @param {string} question */
export function normalizeQuestion(question) {
  return String(question || '').replace(/[\u200b\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} question */
export function questionId(question) {
  return `q_${createHash('sha256').update(normalizeQuestion(question).toLowerCase()).digest('hex').slice(0, 16)}`;
}

/**
 * Produce a conservative semantic key without changing the legacy question id.
 * Exact ids remain stable; this key only lets new observations attach to an
 * existing canonical question when the core intent is the same.
 * @param {string} question
 */
export function canonicalQuestionKey(question) {
  const core = normalizeQuestion(question)
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
 * @param {string} file
 * @param {string} question
 * @param {Record<string, unknown>} [metadata]
 */
export function recordQuestion(file, question, metadata = {}) {
  const normalized = normalizeQuestion(question);
  if (!normalized || /^EEO\s*:/i.test(normalized)) return null;
  const ledger = loadLedger(file);
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
  const entry = {
    id,
    question: canonicalQuestion,
    aliases,
    questionKey: canonicalQuestionKey(canonicalQuestion),
    questionFingerprint: questionFingerprint(canonicalQuestion),
    pattern: metadata.pattern || existing?.pattern || canonicalQuestion,
    answer: existing?.answer ?? null,
    status: existing?.status || 'unanswered',
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
    expiresAt: existing?.expiresAt || metadata.expiresAt || null,
  };
  const nextEntries = existing
    ? ledger.entries.map((item) => (item.id === id ? entry : item))
    : [...ledger.entries, entry];
  saveLedger(file, { entries: nextEntries });
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
  const updated = {
    ...entry,
    answer: String(answer),
    status: 'answered',
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
  };
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
  const candidates = ledger.entries.filter((entry) => {
    if (entry.status !== 'answered' || entry.answer === null || entry.answer === undefined) return false;
    if (entry.expiresAt && Date.parse(String(entry.expiresAt)) <= now) return false;
    if (!questionMatchScore(entry, question, context)) return false;
    return matchesScope(entry, context);
  }).map((entry) => ({
    entry,
    score: questionMatchScore(entry, question, context),
  })).sort((a, b) => b.score - a.score
    || scopeRank(b.entry.scope) - scopeRank(a.entry.scope)
    || String(b.entry.updatedAt || '').localeCompare(String(a.entry.updatedAt || '')));
  if (!candidates.length) return null;
  const best = candidates[0];
  const competing = candidates.find((candidate) => candidate !== best
    && Math.abs(candidate.score - best.score) < 0.04
    && String(candidate.entry.answer) !== String(best.entry.answer));
  if (competing) return null;
  const chosen = best.entry;
  chosen.usageCount = Number(chosen.usageCount || 0) + 1;
  chosen.lastUsedAt = new Date().toISOString();
  return {
    answer: String(chosen.answer),
    entry: chosen,
    matchType: matchTypeFor(chosen, question, best.score),
    confidence: best.score,
  };
}

/** @param {{ entries: Array<Record<string, unknown>> }} ledger @param {{ company?: string, role?: string, url?: string }} [context] */
export function answerTable(ledger, context = {}) {
  return ledger.entries
    .filter((entry) => entry.status === 'answered' && entry.answer !== null && matchesScope(entry, context))
    .map((entry) => ({
      re: new RegExp(escapeRegex(String(entry.pattern || entry.question)).replace(/\s+/g, '\\s+'), 'i'),
      value: String(entry.answer),
      source: `question-ledger:${entry.id}`,
      match: (question) => {
        const resolved = findReusableAnswer(question, { entries: [entry] }, context);
        return Boolean(resolved?.entry.id === entry.id);
      },
      questionId: entry.id,
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
    console.log(`${entry.id}\t${entry.status}\t${entry.scope}\t${entry.question}${entry.answer ? `\t${entry.answer}` : ''}`);
  }
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
    console.error('Usage: node apply/question-ledger.mjs list|answer');
    process.exitCode = 1;
  }
}
