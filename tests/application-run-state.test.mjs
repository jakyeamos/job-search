import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireClearLock, loadClearState, saveClearState, updateClearState } from '../apply/application-run-state.mjs';

test('clear state persists progress and prevents concurrent runs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-clear-state-'));
  try {
    const stateFile = path.join(dir, 'state.json');
    const lockFile = path.join(dir, 'run.lock');
    saveClearState(stateFile, { status: 'running', phase: 'refreshing' });
    updateClearState(stateFile, { phase: 'applying', current: { id: 'one' } });
    assert.equal(loadClearState(stateFile).phase, 'applying');
    const release = acquireClearLock(lockFile);
    assert.throws(() => acquireClearLock(lockFile), /already running/);
    release();
    const releaseAgain = acquireClearLock(lockFile);
    releaseAgain();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dead clear lock can be reclaimed safely', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-clear-stale-'));
  try {
    const lockFile = path.join(dir, 'run.lock');
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
    const release = acquireClearLock(lockFile);
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
