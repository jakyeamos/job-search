import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_RUNS_PATH = path.join(ROOT, 'data', 'application-runs.json');

/** @param {string} file */
export function loadRuns(file = DEFAULT_RUNS_PATH) {
  if (!existsSync(file)) return { schemaVersion: 1, runs: [], path: file };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { schemaVersion: 1, runs: Array.isArray(parsed?.runs) ? parsed.runs : [], path: file };
  } catch {
    return { schemaVersion: 1, runs: [], path: file, loadError: 'application run store is not valid JSON' };
  }
}

/** @param {Record<string, unknown>} item */
export function roleKey(item) {
  return `role:${normalizeKey(item.company)}|${normalizeKey(item.title)}|${normalizeKey(item.location)}`;
}

/** @param {string} file @param {Record<string, unknown>} state */
export function saveRuns(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, runs: state.runs }, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** @param {string} file @param {string} key @param {Record<string, unknown>} metadata */
export function beginRun(file, key, metadata = {}) {
  const state = loadRuns(file);
  const existing = state.runs.find((run) => run.key === key);
  if (existing && ['started', 'submitted', 'submission_unknown'].includes(existing.state)) {
    return { ok: false, run: existing, reason: `run already ${existing.state}` };
  }
  const run = {
    key,
    ...metadata,
    state: 'started',
    attempt: Number(existing?.attempt || 0) + 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
  };
  state.runs = existing ? state.runs.map((item) => (item.key === key ? run : item)) : [...state.runs, run];
  saveRuns(file, state);
  return { ok: true, run };
}

/** @param {string} file @param {string} key @param {Record<string, unknown>} result */
export function finishRun(file, key, result) {
  const state = loadRuns(file);
  const run = state.runs.find((item) => item.key === key);
  if (!run) return null;
  const next = { ...run, state: result.state || 'failed', finishedAt: new Date().toISOString(), result };
  state.runs = state.runs.map((item) => (item.key === key ? next : item));
  saveRuns(file, state);
  return next;
}

/** @param {string} file @param {string} day @param {string} [company] */
export function countSubmitted(file, day = new Date().toISOString().slice(0, 10), company = '') {
  const companyKey = normalizeKey(company);
  return loadRuns(file).runs.filter((run) => {
    if (run.state !== 'submitted') return false;
    if (!String(run.finishedAt || '').startsWith(day)) return false;
    return !companyKey || normalizeKey(run.company) === companyKey;
  }).length;
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
