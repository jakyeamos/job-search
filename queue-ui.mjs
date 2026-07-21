#!/usr/bin/env node
// @ts-check

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { recordApplication, saveQueue } from './queue.mjs';
import { normalizeUrl, readQueueState } from './queue-lib.mjs';
import { OUTREACH_STATE_PATH, recordSubmissionSignal, loadOutreachState } from './outreach-lib.mjs';
import { loadLedger, answerQuestion, findQuestionMatch, isSensitiveQuestion, questionId } from './apply/question-ledger.mjs';
import { selectProjectAccomplishment } from './project-accomplishment-ledger.mjs';
import { loadClearState, DEFAULT_CLEAR_STATE_PATH } from './apply/application-run-state.mjs';
import { runClearQueue } from './application-queue.mjs';
import { loadHandoffSession, runHandoffBatch } from './application-handoff.mjs';
import { buildApplicationPacket } from './apply/application-packets.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(ROOT, 'queue-ui');
const QUEUE_JSON = path.join(ROOT, 'data', 'job-queue.json');
const PORT = 47831;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
let clearPromise = null;
let handoffPromise = null;
let packetPromise = null;

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

function questionPayload(items) {
  const ledger = loadLedger();
  const grouped = new Map();
  items
    .filter((item) => item.applicationState === 'blocked_by_question')
    .flatMap((item) => {
      const reviews = Array.isArray(item.applicationResult?.needsReview) ? item.applicationResult.needsReview : [];
      return reviews.map((review) => {
        const question = String(review.label || '').replace(/^EEO:\s*/i, '').trim();
        if (!question) return null;
        const sensitivity = isSensitiveQuestion(question) ? 'high' : 'normal';
        const entry = ledger.entries.find((candidate) => candidate.id === questionId(question))
          || findQuestionMatch(question, ledger, {
            fieldKind: review.kind || review.fieldKind || '',
            options: Array.isArray(review.options) ? review.options : [],
            sensitivity,
          })?.entry;
        const canonicalId = entry?.id || questionId(question);
        const accomplishment = selectProjectAccomplishment({
          question,
          company: item.company,
          title: item.title,
          description: item.description,
          lane: item.lane,
        });
        const options = Array.isArray(review.options) && review.options.length ? review.options : (entry?.options || []);
        const occurrence = { queueId: item.id, company: item.company, role: item.title, url: item.applyUrl || item.canonicalUrl };
        const existing = grouped.get(canonicalId);
        if (existing) {
          existing.queueIds = [...new Set([...existing.queueIds, item.id])];
          existing.occurrences.push(occurrence);
          existing.options = [...new Set([...existing.options, ...options])];
          if (!existing.suggestedAnswer && accomplishment?.answer) existing.suggestedAnswer = accomplishment.answer;
          return null;
        }
        const payload = {
          id: canonicalId,
          queueId: item.id,
          queueIds: [item.id],
          occurrences: [occurrence],
          occurrenceCount: 1,
          company: item.company,
          role: item.title,
          url: item.applyUrl || item.canonicalUrl,
          question: entry?.question || question,
          reason: review.reason || entry?.blockerReason || 'required field needs an answer',
          options: [...new Set(options)],
          sensitivity: entry?.sensitivity || 'normal',
          suggestedAnswer: accomplishment?.answer || '',
          answer: entry?.answer || '',
          scope: ['question', 'company', 'role'].includes(String(entry?.scope || '')) ? entry.scope : 'question',
        };
        grouped.set(canonicalId, payload);
        return null;
      }).filter(Boolean);
    });
  return [...grouped.values()].map((question) => ({ ...question, occurrenceCount: question.occurrences.length }));
}

function publicHandoffSession() {
  const session = loadHandoffSession();
  return {
    schemaVersion: session.schemaVersion,
    status: session.status,
    startedAt: session.startedAt || null,
    completedAt: session.completedAt || null,
    updatedAt: session.updatedAt || null,
    pages: (session.pages || []).map((page) => ({
      id: page.id,
      company: page.company,
      title: page.title,
      url: page.url,
      status: page.status,
      finishedAt: page.finishedAt || null,
    })),
  };
}

function publicApplicationRun() {
  const state = loadClearState(DEFAULT_CLEAR_STATE_PATH);
  const { path: _path, ...safeState } = state;
  return safeState;
}

/** @param {Array<Record<string, unknown>>} items */
function countUniqueLiveRoles(items) {
  const urls = new Set();
  let recordsWithoutUrl = 0;
  for (const item of items) {
    const url = normalizeUrl(String(item.applyUrl || item.canonicalUrl || ''));
    if (url) urls.add(url);
    else recordsWithoutUrl += 1;
  }
  return urls.size + recordsWithoutUrl;
}

/** @param {Record<string, unknown>} state */
function queuePayload(state) {
  const items = Array.isArray(state.items) ? state.items : [];
  const liveItems = items.filter((item) => ['ready', 'in_review', 'snoozed'].includes(String(item.status || '')));
  const selected = items
    .filter((item) => item.selectedForToday)
    .sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999));
  return {
    ...state,
    selected,
    questions: questionPayload(items),
    handoffs: publicHandoffSession(),
    applicationRun: publicApplicationRun(),
    outreach: loadOutreachState(path.join(ROOT, OUTREACH_STATE_PATH)).records.map((record) => ({
      key: record.key,
      company: record.company,
      title: record.title,
      status: record.status,
      searchQuery: record.searchQuery || '',
      contacts: (record.contacts || []).map((contact) => ({
        name: contact.name,
        title: contact.title,
        type: contact.type,
        email: contact.email,
        emailVerified: contact.emailVerified === true,
        initialStatus: contact.initial?.status || 'none',
        followUpStatus: contact.followUp?.status || 'none',
        followUpDueAt: contact.followUp?.dueAt || null,
        linkedinDraft: contact.linkedinDraft || '',
      })),
    })),
    totals: {
      retained: items.length,
      liveUnique: countUniqueLiveRoles(liveItems),
      excluded: items.filter((item) => item.status === 'excluded').length,
      stale: items.filter((item) => item.status === 'stale').length,
      selected: selected.length,
      ready: items.filter((item) => item.status === 'ready').length,
      inReview: items.filter((item) => item.status === 'in_review').length,
      applied: items.filter((item) => item.status === 'applied').length,
      questions: items.filter((item) => item.applicationState === 'blocked_by_question').length,
      handoffs: items.filter((item) => ['submission_unknown', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_human'].includes(String(item.applicationState || ''))).length,
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
    const appliedAt = new Date().toISOString();
    const recorded = recordApplication(ROOT, item);
    if (!recorded.recorded && !recorded.reason.includes('already exists')) {
      throw new Error(recorded.reason);
    }
    item.status = 'applied';
    item.appliedAt = appliedAt;
    item.selectedForToday = false;
    item.queueRank = null;
    item.actionNote = recorded.reason;
    recordSubmissionSignal(path.join(ROOT, OUTREACH_STATE_PATH), item, { source: 'queue_applied', at: appliedAt });
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
  const result = await execFileAsync(process.execPath, [path.join(ROOT, 'queue.mjs'), 'refresh', '--limit', '6'], {
    cwd: ROOT,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    state: queuePayload(loadState()),
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function startClearQueue(dryRun = false) {
  if (clearPromise) return publicApplicationRun();
  clearPromise = runClearQueue({ limit: 6, dryRun })
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { clearPromise = null; });
  return publicApplicationRun();
}

async function runPacketQueue(limit = 6) {
  const state = loadState();
  const selected = (state.items || [])
    .filter((item) => item.selectedForToday && ['ready', 'in_review'].includes(String(item.status || '')))
    .sort((left, right) => Number(left.queueRank || 999) - Number(right.queueRank || 999))
    .slice(0, Math.max(1, Math.min(Number(limit || 6), 6)));
  const report = [];
  updateClearState(DEFAULT_CLEAR_STATE_PATH, {
    status: 'running',
    phase: 'preparing-packets',
    limit,
    report: [],
    questions: [],
    handoffs: [],
    error: null,
    startedAt: new Date().toISOString(),
  });
  for (const item of selected) {
    updateClearState(DEFAULT_CLEAR_STATE_PATH, {
      phase: 'preparing-packets',
      current: { id: item.id, company: item.company, title: item.title, status: 'started' },
    });
    try {
      const packet = await buildApplicationPacket(item);
      item.applicationPacket = packet.ok
        ? {
          status: packet.status,
          generatedAt: packet.generatedAt,
          markdownPath: packet.paths.markdown,
          jsonPath: packet.paths.json,
          unresolvedCount: packet.unresolved.length,
        }
        : { status: 'blocked', reason: packet.reason };
      report.push({ id: item.id, company: item.company, title: item.title, action: packet.ok ? 'packet-ready' : 'blocked', status: packet.ok ? packet.status : null, reason: packet.ok ? `${packet.unresolved.length} required question(s) unresolved` : packet.reason });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      item.applicationPacket = { status: 'blocked', reason };
      report.push({ id: item.id, company: item.company, title: item.title, action: 'blocked', reason });
    }
    state.generatedAt = new Date().toISOString();
    saveQueue(ROOT, state);
    updateClearState(DEFAULT_CLEAR_STATE_PATH, { report: [...report] });
  }
  const result = { ok: report.every((entry) => entry.action === 'packet-ready'), limit, report, humanSubmissionRequired: true };
  updateClearState(DEFAULT_CLEAR_STATE_PATH, {
    status: result.ok ? 'completed' : 'failed',
    phase: 'complete',
    report,
    result,
    error: result.ok ? null : 'one or more packets could not be prepared',
  });
  return result;
}

function startPacketQueue(limit = 6) {
  if (packetPromise) return publicApplicationRun();
  packetPromise = runPacketQueue(limit)
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { packetPromise = null; });
  return publicApplicationRun();
}

function startHandoffs() {
  if (handoffPromise) return publicHandoffSession();
  const state = loadState();
  const ids = (state.items || [])
    .filter((item) => ['submission_unknown', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_human'].includes(String(item.applicationState || '')))
    .map((item) => item.id);
  if (!ids.length) return publicHandoffSession();
  handoffPromise = runHandoffBatch(ids, { timeoutSeconds: 600 })
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { handoffPromise = null; });
  return publicHandoffSession();
}

async function buildQueuePacket(payload) {
  const queueId = stringValue(payload, 'queueId');
  if (!queueId) throw new Error('queue id is required');
  const state = loadState();
  const item = (state.items || []).find((candidate) => candidate.id === queueId);
  if (!item) throw new Error('queue item not found; refresh the page and try again');
  const packet = await buildApplicationPacket(item);
  if (!packet.ok) throw new Error(packet.reason);
  item.applicationPacket = {
    status: packet.status,
    generatedAt: packet.generatedAt,
    markdownPath: packet.paths.markdown,
    jsonPath: packet.paths.json,
    unresolvedCount: packet.unresolved.length,
  };
  state.generatedAt = new Date().toISOString();
  saveQueue(ROOT, state);
  return { packet, state: queuePayload(state) };
}

async function saveQueueQuestionAnswer(payload) {
  const id = stringValue(payload, 'id');
  const answer = stringValue(payload, 'answer');
  const scope = stringValue(payload, 'scope') || 'question';
  const queueIds = Array.isArray(payload.queueIds)
    ? payload.queueIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [stringValue(payload, 'queueId')].filter(Boolean);
  if (!id || !answer || !queueIds.length) throw new Error('question id, queue id, and answer are required');
  const state = loadState();
  const ledgerPath = path.join(ROOT, 'data', 'application-question-ledger.json');
  const ledger = loadLedger(ledgerPath);
  const items = queueIds.map((queueId) => (state.items || []).find((candidate) => candidate.id === queueId));
  if (items.some((item) => !item)) throw new Error('queue item not found; refresh the page and try again');
  for (const item of items) {
    const reviews = Array.isArray(item.applicationResult?.needsReview) ? item.applicationResult.needsReview : [];
    const belongsToItem = reviews.some((review) => {
      const question = String(review.label || '').replace(/^EEO:\s*/i, '').trim();
      return questionId(question) === id || findQuestionMatch(question, ledger, {
        fieldKind: review.kind || review.fieldKind || '',
        options: review.options || [],
        sensitivity: isSensitiveQuestion(question) ? 'high' : 'normal',
      })?.entry.id === id;
    });
    if (!belongsToItem) throw new Error('question is not recorded as a blocker for every application in this group');
  }
  const item = items[0];
  const entry = answerQuestion(path.join(ROOT, 'data', 'application-question-ledger.json'), id, answer, {
    scope: ['question', 'company', 'role'].includes(scope) ? scope : 'question',
    company: item.company,
    role: item.title,
    url: item.applyUrl || item.canonicalUrl,
    queueId: item.id,
  });
  return { ok: true, entry, queueIds, humanSubmissionRequired: true };
}

async function processOutreach() {
  const result = await execFileAsync(process.execPath, [path.join(ROOT, 'outreach.mjs'), 'process'], {
    cwd: ROOT,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    outreach: loadOutreachState(path.join(ROOT, OUTREACH_STATE_PATH)).records,
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
  if (request.method === 'POST' && requestUrl.pathname === '/api/applications/clear') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 202, { ok: true, run: startClearQueue(payload.dryRun === true) });
    } catch (error) {
      sendError(response, 409, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/applications/packets') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 202, { ok: true, run: startPacketQueue(Number(payload.limit || 6)) });
    } catch (error) {
      sendError(response, 409, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/applications/packet') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await buildQueuePacket(payload));
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/applications/status') {
    sendJson(response, 200, publicApplicationRun());
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/questions/answer') {
    try {
      const payload = await readJsonBody(request);
      const result = await saveQueueQuestionAnswer(payload);
      sendJson(response, 200, { ok: result.ok, entry: result.entry, queueIds: result.queueIds, humanSubmissionRequired: result.humanSubmissionRequired });
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/handoffs') {
    sendJson(response, 200, publicHandoffSession());
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/handoffs/open') {
    try {
      sendJson(response, 202, { ok: true, handoffs: startHandoffs() });
    } catch (error) {
      sendError(response, 409, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/outreach/process') {
    try {
      sendJson(response, 200, await processOutreach());
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
