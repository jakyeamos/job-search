#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_URL = 'http://127.0.0.1:47831/';
const STATE_PATH = path.join(ROOT, 'data', 'queue-ui-launch-state.json');
const BROWSER_APPS = ['Google Chrome Beta', 'Google Chrome'];
export const SCHEDULED_HEALTH_LIMIT = 100;

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

export function buildChromeRefreshScript(applicationName, queueUrl = UI_URL) {
  const escapedUrl = queueUrl.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return [
    `tell application "${applicationName}"`,
    '  set foundQueueTab to false',
    '  repeat with currentWindow in windows',
    '    set currentTabIndex to 1',
    '    repeat with currentTab in tabs of currentWindow',
    `      if (URL of currentTab starts with "${escapedUrl}") then`,
    '        set foundQueueTab to true',
    '        set active tab index of currentWindow to currentTabIndex',
    '        reload currentTab',
    '        exit repeat',
    '      end if',
    '      set currentTabIndex to currentTabIndex + 1',
    '    end repeat',
    '    if foundQueueTab then exit repeat',
    '  end repeat',
    '  if foundQueueTab then',
    '    activate',
    '    return "refreshed"',
    '  end if',
    'end tell',
    'return "missing"',
  ].join('\n');
}

function runAppleScript(applicationName, script) {
  const result = spawnSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) return 'unavailable';
  return String(result.stdout || '').trim() === 'refreshed' ? 'refreshed' : 'missing';
}

function browserProcessIsRunning(applicationName) {
  return spawnSync('/usr/bin/pgrep', ['-x', applicationName], { stdio: 'ignore' }).status === 0;
}

export function refreshExistingQueueTab(
  runScript = runAppleScript,
  isBrowserRunning = browserProcessIsRunning,
) {
  let inspectionUnavailable = false;
  for (const applicationName of BROWSER_APPS) {
    if (!isBrowserRunning(applicationName)) continue;
    const result = runScript(applicationName, buildChromeRefreshScript(applicationName));
    if (result === 'refreshed') return { status: 'refreshed', applicationName };
    if (result === 'unavailable') inspectionUnavailable = true;
  }
  return inspectionUnavailable ? { status: 'unknown', applicationName: '' } : { status: 'missing', applicationName: '' };
}

export function decideLaunchAction({ tabStatus, alreadyOpenedToday }) {
  if (tabStatus === 'refreshed') return 'refresh';
  if (tabStatus === 'unknown' || alreadyOpenedToday) return 'skip';
  return 'open';
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

async function main() {
  const date = localDateKey();
  if (localHour() < 8) {
    console.log('Queue UI launch deferred until 8:00 AM Eastern.');
    return;
  }
  const state = readState();

  const refresh = spawnSync(process.execPath, [path.join(ROOT, 'queue.mjs'), 'refresh', '--scheduled', '--limit', '10'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (refresh.status !== 0) {
    console.error(`Queue refresh exited with status ${refresh.status ?? 'unknown'}; opening the last available queue.`);
  }

  const health = spawnSync(process.execPath, buildScheduledHealthArgs(), {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (health.status !== 0) {
    console.error(`Queue health recheck exited with status ${health.status ?? 'unknown'}; keeping the refreshed queue available.`);
  }

  const ready = await waitForUi();
  const tab = refreshExistingQueueTab();
  const action = decideLaunchAction({
    tabStatus: tab.status,
    alreadyOpenedToday: state.lastOpenedDate === date,
  });

  if (action === 'open') {
    const opened = spawnSync('/usr/bin/open', [UI_URL], { stdio: 'inherit' });
    if (opened.status !== 0) throw new Error(`could not open ${UI_URL}`);
    console.log(`Queue UI opened for ${date}: ${UI_URL}`);
  } else if (action === 'refresh') {
    console.log(`Queue UI refreshed in ${tab.applicationName} for ${date}: ${UI_URL}`);
  } else if (tab.status === 'unknown') {
    console.warn(`Queue UI refresh could not inspect the running browser; skipped opening a tab to avoid a duplicate: ${UI_URL}`);
  } else {
    console.log(`Queue UI already opened for ${date}; refreshed data without opening another tab.`);
  }

  writeState({
    ...state,
    lastOpenedDate: action === 'open' ? date : state.lastOpenedDate,
    openedAt: action === 'open' ? new Date().toISOString() : state.openedAt,
    lastRefreshedDate: date,
    refreshedAt: new Date().toISOString(),
    lastAction: action,
    browserApplication: tab.applicationName || state.browserApplication || '',
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
