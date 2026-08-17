#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_CLEAR_STATE_PATH = path.join(ROOT, 'data', 'application-clear-state.json');
export const DEFAULT_CLEAR_LOCK_PATH = path.join(ROOT, 'data', 'application-clear.lock');

export function loadClearState(file = DEFAULT_CLEAR_STATE_PATH) {
  if (!existsSync(file)) return { schemaVersion: 1, status: 'idle', path: file };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? { schemaVersion: 1, ...parsed, path: file }
      : { schemaVersion: 1, status: 'idle', path: file };
  } catch {
    return { schemaVersion: 1, status: 'failed', reason: 'clear state is not valid JSON', path: file };
  }
}

export function saveClearState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...state }, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  return loadClearState(file);
}

export function updateClearState(file, changes = {}) {
  return saveClearState(file, {
    ...loadClearState(file),
    ...changes,
    updatedAt: new Date().toISOString(),
  });
}

export function acquireClearLock(file = DEFAULT_CLEAR_LOCK_PATH) {
  return acquireExclusiveLock(file, 'application queue clear');
}

export function acquireExclusiveLock(file, label = 'application run') {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(file, 'wx');
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
      return () => {
        try { closeSync(descriptor); } catch { /* already closed */ }
        try { unlinkSync(file); } catch { /* already removed */ }
      };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code !== 'EEXIST' || attempt > 0) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} is already running (${reason})`);
      }
      const existing = readJson(file);
      if (existing?.pid && processAlive(Number(existing.pid))) {
        throw new Error(`${label} is already running (pid ${existing.pid})`);
      }
      try { unlinkSync(file); } catch {
        throw new Error(`${label} is already running (lock could not be reclaimed)`);
      }
    }
  }
  throw new Error(`unable to acquire ${label} lock`);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
