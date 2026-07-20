#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  adapterCommand,
  adapterForUrl,
  persistApplicationResult,
  prepareApplicationArtifacts,
  queueApplicationGate,
  runAdapter,
  runPostApplicationOutreach,
} from './application-queue.mjs';
import { observeHumanSubmission } from './apply/lib/adapter-core.mjs';
import { DEFAULT_RUNS_PATH, beginRun, finishRun, loadRuns, roleKey } from './apply/application-runs.mjs';
import { loadPolicy } from './apply/application-policy.mjs';
import { acquireExclusiveLock } from './apply/application-run-state.mjs';
import { readQueueState } from './queue-lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(ROOT, 'data', 'job-queue.json');
const SESSION_FILE = path.join(ROOT, 'data', 'application-handoff-session.json');
const HANDOFF_LOCK_FILE = path.join(ROOT, 'data', 'application-handoff.lock');
const HANDOFF_ROOT = path.join(ROOT, 'output', 'application-handoffs');
const DEFAULT_TIMEOUT_SECONDS = 600;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

function sessionSnapshot(changes = {}) {
  return { ...readJson(SESSION_FILE, { schemaVersion: 1 }), ...changes, updatedAt: new Date().toISOString() };
}

function saveSession(changes = {}) {
  const next = sessionSnapshot(changes);
  writeJson(SESSION_FILE, next);
  return next;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForCdp(endpoint, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return true;
    } catch { /* browser is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function launchBrowserSession() {
  const existing = readJson(SESSION_FILE, null);
  if (existing?.status === 'running' && existing.endpoint) {
    try {
      const browser = await chromium.connectOverCDP(existing.endpoint);
      const context = browser.contexts()[0] || await browser.newContext();
      return { browser, context, endpoint: existing.endpoint, reused: true };
    } catch (error) {
      if (existing.pid && Number(existing.pid) !== process.pid) {
        try {
          process.kill(Number(existing.pid), 0);
          throw new Error('an existing browser handoff session is still running; refusing to open a second window');
        } catch (probeError) {
          if (probeError instanceof Error && probeError.message.includes('refusing to open')) throw probeError;
        }
      }
    }
  }

  mkdirSync(HANDOFF_ROOT, { recursive: true });
  const port = await findFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const profileDir = path.join(HANDOFF_ROOT, 'chrome-profile');
  let controller = null;
  let lastError = null;
  for (const channel of ['chrome-beta', 'chrome', null]) {
    try {
      controller = await chromium.launch(channel
        ? { headless: false, channel, args: [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`] }
        : { headless: false, args: [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`] });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!controller) throw lastError || new Error('unable to launch a headed Chrome handoff window');
  if (!await waitForCdp(endpoint)) {
    await controller.close();
    throw new Error('Chrome launched but its handoff connection was unavailable');
  }
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] || await browser.newContext();
  saveSession({
    schemaVersion: 1,
    status: 'running',
    pid: process.pid,
    endpoint,
    profileDir,
    startedAt: new Date().toISOString(),
    pages: [],
  });
  return { browser, controller, context, endpoint, reused: false };
}

function handoffEligible(item) {
  return new Set(['submission_unknown', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_human'])
    .has(String(item.applicationState || ''));
}

function runMetadata(item, adapter, resume) {
  return {
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
  };
}

function pageForPreparedItem(context, before, item) {
  const pages = context.pages();
  const fresh = pages.find((page) => !before.has(page));
  if (fresh) return fresh;
  const target = String(item.applyUrl || item.canonicalUrl || '').replace(/\/$/, '');
  return pages.find((page) => page.url().replace(/\/$/, '').startsWith(target)) || null;
}

async function prepareHandoffItem(item, context, endpoint, policy) {
  const adapter = adapterForUrl(String(item.applyUrl || item.canonicalUrl || ''));
  const gate = queueApplicationGate(item, policy, adapter);
  if (!gate.ok) return { ok: false, item, reason: gate.reason };
  const prepared = await prepareApplicationArtifacts(item, policy);
  if (!prepared.ok) return { ok: false, item, reason: prepared.reason };
  const { resume } = prepared;
  const key = roleKey(item);
  if (!loadRuns(DEFAULT_RUNS_PATH).runs.some((run) => run.key === key)) {
    const started = beginRun(DEFAULT_RUNS_PATH, key, runMetadata(item, adapter, resume));
    if (!started.ok) return { ok: false, item, reason: started.reason };
  }
  const before = new Set(context.pages());
  const result = await runAdapter(adapterCommand(item, adapter, {
    prepareOnly: true,
    cdpEndpoint: endpoint,
  }, resume, {
    coverLetterPdf: item.coverLetterArtifact,
    coverLetterText: item.coverLetterText,
  }), 180_000) || { state: 'failed', reason: 'adapter did not return a machine-readable result' };
  const page = pageForPreparedItem(context, before, item);
  if (!page) return { ok: false, item, result, reason: 'prepared application tab could not be located in the shared browser window' };
  await page.bringToFront().catch(() => {});
  return { ok: true, item, adapter, resume, result, page };
}

async function watchPreparedItem(prepared, context, timeoutMs) {
  const result = await observeHumanSubmission(prepared.page, {
    adapter: prepared.adapter,
    url: prepared.item.applyUrl || prepared.item.canonicalUrl,
    timeoutMs,
  });
  const state = readQueueState(QUEUE_FILE);
  const item = (state.items || []).find((candidate) => candidate.id === prepared.item.id) || prepared.item;
  const key = roleKey(item);
  finishRun(DEFAULT_RUNS_PATH, key, result);
  const persisted = persistApplicationResult(state, item, result);
  await prepared.page.close().catch(() => {});
  saveSession({
    pages: (readJson(SESSION_FILE, {}).pages || []).map((page) => page.id === item.id ? { ...page, status: persisted.state, finishedAt: new Date().toISOString() } : page),
  });
  return { id: item.id, company: item.company, title: item.title, result, persisted };
}

export async function runHandoffBatch(queueIds, options = {}) {
  const policy = loadPolicy();
  if (!policy.enabled || !policy.authorized) return { ok: false, reason: 'application policy is disabled or not authorized' };
  const state = readQueueState(QUEUE_FILE);
  const items = (state.items || []).filter((item) => queueIds.includes(item.id) && handoffEligible(item));
  if (!items.length) return { ok: true, skipped: true, reason: 'no eligible browser handoffs found', results: [] };
  let release;
  try {
    release = acquireExclusiveLock(HANDOFF_LOCK_FILE, 'application handoff');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  let session = null;
  try {
    session = await launchBrowserSession();
    const prepared = [];
    const preparation = [];
    for (const item of items) {
      const result = await prepareHandoffItem(item, session.context, session.endpoint, policy);
      preparation.push({ id: item.id, company: item.company, title: item.title, state: result.result?.state || null, ok: result.ok, reason: result.reason || result.result?.reason || null });
      if (result.ok && result.result?.state !== 'blocked_by_question') prepared.push(result);
      if (result.result?.state === 'blocked_by_question') {
        const current = readQueueState(QUEUE_FILE);
        const currentItem = (current.items || []).find((candidate) => candidate.id === item.id) || item;
        finishRun(DEFAULT_RUNS_PATH, roleKey(currentItem), result.result);
        persistApplicationResult(current, currentItem, result.result);
        await result.page?.close().catch(() => {});
      } else if (!result.ok) {
        const existingRun = loadRuns(DEFAULT_RUNS_PATH).runs.find((run) => run.key === roleKey(item));
        if (!existingRun || existingRun.state === 'started') {
          finishRun(DEFAULT_RUNS_PATH, roleKey(item), result.result || { state: 'failed', reason: result.reason || 'handoff preparation failed' });
        }
      }
    }
    saveSession({
      status: 'running',
      pages: prepared.map((entry) => ({ id: entry.item.id, company: entry.item.company, title: entry.item.title, url: entry.item.applyUrl || entry.item.canonicalUrl, status: 'waiting' })),
    });
    const timeoutMs = Math.max(30_000, Math.min(1_800_000, Number(options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000));
    const results = await Promise.all(prepared.map((entry) => watchPreparedItem(entry, session.context, timeoutMs)));
    const submitted = results.filter((entry) => entry.persisted.submitted).length;
    const outreach = submitted ? await runPostApplicationOutreach() : { triggered: false, ok: true, reason: 'no confirmed handoff submissions' };
    saveSession({ status: 'completed', completedAt: new Date().toISOString() });
    if (!session.reused) {
      await session.browser.close().catch(() => {});
      if (session.controller) await session.controller.close().catch(() => {});
    }
    return { ok: true, preparation, results, submitted, outreach };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    saveSession({ status: 'failed', error: reason });
    if (session && !session.reused) {
      await session.browser.close().catch(() => {});
      if (session.controller) await session.controller.close().catch(() => {});
    }
    throw error;
  } finally {
    release();
  }
}

export function loadHandoffSession() {
  return readJson(SESSION_FILE, { schemaVersion: 1, status: 'idle', pages: [] });
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const timeoutIndex = process.argv.indexOf('--timeout');
  const timeoutSeconds = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) || DEFAULT_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS;
  runHandoffBatch(ids, { timeoutSeconds })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
