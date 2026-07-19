import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_POLICY, loadPolicy, savePolicy, submissionGate } from '../apply/application-policy.mjs';

test('policy is disabled until explicitly authorized', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-policy-'));
  try {
    const file = path.join(dir, 'policy.json');
    assert.equal(loadPolicy(file).authorized, false);
    const enabled = savePolicy(file, { authorized: true, enabled: true });
    assert.equal(enabled.authorized, true);
    assert.equal(submissionGate(enabled, 'greenhouse', { fitScore: 4.2, liveness: 'active' }).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy blocks unsupported, stale, and low-fit applications', () => {
  const policy = { ...DEFAULT_POLICY, enabled: true, authorized: true };
  assert.equal(submissionGate(policy, 'workday', { fitScore: 5, liveness: 'active' }).ok, false);
  assert.equal(submissionGate(policy, 'greenhouse', { fitScore: 3.9, liveness: 'active' }).ok, false);
  assert.equal(submissionGate(policy, 'greenhouse', { fitScore: 4.4, liveness: 'uncertain' }).ok, false);
  assert.equal(submissionGate(policy, 'greenhouse', { fitScore: 4.4, liveness: 'active', needsReview: 1 }).ok, false);
});
