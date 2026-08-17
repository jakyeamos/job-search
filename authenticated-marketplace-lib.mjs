// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Shared contract for authenticated opportunity sources.
 *
 * Browser adapters are deliberately separate from the plugin ingest hooks:
 * adapters read the user's already-authenticated visible tab and write a
 * local cache; plugins only read and normalize that cache. This keeps queue
 * refreshes deterministic and prevents an ingest hook from acquiring browser
 * or account-side mutation authority.
 */

export const AUTHENTICATED_MARKETPLACE_SOURCE_IDS = Object.freeze([
  'handshake',
  'wellfound',
  'contra',
  'braintrust',
]);

/** @type {Record<string, Readonly<{source: string, sourceLabel: string, hosts: readonly string[], cacheFile: string, statusFile: string, session: string, pathRe: RegExp}>>} */
export const AUTHENTICATED_MARKETPLACE_SOURCES = Object.freeze({
  handshake: Object.freeze({
    source: 'handshake',
    sourceLabel: 'Handshake',
    hosts: Object.freeze(['app.joinhandshake.com', 'joinhandshake.com', 'www.joinhandshake.com']),
    cacheFile: 'data/handshake-recommendations.json',
    statusFile: 'data/handshake-sync-status.json',
    session: 'career-ops-handshake',
    pathRe: /\/(?:emp\/)?(?:jobs|job-search)\/\d{4,}(?:\/|$)/i,
  }),
  wellfound: Object.freeze({
    source: 'wellfound',
    sourceLabel: 'Wellfound',
    hosts: Object.freeze(['wellfound.com', 'www.wellfound.com', 'angel.co', 'www.angel.co', 'angellist.com', 'www.angellist.com']),
    cacheFile: 'data/wellfound-recommendations.json',
    statusFile: 'data/wellfound-sync-status.json',
    session: 'career-ops-wellfound',
    pathRe: /\/(?:jobs?|job-search)\/[^/?#]+(?:\/|$)/i,
  }),
  contra: Object.freeze({
    source: 'contra',
    sourceLabel: 'Contra',
    hosts: Object.freeze(['contra.com', 'www.contra.com']),
    cacheFile: 'data/contra-recommendations.json',
    statusFile: 'data/contra-sync-status.json',
    session: 'career-ops-contra',
    pathRe: /\/(?:jobs?|opportunities?|projects?)\/[^/?#]+(?:\/|$)/i,
  }),
  braintrust: Object.freeze({
    source: 'braintrust',
    sourceLabel: 'Braintrust',
    hosts: Object.freeze(['app.usebraintrust.com', 'usebraintrust.com', 'www.usebraintrust.com']),
    cacheFile: 'data/braintrust-recommendations.json',
    statusFile: 'data/braintrust-sync-status.json',
    session: 'career-ops-braintrust',
    pathRe: /\/(?:talent\/)?(?:jobs?|opportunities?)\/[^/?#]+(?:\/|$)/i,
  }),
});

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

/** @param {string} source @returns {Readonly<{source: string, sourceLabel: string, hosts: readonly string[], cacheFile: string, statusFile: string, session: string, pathRe: RegExp}>} */
export function getMarketplaceSource(source) {
  const config = AUTHENTICATED_MARKETPLACE_SOURCES[source];
  if (!config) throw new Error(`unknown authenticated marketplace source: ${source}`);
  return config;
}

/** @param {string} source @param {unknown} value */
export function isMarketplaceHost(source, value) {
  const config = getMarketplaceSource(source);
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    return config.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

/** @param {string} source @param {unknown} value */
export function canonicalMarketplaceUrl(source, value) {
  const config = getMarketplaceSource(source);
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || !isMarketplaceHost(source, url.href)) return '';
  if (!config.pathRe.test(`${url.pathname}/`)) return '';
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return url.toString();
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
    .filter(([key, item]) => ['provider', 'method', 'authenticated', 'verification', 'url', 'observedAt', 'readOnly'].includes(key)
      && (typeof item === 'string' || typeof item === 'boolean')));
}

/** @param {unknown} value */
function normalizeCompensation(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return boundedText(value, 240);
  if (typeof value !== 'object') return '';
  const raw = /** @type {Record<string, unknown>} */ (value);
  return boundedText([
    raw.min ?? raw.minimum,
    raw.max ?? raw.maximum,
    raw.currency || raw.currencyCode,
    raw.unit || raw.period,
  ].filter((item) => item !== undefined && item !== null && normalizeText(item)).join(' - '), 240);
}

/**
 * Normalize one record emitted by an authenticated browser adapter.
 * Incomplete feed cards remain source-alerts; only a visible Apply control
 * plus a substantive detail record becomes active.
 *
 * @param {unknown} input
 * @param {{source: string, sourceUrl?: string, observedAt?: string, authenticated?: boolean}} context
 * @returns {Record<string, unknown> | null}
 */
export function normalizeMarketplaceJob(input, context) {
  if (!input || typeof input !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const source = context.source;
  const config = getMarketplaceSource(source);
  const canonicalUrl = canonicalMarketplaceUrl(source, raw.canonicalUrl || raw.url || raw.sourceUrl);
  if (!canonicalUrl) return null;

  const sourceUrl = absoluteHttpsUrl(context.sourceUrl || raw.sourceUrl || raw.url || canonicalUrl) || canonicalUrl;
  const observedAt = normalizeText(context.observedAt || raw.observedAt || raw.discoveredAt || new Date().toISOString());
  const title = boundedText(raw.title || raw.role || raw.name, 240);
  const company = boundedText(raw.company || raw.client || raw.employer || raw.organization, 240);
  const location = boundedText(raw.location || raw.workplace || raw.city || raw.timezone, 240);
  const description = boundedText(raw.description || raw.jobDescription || raw.body || raw.cardText || raw.text, 20_000);
  const applyLabel = boundedText(raw.applyLabel || raw.applyText, 120);
  const applyAvailable = raw.applyAvailable === true
    || raw.hasApplyControl === true
    || /\bapply\b/i.test(applyLabel);
  const closed = raw.closed === true || String(raw.liveness || '').toLowerCase() === 'expired';
  const authenticated = context.authenticated
    ?? (typeof raw.authenticated === 'boolean' ? raw.authenticated : null)
    ?? (typeof raw.sourceEvidence === 'object' && raw.sourceEvidence !== null && typeof raw.sourceEvidence.authenticated === 'boolean'
      ? raw.sourceEvidence.authenticated
      : true);
  const warnings = normalizeWarnings(raw.warnings);
  if (!title) warnings.push('missing visible opportunity title');
  if (!company) warnings.push('missing visible company or client');
  if (description.length < 80) warnings.push('missing or short opportunity description');
  if (!applyAvailable) warnings.push('missing visible Apply control');

  const complete = Boolean(title && company && description.length >= 80 && applyAvailable);
  const evidence = {
    ...normalizeEvidence(raw.sourceEvidence),
    provider: config.source,
    method: 'authenticated-chrome-dom-read',
    authenticated,
    readOnly: true,
    verification: complete && authenticated === true
      ? `authenticated ${config.sourceLabel} browser`
      : `authenticated ${config.sourceLabel} browser record incomplete`,
    url: sourceUrl,
    observedAt,
  };

  const marketplace = {
    ...(normalizeCompensation(raw.compensation || raw.rate || raw.hourlyRate || raw.budget || raw.salary || raw.compensationRange)
      ? { compensation: normalizeCompensation(raw.compensation || raw.rate || raw.hourlyRate || raw.budget || raw.salary || raw.compensationRange) }
      : {}),
    ...(boundedText(raw.jobType || raw.type, 120) ? { jobType: boundedText(raw.jobType || raw.type, 120) } : {}),
    ...(boundedText(raw.commitment || raw.hours || raw.availability, 120) ? { commitment: boundedText(raw.commitment || raw.hours || raw.availability, 120) } : {}),
  };

  return {
    url: canonicalUrl,
    canonicalUrl,
    sourceUrl,
    applyUrl: absoluteHttpsUrl(raw.applyUrl || raw.applicationUrl) || canonicalUrl,
    applyAvailable,
    ...(applyLabel ? { applyLabel } : {}),
    title: title || 'Marketplace opportunity',
    company,
    location,
    description,
    ...(Object.keys(marketplace).length ? { marketplace } : {}),
    ...(raw.postedAt ? { postedAt: boundedText(raw.postedAt, 80) } : {}),
    ...(raw.discoveredAt ? { discoveredAt: boundedText(raw.discoveredAt, 80) } : {}),
    observedAt,
    ...(complete && !closed && authenticated === true ? { lastConfirmedActiveAt: observedAt } : {}),
    source: config.source,
    sourceLabel: config.sourceLabel,
    liveness: closed ? 'expired' : complete && authenticated === true ? 'active' : 'source-alert',
    fitConfidence: complete && authenticated === true ? 'high' : 'low',
    sourceEvidence: evidence,
    readOnlyActions: { inspect: true, apply: false, save: false, message: false, submit: false },
    ...(typeof raw.sourceMessageId === 'string' && raw.sourceMessageId.trim()
      ? { sourceMessageId: raw.sourceMessageId.trim() }
      : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
  };
}

/** @param {unknown} value @param {{source: string, observedAt?: string, authenticated?: boolean}} context */
export function normalizeMarketplaceJobs(value, context) {
  const seen = new Set();
  const jobs = [];
  for (const item of unpackRecords(value)) {
    const job = normalizeMarketplaceJob(item, context);
    if (!job || seen.has(job.canonicalUrl)) continue;
    seen.add(job.canonicalUrl);
    jobs.push(job);
  }
  return jobs;
}

/** @param {string} file @param {{source: string, observedAt?: string, authenticated?: boolean}} context */
export function readMarketplaceCache(file, context) {
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cache is not valid JSON (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeMarketplaceJobs(parsed, context);
}

/** @param {string} file */
export function readMarketplaceSyncStatus(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { ok: false, outcome: 'invalid-status', error: `sync status is not valid JSON: ${file}` };
  }
}

/** @param {Record<string, unknown>} settings @param {string} source */
export function resolveMarketplacePaths(settings, source) {
  const config = getMarketplaceSource(source);
  const cacheSetting = normalizeText(settings.cache_file || config.cacheFile);
  const statusSetting = normalizeText(settings.status_file || config.statusFile);
  return {
    cacheFile: path.isAbsolute(cacheSetting) ? cacheSetting : path.resolve(process.cwd(), cacheSetting),
    statusFile: path.isAbsolute(statusSetting) ? statusSetting : path.resolve(process.cwd(), statusSetting),
  };
}

