import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { beginRun, countSubmitted, finishRun, loadRuns, roleKey } from '../apply/application-runs.mjs';

test('run store prevents duplicate or unknown automatic retries', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-runs-'));
  try {
    const file = path.join(dir, 'runs.json');
    const item = { company: 'Acme', title: 'Backend Engineer', location: 'Remote US' };
    const key = roleKey(item);
    assert.equal(beginRun(file, key, item).ok, true);
    assert.equal(beginRun(file, key, item).ok, false);
    finishRun(file, key, { state: 'submission_unknown', reason: 'no confirmation' });
    assert.equal(beginRun(file, key, item).ok, false);
    assert.equal(loadRuns(file).runs[0].state, 'submission_unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run store counts only confirmed submissions for the day and company', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-runs-count-'));
  try {
    const file = path.join(dir, 'runs.json');
    const today = new Date().toISOString().slice(0, 10);
    const key = roleKey({ company: 'Acme', title: 'Data Engineer', location: 'NYC' });
    beginRun(file, key, { company: 'Acme', title: 'Data Engineer', location: 'NYC' });
    finishRun(file, key, { state: 'submitted', reason: 'confirmed' });
    assert.equal(countSubmitted(file, today), 1);
    assert.equal(countSubmitted(file, today, 'Other'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
