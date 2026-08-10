// @ts-check

import { existsSync, readFileSync } from 'node:fs';

import {
  HANDSHAKE_APP_ORIGIN,
  HANDSHAKE_SOURCE,
  normalizeHandshakeJobUrl,
  normalizeText,
} from './handshake-lib.mjs';

export const HANDSHAKE_INBOX_SOURCE = 'handshake-inbox';
export const HANDSHAKE_INBOX_SOURCE_LABEL = 'Handshake Inbox';
export const HANDSHAKE_INBOX_URL = `${HANDSHAKE_APP_ORIGIN}/inbox`;

const HANDSHAKE_HOST_RE = /(?:^|\.)joinhandshake\.com$/i;
const INBOX_ID_RE = /\/inbox\/(\d+)(?:\/|$)/i;

/** @param {unknown} value */
function absoluteHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** @param {unknown} value */
export function handshakeInboxId(value) {
  const raw = absoluteHttpsUrl(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!HANDSHAKE_HOST_RE.test(url.hostname)) return '';
    return url.pathname.match(INBOX_ID_RE)?.[1] || '';
  } catch {
    return '';
  }
}

/** @param {unknown} value */
export function isHandshakeInboxUrl(value) {
  const raw = absoluteHttpsUrl(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (!HANDSHAKE_HOST_RE.test(url.hostname)) return false;
    return url.pathname === '/inbox' || Boolean(handshakeInboxId(raw));
  } catch {
    return false;
  }
}

/** @param {unknown} value */
export function normalizeHandshakeInboxUrl(value) {
  const id = handshakeInboxId(value);
  if (id) return `${HANDSHAKE_INBOX_URL}/${id}`;
  return isHandshakeInboxUrl(value) ? HANDSHAKE_INBOX_URL : '';
}

/** @param {unknown} value @param {number} max */
function boundedText(value, max) {
  return normalizeText(value).slice(0, max);
}

/** @param {unknown} value */
function normalizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))];
}

/** @param {unknown} value */
function normalizeJobLinks(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .map((item) => typeof item === 'object' && item !== null
      ? item.url || item.href
      : item)
    .map(normalizeHandshakeJobUrl)
    .filter(Boolean))];
}

/** @param {unknown} value @param {{ observedAt?: string, authenticated?: boolean }} [context] */
export function normalizeHandshakeInboxThread(value, context = {}) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  const conversationId = boundedText(
    raw.conversationId || raw.threadId || raw.id || handshakeInboxId(raw.threadUrl || raw.url),
    120,
  );
  if (!conversationId) return null;

  const threadUrl = normalizeHandshakeInboxUrl(raw.threadUrl || raw.url)
    || `${HANDSHAKE_INBOX_URL}/${conversationId}`;
  const observedAt = normalizeText(context.observedAt || raw.observedAt || new Date().toISOString());
  const authenticated = context.authenticated
    ?? (typeof raw.authenticated === 'boolean' ? raw.authenticated : null)
    ?? (typeof raw.sourceEvidence === 'object' && raw.sourceEvidence !== null
      && typeof raw.sourceEvidence.authenticated === 'boolean'
      ? raw.sourceEvidence.authenticated
      : true);
  const participantName = boundedText(raw.participantName || raw.senderName || raw.name, 240);
  const participantRole = boundedText(raw.participantRole || raw.role || raw.senderRole, 240);
  const company = boundedText(raw.company || raw.employer || raw.organization, 240);
  const dateLabel = boundedText(raw.dateLabel || raw.date || raw.sentAt, 120);
  const previewText = boundedText(raw.previewText || raw.preview || raw.snippet, 1_000);
  const threadText = boundedText(raw.threadText || raw.body || raw.messageText, 30_000);
  const jobUrls = normalizeJobLinks(raw.jobUrls || raw.jobLinks);
  const warnings = normalizeWarnings(raw.warnings);
  if (!participantName) warnings.push('missing visible participant name');
  if (!previewText && !threadText) warnings.push('missing visible message text');

  return {
    conversationId,
    threadUrl,
    participantName: participantName || 'Handshake contact',
    ...(participantRole ? { participantRole } : {}),
    ...(company ? { company } : {}),
    ...(dateLabel ? { dateLabel } : {}),
    ...(previewText ? { previewText } : {}),
    ...(threadText ? { threadText } : {}),
    ...(jobUrls.length ? { jobUrls } : {}),
    unread: raw.unread === true,
    selected: raw.selected === true,
    observedAt,
    source: HANDSHAKE_SOURCE,
    sourceLabel: HANDSHAKE_INBOX_SOURCE_LABEL,
    readOnly: true,
    actionState: 'human-review-required',
    sourceEvidence: {
      provider: HANDSHAKE_SOURCE,
      method: 'authenticated-chrome-dom-read',
      authenticated,
      verification: authenticated === true
        ? 'authenticated Handshake inbox browser'
        : 'authenticated Handshake inbox browser record incomplete',
      url: threadUrl,
      observedAt,
      readOnly: true,
    },
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
  };
}

/** @param {Record<string, any>} current @param {Record<string, any>} incoming */
function mergeThread(current, incoming) {
  const currentText = normalizeText(current.threadText);
  const incomingText = normalizeText(incoming.threadText);
  const currentJobs = Array.isArray(current.jobUrls) ? current.jobUrls : [];
  const incomingJobs = Array.isArray(incoming.jobUrls) ? incoming.jobUrls : [];
  return {
    ...current,
    ...incoming,
    ...(current.participantName && incoming.participantName === 'Handshake contact'
      ? { participantName: current.participantName }
      : {}),
    ...(currentText.length > incomingText.length ? { threadText: current.threadText } : {}),
    ...(current.previewText && !incoming.previewText ? { previewText: current.previewText } : {}),
    ...(current.participantRole && !incoming.participantRole ? { participantRole: current.participantRole } : {}),
    ...(current.company && !incoming.company ? { company: current.company } : {}),
    ...(current.dateLabel && !incoming.dateLabel ? { dateLabel: current.dateLabel } : {}),
    unread: current.unread === true || incoming.unread === true,
    selected: current.selected === true || incoming.selected === true,
    jobUrls: [...new Set([...currentJobs, ...incomingJobs])],
    warnings: [...new Set([...(current.warnings || []), ...(incoming.warnings || [])])],
  };
}

/** @param {unknown} value @param {{ observedAt?: string, authenticated?: boolean }} [context] */
export function normalizeHandshakeInboxThreads(value, context = {}) {
  const records = Array.isArray(value) ? value : [];
  const byId = new Map();
  for (const item of records) {
    const thread = normalizeHandshakeInboxThread(item, context);
    if (!thread) continue;
    const existing = byId.get(thread.conversationId);
    byId.set(thread.conversationId, existing ? mergeThread(existing, thread) : thread);
  }
  return [...byId.values()];
}

/** @param {string} file */
export function readHandshakeInboxStatus(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return {
      ok: false,
      outcome: 'invalid-status',
      error: `Handshake inbox sync status is not valid JSON: ${file}`,
    };
  }
}
