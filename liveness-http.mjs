// @ts-check

import { normalizeUrl } from './queue-lib.mjs';

/**
 * Bounded public liveness check. It never follows redirects and treats only
 * definitive 404/410 responses as expired; network and other HTTP ambiguity
 * remain uncertain.
 * @param {string} url
 * @param {(input: string, init?: RequestInit) => Promise<Response>} [fetchFn]
 * @returns {Promise<'active'|'expired'|'uncertain'>}
 */
export async function checkPublicLiveness(url, fetchFn = globalThis.fetch) {
  const normalized = normalizeUrl(url);
  if (!normalized) return 'uncertain';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    let response = await fetchFn(normalized, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'career-ops-queue/1.0' },
    });
    if (response.status === 405 || response.status === 403) {
      response = await fetchFn(normalized, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'career-ops-queue/1.0', Range: 'bytes=0-1024' },
      });
    }
    if (response.status === 404 || response.status === 410) return 'expired';
    if (response.status >= 200 && response.status < 400) return 'active';
    return 'uncertain';
  } catch {
    return 'uncertain';
  } finally {
    clearTimeout(timer);
  }
}
