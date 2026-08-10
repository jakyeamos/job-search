#!/usr/bin/env node
// @ts-check
/**
 * pipeline-fast-runner.mjs — one persistent, lean Codex queue worker.
 *
 * The local preprocessor performs grouped network extraction and deterministic
 * filtering. One `codex exec` invocation then handles the whole (default 30)
 * manifest, amortizing startup/plugin cost across the batch.
 *
 * By default the worker passes `--ignore-user-config`. Codex authentication is
 * still read from CODEX_HOME, but unrelated plugins, MCP servers, and desktop
 * feature configuration are not initialized. Repository AGENTS/rules remain in
 * force because `--ignore-rules` is intentionally never passed.
 *
 * Usage:
 *   node pipeline-fast-runner.mjs --prepare-only
 *   node pipeline-fast-runner.mjs
 *   node pipeline-fast-runner.mjs --limit 50
 *   node pipeline-fast-runner.mjs --model gpt-5
 *   node pipeline-fast-runner.mjs --normal-config
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { prepareFastPass } from './pipeline-fast-pass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST = path.join(ROOT, 'batch', 'fast-pass', 'latest.json');
const RESULT_SCHEMA = path.join(ROOT, 'batch', 'pipeline-fast-result.schema.json');
const LAST_MESSAGE = path.join(ROOT, 'batch', 'fast-pass', 'last-result.json');

export function parseRunnerArgs(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  return {
    limit: Math.max(1, Number(value('--limit', 30))),
    concurrency: Math.max(1, Number(value('--concurrency', 6))),
    gapMs: Math.max(0, Number(value('--gap-ms', 0))),
    manifest: path.resolve(String(value('--manifest', DEFAULT_MANIFEST))),
    model: String(value('--model', '')),
    completionGraceMs: Math.max(0, Number(value('--completion-grace-ms', 30_000))),
    shutdownGraceMs: Math.max(1_000, Number(value('--shutdown-grace-ms', 10_000))),
    prepareOnly: argv.includes('--prepare-only'),
    normalConfig: argv.includes('--normal-config'),
  };
}

/**
 * The lean profile is expressed as explicit invocation flags rather than a
 * machine-global config file. This keeps the optimization repository-local and
 * avoids copying auth or mutating ~/.codex.
 *
 * @param {{ model?: string, normalConfig?: boolean }} options
 */
export function buildCodexArgs(options = {}) {
  const args = [
    'exec',
    '-C', ROOT,
    '-s', 'workspace-write',
    '--ephemeral',
    '--color', 'never',
    '--output-schema', RESULT_SCHEMA,
    '-o', LAST_MESSAGE,
  ];
  if (!options.normalConfig) args.push('--ignore-user-config');
  if (options.model) args.push('--model', options.model);
  return args;
}

/** @param {string} manifestPath @param {number} requested */
export function buildWorkerPrompt(manifestPath, requested) {
  return [
    'Run the persistent Career Ops fast-queue worker.',
    `Manifest: ${path.relative(ROOT, manifestPath)}`,
    `Process exactly all ${requested} manifest items in this one session.`,
    'Follow batch/pipeline-fast-worker.md and modes/discovery-card.md.',
    'Use the pre-extracted descriptions and deterministic routes; do not run per-role agents.',
    'Do not submit applications or generate HTML/PDF/resume artifacts.',
  ].join('\n');
}

/**
 * Check whether the structured final message proves that a worker completed
 * the requested batch and verified the resulting pipeline.
 *
 * @param {unknown} value
 * @param {number} requested
 */
export function isCompletedWorkerResult(value, requested) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.requested === requested
    && value.processed === requested
    && value.errors === 0
    && value.pipeline_verified === true,
  );
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   completionFile: string,
 *   completionBaselineMtimeMs: number,
 *   requested: number,
 *   completionGraceMs: number,
 *   shutdownGraceMs: number,
 * }} options
 */
function runStreaming(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    let completionSeenAt = 0;
    let terminationSentAt = 0;
    let recoveredCompletedWorker = false;

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (!completionSeenAt) {
        try {
          const resultMtimeMs = statSync(options.completionFile).mtimeMs;
          if (resultMtimeMs <= options.completionBaselineMtimeMs) return;
          const result = JSON.parse(readFileSync(options.completionFile, 'utf8'));
          if (isCompletedWorkerResult(result, options.requested)) completionSeenAt = now;
        } catch {
          // The output file may be absent or between atomic write steps.
        }
        return;
      }

      if (!terminationSentAt && now - completionSeenAt >= options.completionGraceMs) {
        recoveredCompletedWorker = true;
        terminationSentAt = now;
        console.error(
          `pipeline-fast-runner: verified worker result persisted but child did not exit `
          + `within ${options.completionGraceMs}ms; sending SIGTERM`,
        );
        child.kill('SIGTERM');
        return;
      }

      if (terminationSentAt && now - terminationSentAt >= options.shutdownGraceMs) {
        child.kill('SIGKILL');
      }
    }, 1_000);
    watchdog.unref();

    child.once('error', (error) => {
      clearInterval(watchdog);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearInterval(watchdog);
      resolve({
        code: recoveredCompletedWorker ? 0 : (code ?? 1),
        rawCode: code,
        signal,
        recoveredCompletedWorker,
      });
    });
  });
}

async function main() {
  const options = parseRunnerArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const manifest = await prepareFastPass({
    root: ROOT,
    limit: options.limit,
    concurrency: options.concurrency,
    gapMs: options.gapMs,
  });
  mkdirSync(path.dirname(options.manifest), { recursive: true });
  writeFileSync(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const preparation = {
    manifest: path.relative(ROOT, options.manifest),
    requested: manifest.requested,
    routes: manifest.routes,
    extractionMs: manifest.elapsedMs,
  };
  console.log(JSON.stringify(preparation));

  if (options.prepareOnly || manifest.requested === 0) {
    console.log(options.prepareOnly ? 'Prepare-only: Codex worker not started.' : 'No pending roles found.');
    return;
  }

  const args = buildCodexArgs(options);
  args.push(buildWorkerPrompt(options.manifest, manifest.requested));
  let completionBaselineMtimeMs = 0;
  try {
    completionBaselineMtimeMs = statSync(LAST_MESSAGE).mtimeMs;
  } catch {
    // The first worker run has no prior result file.
  }
  const result = await runStreaming('codex', args, {
    completionFile: LAST_MESSAGE,
    completionBaselineMtimeMs,
    requested: manifest.requested,
    completionGraceMs: options.completionGraceMs,
    shutdownGraceMs: options.shutdownGraceMs,
  });
  const elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    ...preparation,
    codexExitCode: result.code,
    rawCodexExitCode: result.rawCode,
    signal: result.signal,
    recoveredCompletedWorker: result.recoveredCompletedWorker,
    elapsedMs,
  }));
  if (result.code !== 0) process.exitCode = result.code;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`pipeline-fast-runner: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
