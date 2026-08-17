// @ts-check

import { existsSync, readFileSync } from 'node:fs';

export const HANDSHAKE_SOURCE = 'handshake';
export const HANDSHAKE_SOURCE_LABEL = 'Handshake';
export const HANDSHAKE_APP_ORIGIN = 'https://app.joinhandshake.com';

const HANDSHAKE_HOST_RE = /(?:^|\.)joinhandshake\.com$/i;
const JOB_ID_RE = /\/(?:emp\/)?(?:jobs|job-search)\/(\d{4,})(?:\/|$)/i;

/** @param {unknown} value */
export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value @param {number} max */
function boundedText(value, max) {
  return normalizeText(value).slice(0, max);
}

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
export function handshakeJobId(value) {
  const raw = absoluteHttpsUrl(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!HANDSHAKE_HOST_RE.test(url.hostname)) return '';
    return url.pathname.match(JOB_ID_RE)?.[1] || '';
  } catch {
    return '';
  }
}

/** @param {unknown} value */
export function isHandshakeUrl(value) {
  return Boolean(handshakeJobId(value));
}

/** @param {unknown} value */
export function normalizeHandshakeJobUrl(value) {
  const id = handshakeJobId(value);
  return id ? `${HANDSHAKE_APP_ORIGIN}/jobs/${id}` : '';
}

/** @param {unknown} value */
function normalizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))];
}

/** @param {unknown} value */
function normalizeEvidence(value) {
  if (!value || typeof value !== 'object') return {};
  const input = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(Object.entries(input)
    .filter(([key, item]) => ['provider', 'method', 'authenticated', 'verification', 'url', 'observedAt', 'pageTitle'].includes(key)
      && (typeof item === 'string' || typeof item === 'boolean')));
}

/** @param {unknown} value @param {{ sourceUrl?: string, observedAt?: string, authenticated?: boolean }} [context] */
export function normalizeHandshakeJob(value, context = {}) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  const canonicalUrl = normalizeHandshakeJobUrl(raw.canonicalUrl || raw.url || raw.sourceUrl);
  if (!canonicalUrl) return null;

  const sourceUrl = absoluteHttpsUrl(context.sourceUrl || raw.sourceUrl || raw.url || canonicalUrl) || canonicalUrl;
  const observedAt = normalizeText(context.observedAt || raw.observedAt || raw.discoveredAt || new Date().toISOString());
  const title = boundedText(raw.title || raw.role || raw.name, 240);
  const company = boundedText(raw.company || raw.employer || raw.organization, 240);
  const location = boundedText(raw.location || raw.workplace || raw.city, 240);
  const description = boundedText(raw.description || raw.jobDescription || raw.body || raw.text, 20_000);
  const applyLabel = boundedText(raw.applyLabel || raw.applyText, 120);
  const applyAvailable = raw.applyAvailable === true
    || raw.hasApplyControl === true
    || /\bapply\b/i.test(applyLabel);
  const closed = raw.closed === true || String(raw.liveness || '').toLowerCase() === 'expired';
  const complete = Boolean(title && company && description.length >= 80 && applyAvailable);
  const authenticated = context.authenticated
    ?? (typeof raw.authenticated === 'boolean' ? raw.authenticated : null)
    ?? (typeof raw.sourceEvidence === 'object' && raw.sourceEvidence !== null && typeof raw.sourceEvidence.authenticated === 'boolean'
      ? raw.sourceEvidence.authenticated
      : true);
  const warnings = normalizeWarnings(raw.warnings);
  if (!title) warnings.push('missing visible job title');
  if (!company) warnings.push('missing visible company');
  if (description.length < 80) warnings.push('missing or short job description');
  if (!applyAvailable) warnings.push('missing visible Apply control');

  const evidence = {
    ...normalizeEvidence(raw.sourceEvidence),
    provider: HANDSHAKE_SOURCE,
    method: 'authenticated-chrome-read',
    authenticated,
    verification: complete && authenticated === true
      ? 'authenticated Handshake browser'
      : 'authenticated Handshake browser record incomplete',
    url: sourceUrl,
    observedAt,
  };

  return {
    url: canonicalUrl,
    canonicalUrl,
    sourceUrl,
    applyUrl: absoluteHttpsUrl(raw.applyUrl || raw.applicationUrl) || canonicalUrl,
    applyAvailable,
    ...(applyLabel ? { applyLabel } : {}),
    title: title || 'Handshake job lead',
    company,
    location,
    description,
    ...(raw.postedAt ? { postedAt: boundedText(raw.postedAt, 80) } : {}),
    ...(raw.discoveredAt ? { discoveredAt: boundedText(raw.discoveredAt, 80) } : {}),
    observedAt,
    ...(complete && !closed ? { lastConfirmedActiveAt: observedAt } : {}),
    source: HANDSHAKE_SOURCE,
    sourceLabel: HANDSHAKE_SOURCE_LABEL,
    liveness: closed ? 'expired' : complete ? 'active' : 'source-alert',
    fitConfidence: complete && !closed ? 'high' : 'low',
    sourceEvidence: evidence,
    ...(typeof raw.sourceMessageId === 'string' && raw.sourceMessageId.trim()
      ? { sourceMessageId: raw.sourceMessageId.trim() }
      : {}),
    ...(raw.missionFit && typeof raw.missionFit === 'object' ? { missionFit: raw.missionFit } : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
  };
}

/** @param {unknown} value */
function unpackRecords(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of ['records', 'jobs', 'items', 'results', 'data']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [value];
}

/** @param {unknown} value @param {{ authenticated?: boolean, observedAt?: string }} [context] */
export function normalizeHandshakeJobs(value, context = {}) {
  const seen = new Set();
  const jobs = [];
  for (const item of unpackRecords(value)) {
    const job = normalizeHandshakeJob(item, context);
    if (!job || seen.has(job.canonicalUrl)) continue;
    seen.add(job.canonicalUrl);
    jobs.push(job);
  }
  return jobs;
}

/** @param {string} file */
export function readHandshakeSyncStatus(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { ok: false, outcome: 'invalid-status', error: `Handshake sync status is not valid JSON: ${file}` };
  }
}
