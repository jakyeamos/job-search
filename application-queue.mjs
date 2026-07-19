#!/usr/bin/env node

import { execFile } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import { recordApplication } from './apply/record-application.mjs';
import {
  normalizeUrl,
  readQueueState,
  renderQueueMarkdown,
  writeQueueState,
} from './queue-lib.mjs';
import { loadPolicy, submissionGate } from './apply/application-policy.mjs';
import { beginRun, countSubmitted, DEFAULT_RUNS_PATH, finishRun, roleKey } from './apply/application-runs.mjs';
import { DEFAULT_LEDGER_PATH } from './apply/question-ledger.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(ROOT, 'data', 'job-queue.json');
const ADAPTERS = {
  greenhouse: path.join(ROOT, 'apply', 'fill-greenhouse.mjs'),
  ashby: path.join(ROOT, 'apply', 'fill-ashby.mjs'),
  lever: path.join(ROOT, 'apply', 'fill-lever.mjs'),
};

/** @param {string} url */
export function adapterForUrl(url) {
  try {
    const host = new URL(normalizeUrl(url)).hostname.toLowerCase();
    if (host.includes('greenhouse')) return 'greenhouse';
    if (host.includes('ashbyhq')) return 'ashby';
    if (host.includes('lever.co')) return 'lever';
  } catch { /* unsupported or malformed URL */ }
  return null;
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} policy @param {string|null} adapter */
export function queueApplicationGate(item, policy, adapter) {
  if (!adapter) return { ok: false, reason: 'application URL is not a supported ATS adapter' };
  return submissionGate(policy, adapter, {
    fitScore: Number(item.fitScore || 0),
    // A supported ATS URL with uncertain alert metadata gets a browser-level
    // liveness check inside the adapter. Source-alert and expired entries stay blocked.
    liveness: item.liveness === 'uncertain' ? '' : String(item.liveness || ''),
  });
}

/** @param {string[]} args @param {string} flag @param {string} fallback */
function readFlag(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

/** @param {Record<string, unknown>} state */
function saveQueue(state) {
  writeQueueState(QUEUE_FILE, state);
  writeFileSync(path.join(ROOT, 'data', 'job-queue.md'), renderQueueMarkdown(state), 'utf8');
}

/** @param {string[]} command @param {number} timeoutMs */
async function runAdapter(command, timeoutMs) {
  try {
    const result = await execFileAsync(process.execPath, command, {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
    });
    return parseAdapterResult(`${result.stdout || ''}\n${result.stderr || ''}`);
  } catch (error) {
    const typed = /** @type {Error & {stdout?: string, stderr?: string}} */ (error);
    const combined = `${typed.stdout || ''}\n${typed.stderr || ''}`;
    return parseAdapterResult(combined) || { state: 'failed', reason: typed.message || String(error) };
  }
}

/** @param {string} output */
export function parseAdapterResult(output) {
  const lines = String(output || '').split('\n').filter((line) => line.startsWith('CAREER_OPS_APPLICATION_RESULT '));
  if (!lines.length) return null;
  try { return JSON.parse(lines.at(-1).slice('CAREER_OPS_APPLICATION_RESULT '.length)); }
  catch { return { state: 'failed', reason: 'adapter returned malformed machine-readable result' }; }
}

/** @param {Record<string, unknown>} item @param {string} adapter @param {{ headless: boolean }} options */
function adapterCommand(item, adapter, options) {
  const resume = String(item.resumeArtifact || '');
  const command = [ADAPTERS[adapter], String(item.applyUrl || item.canonicalUrl || '')];
  if (resume) command.push('--resume', resume);
  command.push(
    '--policy', path.join(ROOT, 'data', 'application-policy.json'),
    '--ledger', DEFAULT_LEDGER_PATH,
    '--submit',
    '--application-key', roleKey(item),
    '--company', String(item.company || ''),
    '--title', String(item.title || ''),
    '--fit-score', String(item.fitScore || 0),
    '--liveness', String(item.liveness || ''),
  );
  if (options.headless) command.push('--headless');
  return command;
}

/** @param {{ dryRun: boolean, limit: number, headed: boolean }} options */
export async function runApplicationQueue(options = { dryRun: false, limit: 6, headed: false }) {
  const policy = loadPolicy();
  const state = readQueueState(QUEUE_FILE);
  const items = (state.items || [])
    .filter((item) => item.selectedForToday && ['ready', 'in_review'].includes(item.status))
    .sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999));
  const dailyCap = Math.min(options.limit, policy.dailyLimit);
  const today = new Date().toISOString().slice(0, 10);
  let submittedToday = countSubmitted(DEFAULT_RUNS_PATH, today);
  const report = [];

  if (!policy.enabled || !policy.authorized) {
    return { ok: false, reason: 'automatic application submission is disabled; run `node apply/application-policy.mjs authorize` after reviewing the policy', report };
  }
  if (options.dryRun) {
    for (const item of items.slice(0, dailyCap)) {
      const adapter = adapterForUrl(String(item.applyUrl || item.canonicalUrl || ''));
      const gate = queueApplicationGate(item, policy, adapter);
      report.push({ id: item.id, company: item.company, title: item.title, adapter, action: gate.ok ? 'would-submit' : 'blocked', reason: gate.reason });
    }
    return { ok: true, dryRun: true, report };
  }

  for (const item of items) {
    if (submittedToday >= dailyCap) break;
    const adapter = adapterForUrl(String(item.applyUrl || item.canonicalUrl || ''));
    const gate = queueApplicationGate(item, policy, adapter);
    if (!gate.ok) {
      report.push(updateBlockedItem(state, item, gate.reason));
      continue;
    }
    if (!existsSync(String(item.resumeArtifact || ''))) {
      report.push(updateBlockedItem(state, item, `resume artifact is missing: ${item.resumeArtifact || '(none)'}`));
      continue;
    }
    if (countSubmitted(DEFAULT_RUNS_PATH, today, String(item.company || '')) >= policy.maxPerCompanyPerDay) {
      report.push(updateBlockedItem(state, item, `daily company limit reached for ${item.company || 'this company'}`));
      continue;
    }
    const key = roleKey(item);
    const started = beginRun(DEFAULT_RUNS_PATH, key, {
      id: item.id,
      company: item.company,
      title: item.title,
      location: item.location,
      adapter,
      url: item.applyUrl || item.canonicalUrl,
      resumeArtifact: item.resumeArtifact || null,
      fitScore: item.fitScore || null,
      lane: item.lane || null,
    });
    if (!started.ok) {
      report.push(updateBlockedItem(state, item, started.reason));
      continue;
    }

    const result = await runAdapter(adapterCommand(item, adapter, { headless: !options.headed }), 180_000)
      || { state: 'failed', reason: 'adapter did not return a machine-readable result' };
    finishRun(DEFAULT_RUNS_PATH, key, result);
    item.applicationState = result.state;
    item.applicationResult = { state: result.state, reason: result.reason, at: new Date().toISOString() };

    if (result.state === 'submitted') {
      item.status = 'applied';
      item.selectedForToday = false;
      item.queueRank = null;
      const recorded = recordApplication(ROOT, item);
      item.actionNote = recorded.reason;
      submittedToday += 1;
    } else {
      item.status = 'in_review';
      item.selectedForToday = false;
      item.queueRank = null;
    }
    saveQueue(state);
    report.push({ id: item.id, company: item.company, title: item.title, adapter, action: result.state, reason: result.reason });
  }
  return { ok: true, submittedToday, report };
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {string} reason */
function updateBlockedItem(state, item, reason) {
  item.applicationState = 'blocked';
  item.applicationBlocker = reason;
  item.selectedForToday = false;
  item.queueRank = null;
  saveQueue(state);
  return { id: item.id, company: item.company, title: item.title, action: 'blocked', reason };
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const args = process.argv.slice(2);
  const command = args[0] || 'run';
  const limit = Math.max(1, Math.min(10, Number(readFlag(args, '--limit', '6')) || 6));
  if (command === 'run' || command === 'dry-run') {
    const result = await runApplicationQueue({
      dryRun: command === 'dry-run' || args.includes('--dry-run'),
      limit,
      headed: args.includes('--headed'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } else if (command === 'status') {
    const policy = loadPolicy();
    console.log(JSON.stringify({ policy, runStore: DEFAULT_RUNS_PATH, queue: QUEUE_FILE }, null, 2));
  } else {
    console.error('Usage: node application-queue.mjs run|dry-run|status [--limit N] [--headed]');
    process.exitCode = 1;
  }
}
