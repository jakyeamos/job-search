#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_URL = 'http://127.0.0.1:47831/';
const STATE_PATH = path.join(ROOT, 'data', 'queue-ui-launch-state.json');
export const QUEUE_UI_LAUNCH_AGENT = 'com.jakyeamos.career-ops.queue-ui';
export const SCHEDULED_HEALTH_LIMIT = 100;
export const SCHEDULED_APPLICATION_LIMIT = 6;
export const SCHEDULED_HUMAN_TIMEOUT_SECONDS = 8 * 60 * 60;

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function localHour(date = new Date()) {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  }).format(date);
  return Number(value === '24' ? '0' : value);
}

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeState(state) {
  const tempPath = `${STATE_PATH}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tempPath, STATE_PATH);
}

async function waitForUi(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${UI_URL}api/health`);
      if (response.ok) return true;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export const SCHEDULED_BROWSER_ACTION = 'front-page-owned';

export function buildScheduledBrowserPolicy(queueUrl = UI_URL) {
  return {
    action: SCHEDULED_BROWSER_ACTION,
    opensBrowser: false,
    owner: 'Daily Front Page',
    queueUrl,
  };
}

export function buildScheduledHealthArgs(limit = SCHEDULED_HEALTH_LIMIT) {
  return [
    path.join(ROOT, 'queue.mjs'),
    'health',
    '--limit',
    String(limit),
    '--apply',
    '--browser',
  ];
}

export function buildScheduledApplicationFillRequest() {
  return {
    limit: SCHEDULED_APPLICATION_LIMIT,
    humanTimeoutSeconds: SCHEDULED_HUMAN_TIMEOUT_SECONDS,
  };
}

export function shouldStartScheduledApplicationFill(alreadyStartedToday) {
  return alreadyStartedToday !== true;
}

export function buildQueueUiReloadArgs(uid = process.getuid()) {
  return ['kickstart', '-k', `gui/${uid}/${QUEUE_UI_LAUNCH_AGENT}`];
}

function reloadQueueUiService() {
  const result = spawnSync('/bin/launchctl', buildQueueUiReloadArgs(), { stdio: 'inherit' });
  if (result.status !== 0) {
    return { status: 'failed', reason: `queue UI service reload exited with status ${result.status ?? 'unknown'}` };
  }
  return { status: 'reloaded' };
}

async function startScheduledApplicationFill(alreadyStartedToday, request = buildScheduledApplicationFillRequest()) {
  if (!shouldStartScheduledApplicationFill(alreadyStartedToday)) return { status: 'already-started' };
  try {
    const response = await fetch(`${UI_URL}api/applications/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) return { status: 'failed', reason: `queue UI returned HTTP ${response.status}` };
    return { status: 'started' };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const date = localDateKey();
  if (localHour() < 8) {
    console.log('Scheduled Career Ops work deferred until 8:00 AM Eastern.');
    return;
  }
  const state = readState();

  const refresh = spawnSync(process.execPath, [path.join(ROOT, 'queue.mjs'), 'refresh', '--scheduled', '--limit', '10'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (refresh.status !== 0) {
    console.error(`Queue refresh exited with status ${refresh.status ?? 'unknown'}; keeping the last available queue for the Career Ops tab.`);
  }

  const health = spawnSync(process.execPath, buildScheduledHealthArgs(), {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (health.status !== 0) {
    console.error(`Queue health recheck exited with status ${health.status ?? 'unknown'}; keeping the refreshed queue available.`);
  }

  const applicationFillDue = shouldStartScheduledApplicationFill(state.lastApplicationFillDate === date);
  const serviceReload = applicationFillDue ? reloadQueueUiService() : { status: 'not-needed' };
  if (serviceReload.status === 'failed') {
    console.error(`Daily application fill was not started: ${serviceReload.reason}.`);
  }

  const ready = await waitForUi();
  if (!ready) console.warn(`Queue UI was not ready; daily application fill was not started: ${UI_URL}`);
  const browserPolicy = buildScheduledBrowserPolicy();
  console.log(`Career Ops queue refreshed for ${date}; Daily Front Page owns the browser launch. Career Ops remains available at ${browserPolicy.queueUrl}`);

  const applicationFill = ready && serviceReload.status !== 'failed'
    ? await startScheduledApplicationFill(state.lastApplicationFillDate === date)
    : { status: 'failed', reason: serviceReload.reason || 'queue UI was not ready' };
  if (applicationFill.status === 'started') {
    console.log(`Daily application fill started for ${date}: up to ${SCHEDULED_APPLICATION_LIMIT} roles, human review window ${SCHEDULED_HUMAN_TIMEOUT_SECONDS / 3600} hours.`);
  } else if (applicationFill.status === 'failed') {
    console.error(`Daily application fill was not started: ${applicationFill.reason}`);
  }

  writeState({
    ...state,
    lastOpenedDate: null,
    openedAt: null,
    lastRefreshedDate: date,
    refreshedAt: new Date().toISOString(),
    lastAction: browserPolicy.action,
    lastApplicationFillDate: applicationFill.status === 'started' ? date : state.lastApplicationFillDate,
    applicationFillStartedAt: applicationFill.status === 'started' ? new Date().toISOString() : state.applicationFillStartedAt,
    applicationFillStatus: applicationFill.status,
    applicationFillReason: applicationFill.reason || '',
    queueUiReloadStatus: serviceReload.status,
    queueUiReloadReason: serviceReload.reason || '',
    browserApplication: '',
    browserLaunch: browserPolicy.opensBrowser,
    browserSurface: browserPolicy.owner,
    queueUiUrl: browserPolicy.queueUrl,
    serverReady: ready,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`queue-ui-launch: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
