#!/usr/bin/env node

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_LEDGER_PATH = path.join(ROOT, 'data', 'application-question-ledger.json');

const SENSITIVE_RE = /authorization|visa|sponsor|relocat|salary|compensation|background|legal|degree|education|citizenship|demographic|gender|race|veteran|disab|self[-\s]?identif|criminal|conviction|consent/i;

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

/** @param {string} question */
export function isSensitiveQuestion(question) {
  return SENSITIVE_RE.test(normalizeQuestion(question));
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
  const id = questionId(normalized);
  const now = new Date().toISOString();
  const existing = ledger.entries.find((entry) => entry.id === id);
  const context = {
    company: metadata.company || null,
    role: metadata.role || null,
    url: metadata.url || null,
    queueId: metadata.queueId || null,
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
    question: normalized,
    pattern: metadata.pattern || normalized,
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
  const normalized = normalizeQuestion(question).toLowerCase();
  const now = Date.now();
  const candidates = ledger.entries.filter((entry) => {
    if (entry.status !== 'answered' || entry.answer === null || entry.answer === undefined) return false;
    if (entry.expiresAt && Date.parse(String(entry.expiresAt)) <= now) return false;
    if (!matchesQuestion(entry, normalized)) return false;
    return matchesScope(entry, context);
  }).sort((a, b) => scopeRank(b.scope) - scopeRank(a.scope));
  if (!candidates.length) return null;
  const chosen = candidates[0];
  chosen.usageCount = Number(chosen.usageCount || 0) + 1;
  chosen.lastUsedAt = new Date().toISOString();
  return String(chosen.answer);
}

/** @param {{ entries: Array<Record<string, unknown>> }} ledger @param {{ company?: string, role?: string, url?: string }} [context] */
export function answerTable(ledger, context = {}) {
  return ledger.entries
    .filter((entry) => entry.status === 'answered' && entry.answer !== null && matchesScope(entry, context))
    .map((entry) => ({
      re: new RegExp(escapeRegex(String(entry.pattern || entry.question)).replace(/\s+/g, '\\s+'), 'i'),
      value: String(entry.answer),
      source: `question-ledger:${entry.id}`,
    }));
}

/** @param {string} file */
function printLedger(file) {
  const ledger = loadLedger(file);
  for (const entry of ledger.entries) {
    console.log(`${entry.id}\t${entry.status}\t${entry.scope}\t${entry.question}${entry.answer ? `\t${entry.answer}` : ''}`);
  }
}

function matchesQuestion(entry, normalized) {
  const pattern = normalizeQuestion(String(entry.pattern || entry.question || '')).toLowerCase();
  return normalized === pattern || normalized.includes(pattern) || pattern.includes(normalized);
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
