// @ts-check
/**
 * posting-fetch.mjs — fetch the real job posting behind a URL.
 *
 * Email alerts carry a link and a subject line, nothing more. Scoring a candidate
 * from that alone produces a title-match-only fit score that is identical for every
 * such item, so they are mutually indistinguishable and invisible to daily selection.
 * Worse, digest subjects ("{Role} at {Company} and 7 more jobs in New York, NY for
 * you. Apply Now.") put the whole tail into `company`, and one subject gets stamped
 * onto every URL in the email.
 *
 * Fetching the posting fixes all of that at once: real title, real company, real
 * location, and a description the blocker rules can actually read.
 *
 * Sources:
 *   - LinkedIn  → the public unauthenticated guest posting endpoint. No login, no
 *                 session, no paywall. The `/comm/` tracking prefix that alert URLs
 *                 carry is rewritten to the canonical job id first.
 *   - Greenhouse / Lever / Ashby → the same public ATS JSON APIs used by
 *                 liveness-api.mjs, via resolveAtsApi().
 *   - Company-hosted Greenhouse embeds → guessed from the `gh_jid` param.
 *   - Anything else → reported as unsupported and left untouched.
 */

import { resolveAtsApi } from './liveness-api.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const MIN_DESCRIPTION_CHARS = 200;

/**
 * Collapse HTML into readable plain text.
 * @param {string} html
 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&rdquo;|&ldquo;/g, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    // Dropped block tags leave leading padding on each line (" - Python" from "<ul><li>").
    .split('\n').map((line) => line.trim()).join('\n')
    .trim();
}

/**
 * Pull the numeric posting id out of any LinkedIn job URL shape, including the
 * `/comm/` tracking variant that email alerts use.
 * @param {string} url
 * @returns {string | null}
 */
export function linkedinJobId(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  if (!/(^|\.)linkedin\.com$/.test(parsed.hostname)) return null;
  const fromPath = parsed.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/);
  if (fromPath) return fromPath[1];
  const fromQuery = parsed.searchParams.get('currentJobId');
  return fromQuery && /^\d{6,}$/.test(fromQuery) ? fromQuery : null;
}

/**
 * Parse the guest posting page into candidate fields.
 * @param {string} html
 */
export function parseLinkedinPosting(html) {
  const pick = (re) => { const m = String(html).match(re); return m ? htmlToText(m[1]) : ''; };
  const description = pick(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const criteria = [...String(html).matchAll(
    /description__job-criteria-subheader[^>]*>([\s\S]*?)<[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)</g,
  )].map((m) => `${htmlToText(m[1])}: ${htmlToText(m[2])}`);
  return {
    title: pick(/<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/),
    company: pick(/topcard__org-name-link[^>]*>([\s\S]*?)</),
    location: pick(/topcard__flavor--bullet[^>]*>([\s\S]*?)</),
    // The criteria block carries the seniority level, which the blocker rules read.
    description: criteria.length ? `${description}\n\n${criteria.join('\n')}` : description,
  };
}

/**
 * Some companies embed a Greenhouse board on their own domain and keep only the
 * `gh_jid` query param (nuro.ai/careersitem?gh_jid=..., seatgeek.com/jobs/N?gh_jid=N).
 * The board token is usually the registrable name, so guess it — a wrong guess just
 * 404s, and callers treat a guessed 404 as unsupported rather than as a dead posting.
 * @param {string} rawUrl
 */
export function resolveEmbeddedGreenhouse(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const jobId = u.searchParams.get('gh_jid');
  if (!jobId || !/^\d{4,}$/.test(jobId)) return null;
  const labels = u.hostname.split('.').filter((label) => label && label !== 'www');
  const board = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  if (!board || !/^[a-z0-9-]+$/i.test(board)) return null;
  return {
    ats: 'greenhouse',
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`,
    parts: { board, jobId },
    guessedBoard: true,
  };
}

/** Is there any public source that can describe this URL? */
export function canFetchPosting(url) {
  return Boolean(linkedinJobId(url) || resolveAtsApi(url) || resolveEmbeddedGreenhouse(url));
}

/** @param {(url: string, init?: any) => Promise<any>} fetchFn */
async function timedFetch(fetchFn, url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchFn(url, { headers, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {{ ok: true, fields: Record<string, string>, liveness: string }
 *   | { ok: false, outcome: 'expired'|'unsupported'|'blocked'|'empty'|'error', reason: string }} FetchOutcome
 */

/** @param {(url: string, init?: any) => Promise<any>} fetchFn @param {string} url @returns {Promise<FetchOutcome>} */
async function fetchLinkedin(fetchFn, url) {
  const id = linkedinJobId(url);
  if (!id) return { ok: false, outcome: 'unsupported', reason: 'no LinkedIn job id in URL' };
  let res;
  try {
    res = await timedFetch(fetchFn, `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
      'user-agent': UA,
      'accept-language': 'en-US,en;q=0.9',
    });
  } catch (error) {
    return { ok: false, outcome: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
  if (res.status === 404 || res.status === 410) {
    return { ok: false, outcome: 'expired', reason: `guest endpoint ${res.status} — posting removed` };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: false, outcome: 'blocked', reason: `guest endpoint ${res.status} — throttled or unavailable` };
  }
  if (!res.ok) return { ok: false, outcome: 'error', reason: `guest endpoint ${res.status}` };
  const fields = parseLinkedinPosting(await res.text());
  if (fields.description.length < MIN_DESCRIPTION_CHARS) {
    return { ok: false, outcome: 'empty', reason: `description too short (${fields.description.length} chars)` };
  }
  return { ok: true, fields, liveness: 'active' };
}

/** @param {(url: string, init?: any) => Promise<any>} fetchFn @param {string} url @returns {Promise<FetchOutcome>} */
async function fetchAts(fetchFn, url) {
  const resolved = resolveAtsApi(url) || resolveEmbeddedGreenhouse(url);
  if (!resolved) return { ok: false, outcome: 'unsupported', reason: 'not a known ATS posting URL' };
  let res;
  try {
    res = await timedFetch(fetchFn, resolved.apiUrl, { 'user-agent': 'career-ops-posting-fetch/1.0', accept: 'application/json' });
  } catch (error) {
    return { ok: false, outcome: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
  if (res.status === 404 || res.status === 410) {
    // A guessed board name is a likely cause of 404 here, so don't call the posting dead.
    return resolved.guessedBoard
      ? { ok: false, outcome: 'unsupported', reason: `guessed Greenhouse board "${resolved.parts.board}" returned ${res.status}` }
      : { ok: false, outcome: 'expired', reason: `${resolved.ats} API ${res.status} — posting removed` };
  }
  if (!res.ok) return { ok: false, outcome: 'error', reason: `${resolved.ats} API ${res.status}` };

  let json;
  try { json = await res.json(); } catch { return { ok: false, outcome: 'error', reason: 'unparseable API body' }; }

  let raw = '';
  let fields = {};
  if (resolved.ats === 'greenhouse') {
    raw = json?.content || '';
    fields = { title: json?.title || '', location: json?.location?.name || '' };
  } else if (resolved.ats === 'lever') {
    raw = [json?.descriptionPlain || json?.description || '', ...(json?.lists || []).map(
      (l) => `${l?.text || ''}\n${l?.content || ''}`,
    )].join('\n');
    fields = { title: json?.text || '', location: json?.categories?.location || '' };
  } else if (resolved.ats === 'ashby') {
    const job = (json?.jobs || []).find((j) => String(j?.id).toLowerCase() === String(resolved.parts.jobId).toLowerCase());
    if (!job) return { ok: false, outcome: 'expired', reason: 'Ashby posting no longer listed on the board' };
    raw = job.descriptionHtml || job.descriptionPlain || '';
    fields = { title: job.title || '', location: job.location || '' };
  }

  const description = htmlToText(raw);
  if (description.length < MIN_DESCRIPTION_CHARS) {
    return { ok: false, outcome: 'empty', reason: `description too short (${description.length} chars)` };
  }
  return { ok: true, fields: { ...fields, description }, liveness: 'active' };
}

/**
 * @param {string} url
 * @param {{ fetchFn?: (url: string, init?: any) => Promise<any> }} [options]
 * @returns {Promise<FetchOutcome>}
 */
export async function fetchPosting(url, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  if (linkedinJobId(url)) return fetchLinkedin(fetchFn, url);
  if (resolveAtsApi(url) || resolveEmbeddedGreenhouse(url)) return fetchAts(fetchFn, url);
  return { ok: false, outcome: 'unsupported', reason: 'no public description source for this host' };
}

/** Run `worker` over `items` with bounded concurrency and a polite inter-request gap. */
export async function pool(items, concurrency, gapMs, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
      if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  });
  await Promise.all(runners);
}

/**
 * Fill in title/company/location/description for candidates that arrived without a
 * description — email alerts, mostly. Candidates that already carry a description,
 * or whose host has no public source, pass through untouched.
 *
 * A candidate whose posting is gone is marked `liveness: 'expired'`; the caller
 * already drops expired candidates, so a dead alert link never becomes a queue item.
 *
 * @param {Array<Record<string, any>>} candidates
 * @param {{ limit?: number, concurrency?: number, gapMs?: number,
 *           fetchFn?: (url: string, init?: any) => Promise<any>,
 *           log?: (message: string) => void }} [options]
 */
export async function enrichCandidates(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const limit = Number.isFinite(options.limit) ? Number(options.limit) : 150;
  const outcomes = { updated: 0, expired: 0, unsupported: 0, blocked: 0, empty: 0, error: 0, skipped: 0 };
  const enriched = new Map();

  const eligible = [];
  for (const candidate of list) {
    const url = String(candidate?.canonicalUrl || candidate?.url || '');
    if (String(candidate?.description || '').trim()) continue;
    if (!url || !canFetchPosting(url)) { outcomes.skipped += 1; continue; }
    eligible.push({ candidate, url });
  }

  // Alert candidates are the ones scored blind, so they get the fetch budget first.
  // Scanned candidates arrive with a real title and company already, and reach the
  // caller in source order — without this they would eat the whole limit.
  const targets = [
    ...eligible.filter(({ candidate }) => candidate.liveness === 'source-alert'),
    ...eligible.filter(({ candidate }) => candidate.liveness !== 'source-alert'),
  ].slice(0, limit);
  outcomes.skipped += eligible.length - targets.length;

  if (targets.length) {
    await pool(targets, options.concurrency ?? 2, options.gapMs ?? 600, async ({ candidate, url }) => {
      const result = await fetchPosting(url, { fetchFn: options.fetchFn });
      if (!result.ok) {
        outcomes[result.outcome] += 1;
        if (result.outcome === 'expired') enriched.set(candidate, { ...candidate, liveness: 'expired' });
        return;
      }
      outcomes.updated += 1;
      enriched.set(candidate, {
        ...candidate,
        // The posting is authoritative. Alert-derived title/company are subject-line
        // guesses and are wrong often enough that they must never win here.
        title: result.fields.title || candidate.title,
        company: result.fields.company || candidate.company,
        location: result.fields.location || candidate.location,
        description: result.fields.description,
        liveness: result.liveness,
        descriptionFetchedAt: new Date().toISOString(),
      });
    });
  }

  if (options.log) {
    const summary = Object.entries(outcomes).filter(([, count]) => count).map(([key, count]) => `${key} ${count}`).join(', ');
    options.log(`posting-fetch: enriched ${outcomes.updated}/${targets.length} candidate(s)${summary ? ` (${summary})` : ''}`);
  }

  return { candidates: list.map((candidate) => enriched.get(candidate) || candidate), outcomes };
}
