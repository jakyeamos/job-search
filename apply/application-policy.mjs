#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_POLICY_PATH = path.join(ROOT, 'data', 'application-policy.json');

export const DEFAULT_POLICY = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  authorized: false,
  dailyLimit: 6,
  minFitScore: 4,
  maxPerCompanyPerDay: 1,
  allowedAdapters: ['greenhouse', 'ashby', 'lever'],
  requireActivePosting: true,
  requireKnownRequiredAnswers: true,
  stopOnCaptcha: true,
  stopOnMfa: true,
  allowMarketingConsent: false,
  generateCoverLetter: true,
});

/** @param {string} file */
export function loadPolicy(file = DEFAULT_POLICY_PATH) {
  if (!existsSync(file)) return { ...DEFAULT_POLICY, path: file };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return normalizePolicy({ ...DEFAULT_POLICY, ...(parsed && typeof parsed === 'object' ? parsed : {}), path: file });
  } catch {
    return { ...DEFAULT_POLICY, path: file, loadError: 'policy file is not valid JSON' };
  }
}

/** @param {Record<string, unknown>} policy */
export function normalizePolicy(policy) {
  return {
    ...DEFAULT_POLICY,
    ...policy,
    schemaVersion: 1,
    enabled: policy.enabled === true,
    authorized: policy.authorized === true,
    dailyLimit: clampInt(policy.dailyLimit, 1, 10, DEFAULT_POLICY.dailyLimit),
    minFitScore: clampNumber(policy.minFitScore, 0, 5, DEFAULT_POLICY.minFitScore),
    maxPerCompanyPerDay: clampInt(policy.maxPerCompanyPerDay, 1, 10, DEFAULT_POLICY.maxPerCompanyPerDay),
    allowedAdapters: Array.isArray(policy.allowedAdapters)
      ? policy.allowedAdapters.filter((value) => typeof value === 'string')
      : [...DEFAULT_POLICY.allowedAdapters],
    path: policy.path,
  };
}

/** @param {string} file @param {Partial<typeof DEFAULT_POLICY>} changes */
export function savePolicy(file = DEFAULT_POLICY_PATH, changes = {}) {
  const current = loadPolicy(file);
  const next = normalizePolicy({ ...current, ...changes, path: file });
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(stripRuntimeFields(next), null, 2)}\n`, 'utf8');
  renameSync(temp, file);
  return next;
}

/** @param {string} adapter @param {Record<string, unknown>} context */
export function submissionGate(policy, adapter, context = {}) {
  if (policy.loadError) return { ok: false, reason: policy.loadError };
  if (!policy.enabled || !policy.authorized) return { ok: false, reason: 'automatic submission is disabled or not authorized' };
  if (!policy.allowedAdapters.includes(adapter)) return { ok: false, reason: `${adapter} is not enabled in the application policy` };
  if (policy.requireActivePosting && context.liveness && context.liveness !== 'active') {
    return { ok: false, reason: `posting liveness is ${context.liveness}, not active` };
  }
  if (context.fitScore !== undefined && context.fitScore !== null && Number(context.fitScore) < policy.minFitScore) {
    return { ok: false, reason: `fit score ${Number(context.fitScore).toFixed(1)} is below the ${policy.minFitScore.toFixed(1)} policy minimum` };
  }
  if (policy.requireKnownRequiredAnswers && Number(context.needsReview || 0) > 0) {
    return { ok: false, reason: `${context.needsReview} required or unresolved field(s) need review` };
  }
  return { ok: true, reason: 'submission policy satisfied' };
}

/** @param {string|Date} value */
export function dayKey(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** @param {Record<string, unknown>} policy */
function stripRuntimeFields(policy) {
  const { path: _path, loadError: _loadError, ...persisted } = policy;
  return persisted;
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const command = process.argv[2] || 'status';
  const file = process.env.CAREER_OPS_APPLICATION_POLICY || DEFAULT_POLICY_PATH;
  if (command === 'authorize') {
    const policy = savePolicy(file, { authorized: true, enabled: true });
    console.log(`Automatic application submission enabled (daily limit ${policy.dailyLimit}, minimum fit ${policy.minFitScore.toFixed(1)}).`);
  } else if (command === 'disable') {
    savePolicy(file, { enabled: false });
    console.log('Automatic application submission disabled.');
  } else if (command === 'status') {
    const policy = loadPolicy(file);
    console.log(JSON.stringify({ ...policy, path: file }, null, 2));
  } else {
    console.error('Usage: node apply/application-policy.mjs status|authorize|disable');
    process.exitCode = 1;
  }
}
