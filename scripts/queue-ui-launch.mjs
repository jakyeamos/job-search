#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_URL = 'http://127.0.0.1:47831/';
const STATE_PATH = path.join(ROOT, 'data', 'queue-ui-launch-state.json');

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

async function main() {
  const date = localDateKey();
  if (localHour() < 8) {
    console.log('Queue UI launch deferred until 8:00 AM Eastern.');
    return;
  }
  const state = readState();
  if (state.lastOpenedDate === date) {
    console.log(`Queue UI already opened for ${date}.`);
    return;
  }

  const refresh = spawnSync(process.execPath, [path.join(ROOT, 'queue.mjs'), 'refresh', '--scheduled', '--limit', '10'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (refresh.status !== 0) {
    console.error(`Queue refresh exited with status ${refresh.status ?? 'unknown'}; opening the last available queue.`);
  }

  const ready = await waitForUi();
  const opened = spawnSync('/usr/bin/open', [UI_URL], { stdio: 'inherit' });
  if (opened.status !== 0) throw new Error(`could not open ${UI_URL}`);
  writeState({
    lastOpenedDate: date,
    openedAt: new Date().toISOString(),
    serverReady: ready,
  });
  console.log(`Queue UI opened for ${date}: ${UI_URL}`);
}

main().catch((error) => {
  console.error(`queue-ui-launch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
