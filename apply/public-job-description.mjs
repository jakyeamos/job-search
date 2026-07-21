// @ts-check

import { fetchJson as defaultFetchJson } from '../providers/_http.mjs';
import { resolveAtsApi } from '../liveness-api.mjs';

const MIN_PUBLIC_DESCRIPTION_CHARS = 120;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} value @returns {string} */
function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits) => {
      const codePoint = Number(digits);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/&#x([\da-f]+);/gi, (_match, digits) => {
      const codePoint = Number.parseInt(digits, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    });
}

/**
 * Convert the HTML or plain-text description exposed by a public ATS endpoint
 * into the normalized text consumed by artifact generation.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePublicDescription(value) {
  if (typeof value !== 'string') return '';
  return decodeHtmlEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {unknown} payload @param {string} jobId @returns {Record<string, unknown>|null} */
function findAshbyJob(payload, jobId) {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) return null;
  const target = String(jobId || '').toLowerCase();
  return payload.jobs.find((job) => isRecord(job) && String(job.id || '').toLowerCase() === target) || null;
}

/**
 * Extract a description from the documented/public response shapes already
 * used by the ATS liveness and scanner providers. Unknown shapes return an
 * empty string so the caller can use the existing HTML fallback.
 *
 * @param {string} ats
 * @param {unknown} payload
 * @param {Record<string, string>} [parts]
 * @returns {string}
 */
export function extractAtsDescription(ats, payload, parts = {}) {
  /** @type {unknown[]} */
  let candidates = [];
  if (ats === 'greenhouse' && isRecord(payload)) {
    candidates = [payload.content, payload.descriptionHtml, payload.description];
  } else if (ats === 'lever' && isRecord(payload)) {
    candidates = [payload.descriptionPlain, payload.description, payload.descriptionHtml];
  } else if (ats === 'ashby') {
    const job = findAshbyJob(payload, parts.jobId || '');
    candidates = job ? [job.descriptionPlain, job.descriptionHtml, job.description] : [];
  }

  for (const candidate of candidates) {
    const description = normalizePublicDescription(candidate);
    if (description.length >= MIN_PUBLIC_DESCRIPTION_CHARS) return description;
  }
  return '';
}

/** @param {string} url @returns {string} */
function ashbyDescriptionUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('includeCompensation', 'true');
  return parsed.href;
}

/**
 * Fetch one public ATS description without starting a browser. The endpoint is
 * derived only from the fixed-host mapping in liveness-api.mjs; failures are
 * intentionally inconclusive so the caller can preserve its existing fallback.
 *
 * @param {string} rawUrl
 * @param {{ fetchJson?: (url: string, options?: Record<string, unknown>) => Promise<unknown> }} [options]
 * @returns {Promise<{ ats: string, endpoint: string, description: string }|null>}
 */
export async function fetchAtsJobDescription(rawUrl, options = {}) {
  const resolved = resolveAtsApi(rawUrl);
  if (!resolved) return null;

  const endpoint = resolved.ats === 'ashby'
    ? ashbyDescriptionUrl(resolved.apiUrl)
    : resolved.apiUrl;
  const fetchJson = options.fetchJson || defaultFetchJson;
  try {
    const payload = await fetchJson(endpoint, {
      timeoutMs: resolved.timeoutMs,
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    const description = extractAtsDescription(resolved.ats, payload, resolved.parts);
    return description
      ? { ats: resolved.ats, endpoint, description }
      : null;
  } catch {
    return null;
  }
}
