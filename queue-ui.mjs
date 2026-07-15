#!/usr/bin/env node
// @ts-check

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { recordApplication, saveQueue } from './queue.mjs';
import { readQueueState } from './queue-lib.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(ROOT, 'queue-ui');
const QUEUE_JSON = path.join(ROOT, 'data', 'job-queue.json');
const PORT = 47831;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} payload */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {string} message */
function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

/** @param {import('node:http').IncomingMessage} request */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

/** @returns {Record<string, unknown>} */
function loadState() {
  return readQueueState(QUEUE_JSON);
}

/** @param {Record<string, unknown>} state */
function queuePayload(state) {
  const items = Array.isArray(state.items) ? state.items : [];
  const selected = items
    .filter((item) => item.selectedForToday)
    .sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999));
  return {
    ...state,
    selected,
    totals: {
      retained: items.length,
      selected: selected.length,
      ready: items.filter((item) => item.status === 'ready').length,
      inReview: items.filter((item) => item.status === 'in_review').length,
      applied: items.filter((item) => item.status === 'applied').length,
    },
  };
}

/** @param {Record<string, unknown>} payload */
function stringValue(payload, key) {
  return typeof payload[key] === 'string' ? payload[key].trim() : '';
}

/** @param {Record<string, unknown>} payload */
function applyQueueAction(payload) {
  const id = stringValue(payload, 'id');
  const action = stringValue(payload, 'action');
  const state = loadState();
  const items = Array.isArray(state.items) ? state.items : [];
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error('queue item not found; refresh the page and try again');

  if (action === 'applied') {
    const recorded = recordApplication(ROOT, item);
    if (!recorded.recorded && !recorded.reason.includes('already exists')) {
      throw new Error(recorded.reason);
    }
    item.status = 'applied';
    item.selectedForToday = false;
    item.queueRank = null;
    item.actionNote = recorded.reason;
  } else if (action === 'skipped') {
    item.status = 'skipped';
    item.selectedForToday = false;
    item.queueRank = null;
    item.skipReason = stringValue(payload, 'reason');
  } else if (action === 'snoozed') {
    const date = stringValue(payload, 'snoozeUntil');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('snooze date must use YYYY-MM-DD');
    item.status = 'snoozed';
    item.snoozeUntil = `${date}T00:00:00.000Z`;
    item.selectedForToday = false;
    item.queueRank = null;
  } else {
    throw new Error(`unsupported queue action: ${action || '(empty)'}`);
  }

  state.generatedAt = new Date().toISOString();
  saveQueue(ROOT, state);
  return { state: queuePayload(state), item, action };
}

async function refreshQueue() {
  const result = await execFileAsync(process.execPath, [path.join(ROOT, 'queue.mjs'), 'refresh', '--limit', '10'], {
    cwd: ROOT,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    state: queuePayload(loadState()),
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, service: 'career-ops-queue-ui' });
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/queue') {
    sendJson(response, 200, queuePayload(loadState()));
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/action') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, applyQueueAction(payload));
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/refresh') {
    try {
      sendJson(response, 200, await refreshQueue());
    } catch (error) {
      sendError(response, 502, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method !== 'GET') {
    sendError(response, 405, 'method not allowed');
    return;
  }

  const relative = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1);
  const filePath = path.resolve(UI_ROOT, relative);
  if (!filePath.startsWith(`${UI_ROOT}${path.sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendError(response, 404, 'not found');
    return;
  }
  const contentType = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

function startServer() {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) sendError(response, 500, 'internal queue UI error');
      console.error(`queue-ui: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  server.on('error', (error) => {
    console.error(`queue-ui: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`career-ops queue UI listening at http://${HOST}:${PORT}/`);
  });
}

if (process.argv.includes('--serve') || process.argv.length === 2) startServer();
