// @ts-check

import { existsSync, readFileSync } from 'node:fs';

export const JACK_SOURCE = 'jackandjill';
export const JACK_SOURCE_LABEL = 'Jack & Jill';
export const JACK_APP_ORIGIN = 'https://app.jackandjill.ai';

const JACK_HOSTS = new Set(['app.jackandjill.ai', 'www.jackandjill.ai', 'jackandjill.ai']);
const JOB_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

/** @param {unknown} value */
export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value */
function absoluteHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

/** @param {unknown} value @returns {string} */
export function jackJobId(value) {
  const raw = absoluteHttpsUrl(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!JACK_HOSTS.has(url.hostname.toLowerCase())) return '';
    return url.pathname.match(JOB_ID_RE)?.[0].toLowerCase() || '';
  } catch {
    return '';
  }
}

/**
 * Collapse Jack & Jill email tracking links and public detail links to the
 * authenticated posting route. The UUID is the stable identity; all query
 * parameters are intentionally discarded.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeJackJobUrl(value) {
  const id = jackJobId(value);
  return id ? `${JACK_APP_ORIGIN}/jobs/${id}/post` : '';
}

/** @param {unknown} value */
function normalizeSalary(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  const min = Number(raw.min ?? raw.minimum ?? 0);
  const max = Number(raw.max ?? raw.maximum ?? 0);
  const currency = normalizeText(raw.currency || raw.currencyCode || '');
  if ((!Number.isFinite(min) || min <= 0) && (!Number.isFinite(max) || max <= 0)) return null;
  return {
    ...(Number.isFinite(min) && min > 0 ? { min } : {}),
    ...(Number.isFinite(max) && max > 0 ? { max } : {}),
    ...(currency ? { currency } : {}),
  };
}

/** @param {unknown} value */
function normalizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))];
}

/** @param {Record<string, unknown>} raw */
function hasApplicationPath(raw) {
  const applyUrl = absoluteHttpsUrl(raw.applyUrl || raw.applicationUrl || raw.apply_url);
  if (applyUrl) return true;
  const path = normalizeText(raw.applyPath || raw.applicationPath || '');
  return /\b(apply|application|post)\b/i.test(path);
}

/**
 * Normalize one OpenCLI/cache record. Records without a canonical UUID URL
 * are rejected so chat-only recommendations never enter the job pipeline.
 *
 * @param {unknown} input
 * @param {{ sourceMessageId?: string, sourceUrl?: string }} [context]
 * @returns {Record<string, unknown> | null}
 */
export function normalizeJackJob(input, context = {}) {
  if (!input || typeof input !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const originalUrl = absoluteHttpsUrl(context.sourceUrl || raw.sourceUrl || raw.url || raw.canonicalUrl);
  const canonicalUrl = normalizeJackJobUrl(raw.canonicalUrl || raw.url || raw.sourceUrl);
  if (!canonicalUrl) return null;

  const title = normalizeText(raw.title || raw.role || raw.name || '');
  const company = normalizeText(raw.company || raw.employer || '');
  const location = normalizeText(raw.location || raw.workplace || '');
  const description = normalizeText(raw.description || raw.jobDescription || raw.body || '');
  const salary = normalizeSalary(raw.salary || raw.compensationRange);
  const compensation = normalizeText(raw.compensation || raw.comp || '')
    || (salary ? [salary.min && salary.max ? `${salary.min}-${salary.max}` : salary.min || salary.max, salary.currency].filter(Boolean).join(' ') : '');
  const warnings = normalizeWarnings(raw.warnings);
  if (!title) warnings.push('missing visible job title');
  if (!company) warnings.push('missing company');
  if (!description) warnings.push('missing job description');
  if (!hasApplicationPath(raw) && !canonicalUrl.endsWith('/post')) warnings.push('missing application path');

  const requestedLiveness = normalizeText(raw.liveness).toLowerCase();
  const complete = Boolean(title && description && (hasApplicationPath(raw) || canonicalUrl.endsWith('/post')));
  const liveness = requestedLiveness === 'expired'
    ? 'expired'
    : requestedLiveness === 'active' && complete
      ? 'active'
      : 'source-alert';
  const record = {
    url: canonicalUrl,
    canonicalUrl,
    sourceUrl: originalUrl || canonicalUrl,
    applyUrl: absoluteHttpsUrl(raw.applyUrl || raw.applicationUrl || raw.apply_url) || canonicalUrl,
    title: title || 'Job lead',
    company,
    location,
    description,
    ...(compensation ? { compensation } : {}),
    ...(salary ? { salary } : {}),
    ...(raw.postedAt ? { postedAt: raw.postedAt } : {}),
    ...(raw.discoveredAt ? { discoveredAt: raw.discoveredAt } : {}),
    ...(raw.observedAt ? { observedAt: raw.observedAt } : {}),
    ...(raw.lastConfirmedActiveAt ? { lastConfirmedActiveAt: raw.lastConfirmedActiveAt } : {}),
    source: JACK_SOURCE,
    sourceLabel: JACK_SOURCE_LABEL,
    liveness,
    fitConfidence: liveness === 'active' ? 'medium' : 'low',
    ...(context.sourceMessageId || raw.sourceMessageId
      ? { sourceMessageId: context.sourceMessageId || raw.sourceMessageId }
      : {}),
    ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
  };
  return record;
}

/** @param {unknown} value @returns {unknown[]} */
export function unpackJackRecords(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of ['records', 'record', 'jobs', 'rows', 'data', 'results', 'items']) {
    if (Array.isArray(record[key])) return record[key];
    if (key === 'record' && record[key] && typeof record[key] === 'object') return [record[key]];
  }
  return [value];
}

/** @param {unknown} value */
export function normalizeJackJobs(value) {
  const seen = new Set();
  const jobs = [];
  for (const item of unpackJackRecords(value)) {
    const job = normalizeJackJob(item);
    if (!job || seen.has(job.canonicalUrl)) continue;
    seen.add(job.canonicalUrl);
    jobs.push(job);
  }
  return jobs;
}

/** @param {string} value */
function claimTokens(value) {
  return [...String(value || '').matchAll(/(?:\$\s?\d[\d,.]*|\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?[kKmMbB]\b|\b20\d{2}\b)/g)]
    .map((match) => normalizeText(match[0]).toLowerCase());
}

/**
 * Lightweight evidence guard for coaching output. It does not rewrite Jack's
 * answer; it marks unsupported numeric/date claims for human review.
 *
 * @param {string} response
 * @param {string[]} evidence
 */
export function auditCoachResponse(response, evidence) {
  const corpus = evidence.join('\n').toLowerCase();
  const unsupported = [...new Set(claimTokens(response).filter((token) => !corpus.includes(token)))];
  return {
    accepted: unsupported.length === 0,
    unsupportedClaims: unsupported,
    warnings: unsupported.length
      ? [`review required: coaching output contains numeric/date claims absent from canonical evidence (${unsupported.join(', ')})`]
      : [],
  };
}

/**
 * Build the explicit prompt used by the Jack & Jill coach command. The
 * delimiters make source provenance visible and give the model a reproducible
 * contract matching the user's Netic/Lightfield coaching examples.
 *
 * @param {{ cv: string, digest: string, profile: string, job: Record<string, unknown>, includeCoverLetter?: boolean }} input
 */
export function buildJackCoachPrompt(input) {
  const job = input.job;
  const includeCoverLetter = input.includeCoverLetter !== false;
  const jobText = [
    `Title: ${normalizeText(job.title)}`,
    `Company: ${normalizeText(job.company)}`,
    `Location: ${normalizeText(job.location)}`,
    `Compensation: ${normalizeText(job.compensation)}`,
    `Source URL: ${normalizeText(job.sourceUrl || job.url)}`,
    `Description:\n${normalizeText(job.description)}`,
  ].join('\n');
  return [
    'You are coaching one real job application. Use only the canonical evidence below and the target job description.',
    'Do not invent metrics, tools, dates, customers, employers, responsibilities, or outcomes. If evidence is missing, say so and recommend a truthful framing.',
    'Give concrete edits in the same useful style as the prior Netic and Lightfield examples:',
    '1. Summary/Headline: provide a replacement and explain the positioning choice.',
    '2. Prioritized proof-point edits: rewrite the highest-value bullets with truthful evidence and identify what to move up or down.',
    '3. Project ordering: specify which projects should be front and center and why.',
    '4. Skills emphasis: name the skills to emphasize, de-emphasize, or verify against the evidence.',
    includeCoverLetter
      ? '5. Optional cover letter: draft a concise, role-specific letter only from the same evidence.'
      : '5. Do not draft a cover letter unless explicitly requested.',
    'End with a short evidence review listing any recommendation that needs user confirmation before editing the resume.',
    '',
    '=== TARGET JOB (LIVE JACK & JILL RECORD) ===',
    jobText,
    '=== CANONICAL CV: cv.md ===',
    input.cv,
    '=== CANONICAL PROOF POINTS: article-digest.md ===',
    input.digest,
    '=== CANONICAL PROFILE: config/profile.yml ===',
    input.profile,
    '=== END SOURCES ===',
  ].join('\n');
}

/** @param {string} file @param {string} fallback */
export function readOptionalSource(file, fallback = '') {
  return existsSync(file) ? readFileSync(file, 'utf8') : fallback;
}
