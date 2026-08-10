import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexArgs,
  buildWorkerPrompt,
  isCompletedWorkerResult,
  parseRunnerArgs,
} from '../pipeline-fast-runner.mjs';

test('fast runner defaults to one 30-role persistent chunk', () => {
  const parsed = parseRunnerArgs([]);
  assert.equal(parsed.limit, 30);
  assert.equal(parsed.concurrency, 6);
  assert.equal(parsed.completionGraceMs, 30_000);
  assert.equal(parsed.shutdownGraceMs, 10_000);
  assert.equal(parsed.prepareOnly, false);
  assert.equal(parsed.normalConfig, false);
});

test('worker result only proves completion when the whole batch is verified', () => {
  assert.equal(isCompletedWorkerResult({
    requested: 30,
    processed: 30,
    errors: 0,
    pipeline_verified: true,
  }, 30), true);
  assert.equal(isCompletedWorkerResult({
    requested: 30,
    processed: 30,
    errors: 0,
    pipeline_verified: false,
  }, 30), false);
  assert.equal(isCompletedWorkerResult({
    requested: 30,
    processed: 29,
    errors: 0,
    pipeline_verified: true,
  }, 30), false);
});

test('lean Codex args ignore user plugins while preserving repository rules', () => {
  const args = buildCodexArgs({});
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--output-schema'));
  assert.ok(!args.includes('--ignore-rules'));
  assert.equal(args.filter((arg) => arg === 'exec').length, 1);
});

test('normal config is an explicit opt-out from the lean worker profile', () => {
  const args = buildCodexArgs({ normalConfig: true, model: 'gpt-test' });
  assert.ok(!args.includes('--ignore-user-config'));
  assert.deepEqual(args.slice(-2), ['--model', 'gpt-test']);
});

test('worker prompt requires the whole manifest in one session and forbids submission', () => {
  const prompt = buildWorkerPrompt('/tmp/career-ops/batch/fast-pass/latest.json', 30);
  assert.match(prompt, /all 30 manifest items in this one session/);
  assert.match(prompt, /do not run per-role agents/i);
  assert.match(prompt, /Do not submit applications/);
});
