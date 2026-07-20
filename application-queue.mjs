#!/usr/bin/env node

import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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
import { registerResumeArtifact, resolveResumeArtifact } from './resume-contract.mjs';
import { generateApplicationArtifacts, inspectArtifactCache } from './apply/application-artifacts.mjs';
import {
  acquireClearLock,
  DEFAULT_CLEAR_STATE_PATH,
  updateClearState,
} from './apply/application-run-state.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(ROOT, 'data', 'job-queue.json');
const ADAPTERS = {
  greenhouse: path.join(ROOT, 'apply', 'fill-greenhouse.mjs'),
  ashby: path.join(ROOT, 'apply', 'fill-ashby.mjs'),
  lever: path.join(ROOT, 'apply', 'fill-lever.mjs'),
};

const TERMINAL_APPLICATION_STATES = new Set([
  'submitted',
  'submission_unknown',
  'blocked_by_antispam',
  'blocked_by_captcha',
  'blocked_by_mfa',
  'blocked_by_question',
  'blocked_by_human',
  'blocked',
  'human_handoff_timeout',
  'human_handoff_closed',
]);

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
export async function runAdapter(command, timeoutMs) {
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

/** @param {string} output @returns {{ items: Array<Record<string, unknown>> }|null} */
export function parseQueuePreview(output) {
  const line = String(output || '').split('\n').find((candidate) => candidate.startsWith('CAREER_OPS_QUEUE_PREVIEW '));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice('CAREER_OPS_QUEUE_PREVIEW '.length));
    return Array.isArray(parsed) ? { items: parsed } : null;
  } catch {
    return null;
  }
}

/** @param {number} submittedThisRun @param {boolean} dryRun */
export function shouldRunPostApplicationOutreach(submittedThisRun, dryRun) {
  return !dryRun && submittedThisRun > 0;
}

/** @returns {Promise<{ triggered: boolean, ok: boolean, output?: string, reason?: string }>} */
export async function runPostApplicationOutreach() {
  try {
    const result = await execFileAsync(process.execPath, [path.join(ROOT, 'outreach.mjs'), 'process'], {
      cwd: ROOT,
      timeout: 180_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    return {
      triggered: true,
      ok: true,
      output: `${result.stdout || ''}\n${result.stderr || ''}`.trim(),
    };
  } catch (error) {
    const typed = /** @type {Error & {stdout?: string, stderr?: string}} */ (error);
    return {
      triggered: true,
      ok: false,
      output: `${typed.stdout || ''}\n${typed.stderr || ''}`.trim(),
      reason: typed.message || String(error),
    };
  }
}

/** @param {Record<string, unknown>} item @param {string} adapter @param {{ headless?: boolean, humanHandoff?: boolean, humanTimeoutSeconds?: number, prepareOnly?: boolean, cdpEndpoint?: string }} options @param {{ artifactPath: string }} resume @param {{ coverLetterPdf?: string, coverLetterText?: string }} [artifacts] */
export function adapterCommand(item, adapter, options, resume, artifacts = {}) {
  const command = [ADAPTERS[adapter], String(item.applyUrl || item.canonicalUrl || '')];
  if (resume.artifactPath) command.push('--resume', resume.artifactPath);
  if (artifacts.coverLetterPdf) command.push('--cover', artifacts.coverLetterPdf);
  if (artifacts.coverLetterText && existsFile(artifacts.coverLetterText)) {
    command.push('--cover-text', readFileSync(artifacts.coverLetterText, 'utf8'));
  }
  command.push(
    '--policy', path.join(ROOT, 'data', 'application-policy.json'),
    '--ledger', DEFAULT_LEDGER_PATH,
    '--application-key', roleKey(item),
    '--queue-id', String(item.id || ''),
    '--company', String(item.company || ''),
    '--title', String(item.title || ''),
    '--lane', String(item.lane || ''),
    '--job-description', String(item.description || ''),
    '--fit-score', String(item.fitScore || 0),
    '--liveness', String(item.liveness || ''),
  );
  if (options.prepareOnly) {
    command.push('--prepare-only');
  } else if (options.humanHandoff) {
    command.push('--human-handoff', '--human-timeout', String(options.humanTimeoutSeconds || 600));
  } else {
    command.push('--submit');
  }
  if (options.cdpEndpoint) command.push('--cdp-endpoint', options.cdpEndpoint);
  if (options.headless) command.push('--headless');
  return command;
}

/** @param {string} file */
function existsFile(file) {
  return Boolean(file && existsSync(file));
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} policy */
export async function prepareApplicationArtifacts(item, policy) {
  let artifacts;
  try {
    artifacts = await generateApplicationArtifacts(item, {
      includeCoverLetter: policy.generateCoverLetter !== false,
    });
  } catch (error) {
    artifacts = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!artifacts.ok) return artifacts;
  if (artifacts.jobDescription && String(artifacts.jobDescription).length > String(item.description || '').length) {
    item.description = artifacts.jobDescription;
  }
  if (!item.lane && artifacts.lane) item.lane = artifacts.lane;
  const registered = registerResumeArtifact(item, ROOT, {
    artifactPath: artifacts.resumePdf,
    htmlPath: artifacts.resumeHtml,
    sourceMode: 'tailored-generated',
    auditStatus: 'passed',
  });
  const resume = resolveResumeArtifact({ ...item, resumeManifest: registered.manifestPath }, ROOT);
  if (!resume.ok) return { ok: false, reason: resume.reason };
  item.resumeContractVersion = resume.request.contractVersion;
  item.resumeJobKey = resume.request.jobKey;
  item.resumeManifest = resume.manifestPath;
  item.resumeArtifact = resume.artifactPath;
  item.resumeFormat = resume.request.paperFormat;
  item.resumeProjects = resume.request.selectedProjects;
  item.resumeStatus = `${resume.manifest.sourceMode}; audit ${resume.manifest.auditStatus}`;
  item.coverLetterArtifact = artifacts.coverLetterPdf || null;
  item.coverLetterText = artifacts.coverLetterText || null;
  item.applicationArtifactManifest = artifacts.manifestPath;
  return { ok: true, artifacts, resume };
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {Record<string, unknown>} result */
export function persistApplicationResult(state, item, result) {
  const normalizedState = result.state === 'blocked' && Array.isArray(result.needsReview) && result.needsReview.length
    ? 'blocked_by_question'
    : result.state === 'blocked' && /submit control|captcha|mfa|sign[- ]in|human handoff|verification/i.test(String(result.reason || ''))
      ? 'blocked_by_human'
      : String(result.state || 'failed');
  const at = new Date().toISOString();
  item.applicationState = normalizedState;
  item.applicationResult = {
    state: normalizedState,
    reason: result.reason || '',
    at,
    adapter: result.adapter || null,
    queueId: result.queueId || item.id,
    needsReview: Array.isArray(result.needsReview) ? result.needsReview : [],
    submissionEvidence: result.submissionEvidence || null,
  };
  item.selectedForToday = false;
  item.queueRank = null;
  if (normalizedState === 'submitted') {
    item.status = 'applied';
    item.appliedAt = at;
    const recorded = recordApplication(ROOT, item);
    item.actionNote = recorded.reason;
  } else {
    item.status = 'in_review';
  }
  saveQueue(state);
  return { submitted: normalizedState === 'submitted', state: normalizedState, at };
}

/**
 * Select the clear-run batch from the refreshed queue. The normal review queue
 * can contain alert-only and unsupported links; automatic clearing may only
 * select active, high-fit, supported ATS postings and one role per company.
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} policy
 * @param {number} limit
 * @returns {Array<Record<string, unknown>>}
 */
export function selectClearItems(state, policy, limit) {
  const selectedCompanies = new Set();
  const candidates = (state.items || [])
    .filter((item) => ['ready', 'in_review'].includes(String(item.status || '')))
    .filter((item) => !TERMINAL_APPLICATION_STATES.has(String(item.applicationState || '')))
    .filter((item) => Number(item.fitScore || 0) >= Number(policy.minFitScore || 0))
    .filter((item) => String(item.liveness || '') === 'active')
    .filter((item) => Boolean(adapterForUrl(String(item.applyUrl || item.canonicalUrl || ''))))
    .sort((left, right) => Number(right.fitScore || 0) - Number(left.fitScore || 0)
      || String(right.postedAt || '').localeCompare(String(left.postedAt || ''))
      || String(left.id || '').localeCompare(String(right.id || '')))
    .filter((item) => {
      const company = String(item.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (company && selectedCompanies.has(company)) return false;
      if (company) selectedCompanies.add(company);
      return true;
    })
    .slice(0, Math.max(1, Math.min(Number(limit || policy.dailyLimit || 6), Number(policy.dailyLimit || 6))));
  const selectedIds = new Set(candidates.map((item) => item.id));
  state.items = (state.items || []).map((item) => ({
    ...item,
    selectedForToday: selectedIds.has(item.id),
    queueRank: selectedIds.has(item.id) ? candidates.findIndex((candidate) => candidate.id === item.id) + 1 : null,
  }));
  state.generatedAt = new Date().toISOString();
  return candidates;
}

/** @param {{ dryRun?: boolean, limit?: number, headed?: boolean, onProgress?: (event: Record<string, unknown>) => void }} options */
export async function runApplicationQueue(options = { dryRun: false, limit: 6, headed: false }) {
  const policy = loadPolicy();
  const state = readQueueState(QUEUE_FILE);
  const items = (state.items || [])
    .filter((item) => item.selectedForToday
      && ['ready', 'in_review'].includes(item.status)
      && !['submitted', 'submission_unknown', 'blocked', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_question', 'blocked_by_human'].includes(String(item.applicationState || '')))
    .sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999));
  const dailyCap = Math.min(Number(options.limit || policy.dailyLimit), policy.dailyLimit);
  const today = new Date().toISOString().slice(0, 10);
  let submittedToday = countSubmitted(DEFAULT_RUNS_PATH, today);
  let submittedThisRun = 0;
  const report = [];

  if (!policy.enabled || !policy.authorized) {
    return { ok: false, reason: 'automatic application submission is disabled; run `node apply/application-policy.mjs authorize` after reviewing the policy', report };
  }
  if (options.dryRun) {
    for (const item of items.slice(0, dailyCap)) {
      const adapter = adapterForUrl(String(item.applyUrl || item.canonicalUrl || ''));
      const gate = queueApplicationGate(item, policy, adapter);
      if (!gate.ok) {
        report.push({ id: item.id, company: item.company, title: item.title, adapter, action: 'blocked', reason: gate.reason });
        continue;
      }
      const resume = resolveResumeArtifact(item, ROOT);
      const artifacts = inspectArtifactCache(item);
      report.push({
        id: item.id,
        company: item.company,
        title: item.title,
        adapter,
        resumeStatus: resume.status,
        artifactStatus: artifacts.status,
        artifactManifest: artifacts.manifestPath,
        action: artifacts.status === 'ready' && resume.ok ? 'would-submit' : 'would-generate-and-submit',
        reason: gate.reason,
      });
    }
    return { ok: true, dryRun: true, report };
  }

  for (const item of items.slice(0, dailyCap)) {
    if (submittedToday >= dailyCap) break;
    options.onProgress?.({ phase: 'applying', id: item.id, company: item.company, title: item.title, status: 'started' });
    const adapter = adapterForUrl(String(item.applyUrl || item.canonicalUrl || ''));
    const gate = queueApplicationGate(item, policy, adapter);
    if (!gate.ok) {
      report.push(updateBlockedItem(state, item, gate.reason));
      continue;
    }
    const prepared = await prepareApplicationArtifacts(item, policy);
    if (!prepared.ok) {
      report.push(updateBlockedItem(state, item, `application artifact generation failed: ${prepared.reason}`));
      continue;
    }
    const { artifacts, resume } = prepared;
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
      resumeArtifact: resume.artifactPath,
      resumeManifest: resume.manifestPath,
      resumeStatus: resume.status,
      coverLetterArtifact: item.coverLetterArtifact,
      applicationArtifactManifest: item.applicationArtifactManifest,
      fitScore: item.fitScore || null,
      lane: item.lane || null,
    });
    if (!started.ok) {
      report.push(updateBlockedItem(state, item, started.reason));
      continue;
    }

    const result = await runAdapter(adapterCommand(item, adapter, { headless: !options.headed }, resume, {
      coverLetterPdf: item.coverLetterArtifact,
      coverLetterText: item.coverLetterText,
    }), 180_000)
      || { state: 'failed', reason: 'adapter did not return a machine-readable result' };
    finishRun(DEFAULT_RUNS_PATH, key, result);
    const persisted = persistApplicationResult(state, item, result);
    if (persisted.submitted) {
      submittedToday += 1;
      submittedThisRun += 1;
    }
    options.onProgress?.({ phase: 'applying', id: item.id, company: item.company, title: item.title, status: persisted.state, reason: result.reason });
    report.push({ id: item.id, company: item.company, title: item.title, adapter, action: persisted.state, reason: result.reason });
  }
  const outreach = shouldRunPostApplicationOutreach(submittedThisRun, options.dryRun)
    ? await runPostApplicationOutreach()
    : {
      triggered: false,
      ok: true,
      reason: options.dryRun ? 'dry run does not trigger outreach' : 'no confirmed submissions in this run',
    };
  return { ok: true, submittedToday, submittedThisRun, outreach, report };
}

/**
 * Explicit recovery path for a prior anti-bot or uncertain result. This is
 * never called by the scheduled queue; the user must invoke `handoff` directly.
 * @param {string} queueId
 * @param {{ timeoutSeconds?: number }} [options]
 */
export async function runApplicationHandoff(queueId, options = {}) {
  const module = await import('./application-handoff.mjs');
  return module.runHandoffBatch([queueId], options);
}

/**
 * Resume exactly one application after the user has answered a blocking form
 * question. This is the only path that may reopen a question-blocked run.
 * @param {string} queueId
 * @param {{ onProgress?: (event: Record<string, unknown>) => void }} [options]
 */
export async function resumeApplication(queueId, options = {}) {
  const policy = loadPolicy();
  if (!policy.enabled || !policy.authorized) return { ok: false, reason: 'application policy is disabled or not authorized' };
  const state = readQueueState(QUEUE_FILE);
  const item = (state.items || []).find((candidate) => candidate.id === queueId);
  if (!item) return { ok: false, reason: `queue item not found: ${queueId}` };
  if (item.applicationState !== 'blocked_by_question') {
    return { ok: false, reason: `question resume requires blocked_by_question; found ${item.applicationState || 'none'}` };
  }
  const adapter = adapterForUrl(String(item.applyUrl || item.canonicalUrl || ''));
  const gate = queueApplicationGate(item, policy, adapter);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const prepared = await prepareApplicationArtifacts(item, policy);
  if (!prepared.ok) return { ok: false, reason: `application artifact generation failed: ${prepared.reason}` };
  const { artifacts, resume } = prepared;
  const key = roleKey(item);
  const started = beginRun(DEFAULT_RUNS_PATH, key, {
    id: item.id,
    company: item.company,
    title: item.title,
    location: item.location,
    adapter,
    url: item.applyUrl || item.canonicalUrl,
    resumeArtifact: resume.artifactPath,
    resumeManifest: resume.manifestPath,
    resumeStatus: resume.status,
    coverLetterArtifact: item.coverLetterArtifact,
    applicationArtifactManifest: item.applicationArtifactManifest,
    fitScore: item.fitScore || null,
    lane: item.lane || null,
  }, { allowQuestionResume: true });
  if (!started.ok) return { ok: false, reason: started.reason };
  options.onProgress?.({ phase: 'resuming', id: item.id, company: item.company, title: item.title, status: 'started' });
  const result = await runAdapter(adapterCommand(item, adapter, { headless: true }, resume, {
    coverLetterPdf: item.coverLetterArtifact,
    coverLetterText: item.coverLetterText,
  }), 180_000) || { state: 'failed', reason: 'adapter did not return a machine-readable result' };
  finishRun(DEFAULT_RUNS_PATH, key, result);
  const persisted = persistApplicationResult(state, item, result);
  const outreach = persisted.submitted ? await runPostApplicationOutreach() : { triggered: false, ok: true, reason: 'no confirmed submission; outreach not run' };
  return { ok: true, id: item.id, company: item.company, title: item.title, result, persisted, outreach };
}

/** @param {{ limit?: number, dryRun?: boolean }} [options] */
export async function runClearQueue(options = {}) {
  const policy = loadPolicy();
  const limit = Math.min(Number(options.limit || policy.dailyLimit), policy.dailyLimit);
  const dryRun = options.dryRun === true;
  const release = acquireClearLock();
  const runId = `clear-${Date.now()}-${process.pid}`;
  updateClearState(DEFAULT_CLEAR_STATE_PATH, {
    status: 'running',
    runId,
    phase: 'refreshing',
    limit,
    dryRun,
    report: [],
    questions: [],
    handoffs: [],
    error: null,
    startedAt: new Date().toISOString(),
  });
  try {
    const refreshArgs = [path.join(ROOT, 'queue.mjs'), 'refresh', '--limit', String(limit)];
    if (dryRun) refreshArgs.push('--dry-run');
    refreshArgs.push('--skip-outreach');
    const refresh = await execFileAsync(process.execPath, refreshArgs, {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_QUEUE_PREVIEW: '1' },
      timeout: 300_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    const refreshRawOutput = `${refresh.stdout || ''}\n${refresh.stderr || ''}`;
    const refreshOutput = refreshRawOutput.replace(/\nCAREER_OPS_QUEUE_PREVIEW\s+\[[\s\S]*\]\s*$/m, '').trim().slice(-12_000);
    if (dryRun) {
      const preview = parseQueuePreview(refreshRawOutput);
      const previewState = preview ? { items: preview.items } : null;
      const selected = previewState ? selectClearItems(previewState, policy, limit) : [];
      const result = {
        ok: true,
        dryRun: true,
        limit,
        selected: selected.map((item) => ({ id: item.id, company: item.company, title: item.title, adapter: adapterForUrl(String(item.applyUrl || item.canonicalUrl || '')), fitScore: item.fitScore })),
        refreshOutput,
      };
      updateClearState(DEFAULT_CLEAR_STATE_PATH, { status: 'completed', phase: 'complete', result });
      return result;
    }
    const refreshedState = readQueueState(QUEUE_FILE);
    const selected = selectClearItems(refreshedState, policy, limit);
    saveQueue(refreshedState);
    updateClearState(DEFAULT_CLEAR_STATE_PATH, {
      phase: 'applying',
      refreshOutput,
      selected: selected.map((item) => ({ id: item.id, company: item.company, title: item.title })),
    });
    const application = await runApplicationQueue({
      dryRun: false,
      limit,
      headed: false,
      onProgress: (event) => updateClearState(DEFAULT_CLEAR_STATE_PATH, { phase: 'applying', current: event }),
    });
    const handoffStates = new Set(['submission_unknown', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_human']);
    const handoffIds = (application.report || [])
      .filter((entry) => handoffStates.has(String(entry.action || '')))
      .map((entry) => entry.id)
      .filter(Boolean);
    let handoff = { ok: true, skipped: true, reason: 'no browser handoffs required' };
    if (handoffIds.length) {
      updateClearState(DEFAULT_CLEAR_STATE_PATH, { phase: 'handoff', handoffs: handoffIds });
      const module = await import('./application-handoff.mjs');
      handoff = await module.runHandoffBatch(handoffIds, { timeoutSeconds: 600 });
    }
    const finalState = readQueueState(QUEUE_FILE);
    const questions = (finalState.items || [])
      .filter((item) => item.applicationState === 'blocked_by_question')
      .map((item) => item.id);
    const result = { ok: application.ok && handoff.ok, limit, application, handoff, questions, refreshOutput };
    updateClearState(DEFAULT_CLEAR_STATE_PATH, {
      status: result.ok ? 'completed' : 'failed',
      phase: 'complete',
      report: application.report || [],
      questions,
      handoffs: handoffIds,
      result,
      error: result.ok ? null : handoff.reason || application.reason || 'application clear failed',
    });
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateClearState(DEFAULT_CLEAR_STATE_PATH, { status: 'failed', phase: 'failed', error: reason });
    throw error;
  } finally {
    release();
  }
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
  if (command === 'clear') {
    const result = await runClearQueue({ limit, dryRun: args.includes('--dry-run') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } else if (command === 'run' || command === 'dry-run') {
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
  } else if (command === 'handoff') {
    const queueId = readFlag(args, '--queue-id', '');
    if (!queueId) throw new Error('Usage: node application-queue.mjs handoff --queue-id <id> [--timeout 600]');
    const timeoutSeconds = Math.max(30, Number(readFlag(args, '--timeout', '600')) || 600);
    const result = await runApplicationHandoff(queueId, { timeoutSeconds });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } else if (command === 'resume') {
    const queueId = readFlag(args, '--queue-id', '');
    if (!queueId) throw new Error('Usage: node application-queue.mjs resume --queue-id <id>');
    const result = await resumeApplication(queueId);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } else {
    console.error('Usage: node application-queue.mjs clear|run|dry-run|status|handoff|resume [--limit N] [--headed] [--queue-id <id>] [--timeout 600]');
    process.exitCode = 1;
  }
}
