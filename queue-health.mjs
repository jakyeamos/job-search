#!/usr/bin/env node
// @ts-check

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { checkLivenessViaApi } from './liveness-api.mjs';
import {
  checkUrlLivenessWithFallback,
  createHeadedPageProvider,
  newLivenessPage,
} from './liveness-browser.mjs';
import { checkPublicLiveness } from './liveness-http.mjs';
import { fetchPosting, linkedinJobId } from './posting-fetch.mjs';
import { normalizeUrl, readQueueState, renderQueueMarkdown, writeQueueState } from './queue-lib.mjs';
import { acquireExclusiveLock } from './apply/application-run-state.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(ROOT, 'data', 'job-queue.json');
const HEALTH_LOCK_FILE = path.join(ROOT, 'data', '.queue-health.lock');
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2_000;
const HEALTH_STATUSES = new Set(['ready', 'in_review', 'snoozed']);
const RESTRICTED_HOSTS = new Set(['teamworkonline.com']);

/** @param {string} root @param {Record<string, unknown>} state */
function saveHealthQueue(root, state) {
  writeQueueState(path.join(root, 'data', 'job-queue.json'), state);
  writeFileSync(path.join(root, 'data', 'job-queue.md'), renderQueueMarkdown(state), 'utf8');
}

/** @param {string} rawUrl @returns {string} */
function healthHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** @param {string} rawUrl */
export function isLinkedInHealthUrl(rawUrl) {
  const hostname = healthHostname(rawUrl);
  return hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
}

/** @param {string} rawUrl */
export function isRestrictedHealthUrl(rawUrl) {
  const hostname = healthHostname(rawUrl);
  return [...RESTRICTED_HOSTS].some((restricted) => (
    hostname === restricted || hostname.endsWith(`.${restricted}`)
  ));
}

/** @param {Record<string, unknown>} item */
function itemTimestamp(item) {
  const checked = Date.parse(String(item.livenessCheckedAt || ''));
  if (Number.isFinite(checked)) return checked;
  return 0;
}

/** @param {Record<string, unknown>} item */
function postedTimestamp(item) {
  const posted = Date.parse(String(item.postedAt || ''));
  if (Number.isFinite(posted)) return posted;
  const discovered = Date.parse(String(item.discoveredAt || ''));
  return Number.isFinite(discovered) ? discovered : Number.MAX_SAFE_INTEGER;
}

/**
 * Choose unique URLs for a health sweep. Oldest unchecked roles are first, and
 * restricted alert URLs are reported separately without being crawled. LinkedIn
 * alerts are eligible because their numeric job id maps to a bounded public guest
 * endpoint; no authenticated page or profile is scraped.
 * @param {Record<string, unknown>} state
 * @param {{ limit?: number, all?: boolean, linkedinOnly?: boolean }} [options]
 * @returns {{ targets: Array<{ url: string, items: Array<Record<string, unknown>> }>, skippedRestricted: Array<Record<string, unknown>> }}
 */
export function selectHealthTargets(state, options = {}) {
  const grouped = new Map();
  const skippedRestricted = [];
  const items = Array.isArray(state.items) ? state.items : [];
  const candidates = items
    .filter((item) => HEALTH_STATUSES.has(String(item.status || '')))
    .map((item) => ({ item, url: normalizeUrl(String(item.applyUrl || item.canonicalUrl || '')) }))
    .filter(({ url }) => options.linkedinOnly !== true || isLinkedInHealthUrl(url))
    .filter(({ item, url }) => {
      if (!url) return false;
      const sourceAlertWithoutPublicCheck = String(item.liveness || '') === 'source-alert'
        && !isLinkedInHealthUrl(url);
      if (sourceAlertWithoutPublicCheck || isRestrictedHealthUrl(url)) {
        skippedRestricted.push(item);
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const leftChecked = itemTimestamp(left.item);
      const rightChecked = itemTimestamp(right.item);
      return leftChecked - rightChecked
        || postedTimestamp(left.item) - postedTimestamp(right.item)
        || String(left.item.id || '').localeCompare(String(right.item.id || ''));
    });

  for (const { item, url } of candidates) {
    const current = grouped.get(url) || { url, items: [] };
    current.items.push(item);
    grouped.set(url, current);
  }

  const limit = options.all
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Math.min(MAX_LIMIT, Number(options.limit || DEFAULT_LIMIT)));
  return {
    targets: [...grouped.values()].slice(0, limit),
    skippedRestricted,
  };
}

/**
 * @typedef {{
 *   result: 'active'|'expired'|'uncertain',
 *   method: string,
 *   code?: string,
 *   reason: string,
 *   observedTitle?: string,
 *   observedCompany?: string,
 *   observedLocation?: string,
 *   identityMismatchIds?: string[],
 * }} HealthResult
 */

const LINKEDIN_OUTCOME_CODES = {
  expired: 'linkedin_guest_gone',
  blocked: 'linkedin_guest_blocked',
  empty: 'linkedin_guest_empty',
  unsupported: 'linkedin_url_unsupported',
  error: 'linkedin_guest_error',
};

/**
 * Check a URL without starting a browser unless the caller explicitly opts in.
 * @param {string} url
 * @param {{
 *   allowBrowser?: boolean,
 *   getBrowserTools?: () => Promise<{ page: import('playwright').Page, getHeadedPage?: () => Promise<import('playwright').Page|null> }|null>,
 *   apiChecker?: typeof checkLivenessViaApi,
 *   publicChecker?: typeof checkPublicLiveness,
 *   linkedinChecker?: typeof fetchPosting,
 *   browserChecker?: typeof checkUrlLivenessWithFallback,
 * }} [options]
 * @returns {Promise<HealthResult>}
 */
export async function checkHealthUrl(url, options = {}) {
  if (isRestrictedHealthUrl(url)) {
    return { result: 'uncertain', method: 'skipped', code: 'restricted_source', reason: 'restricted job-alert source is not crawled' };
  }

  if (isLinkedInHealthUrl(url)) {
    const posting = await (options.linkedinChecker || fetchPosting)(url);
    if (posting.ok && posting.liveness === 'active') {
      return {
        result: 'active',
        method: 'linkedin-guest',
        code: 'linkedin_guest_active',
        reason: 'public LinkedIn guest posting is present',
        observedTitle: String(posting.fields.title || ''),
        observedCompany: String(posting.fields.company || ''),
        observedLocation: String(posting.fields.location || ''),
      };
    }
    const outcome = posting.ok ? 'error' : posting.outcome;
    if (outcome !== 'expired' && options.allowBrowser && options.getBrowserTools) {
      const browserTools = await options.getBrowserTools();
      if (!browserTools) {
        return {
          result: 'uncertain',
          method: 'browser-unavailable',
          code: 'browser_unavailable',
          reason: `LinkedIn guest check was ${outcome}; browser fallback could not start`,
        };
      }
      const id = linkedinJobId(url);
      const browserUrl = id ? `https://www.linkedin.com/jobs/view/${id}` : url;
      const browserResult = await (options.browserChecker || checkUrlLivenessWithFallback)(
        browserTools.page,
        browserUrl,
        { getHeadedPage: browserTools.getHeadedPage },
      );
      return {
        result: browserResult.result,
        method: 'playwright-linkedin',
        code: browserResult.code,
        reason: `guest check ${outcome}; browser: ${browserResult.reason}`,
      };
    }
    return {
      result: outcome === 'expired' ? 'expired' : 'uncertain',
      method: 'linkedin-guest',
      code: LINKEDIN_OUTCOME_CODES[outcome] || 'linkedin_guest_inconclusive',
      reason: posting.ok ? 'LinkedIn guest posting did not confirm an active role' : posting.reason,
    };
  }

  const api = await (options.apiChecker || checkLivenessViaApi)(url);
  if (api) {
    return { result: api.result, method: 'ats-api', code: api.code, reason: api.reason };
  }

  const http = await (options.publicChecker || checkPublicLiveness)(url);
  if (http !== 'uncertain') {
    return {
      result: http,
      method: 'http',
      code: http === 'expired' ? 'http_gone' : 'http_reachable',
      reason: http === 'expired' ? 'public URL returned 404/410' : 'public URL returned a reachable response',
    };
  }

  if (!options.allowBrowser || !options.getBrowserTools) {
    return { result: 'uncertain', method: 'http', code: 'inconclusive', reason: 'API and lightweight HTTP checks were inconclusive' };
  }

  const browserTools = await options.getBrowserTools();
  if (!browserTools) {
    return { result: 'uncertain', method: 'browser-unavailable', code: 'browser_unavailable', reason: 'browser fallback was requested but could not start' };
  }
  const browserResult = await (options.browserChecker || checkUrlLivenessWithFallback)(browserTools.page, url, {
    getHeadedPage: browserTools.getHeadedPage,
  });
  return {
    result: browserResult.result,
    method: 'playwright',
    code: browserResult.code,
    reason: browserResult.reason,
  };
}

/** @param {string} value */
function linkedinCompanyKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(incorporated|corporation|company|limited|inc|llc|ltd|corp|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * LinkedIn alert subjects often append salary or date text to the employer.
 * Exact compact matches and sufficiently long prefix matches preserve those
 * benign suffixes while still catching URLs bound to a different company.
 * @param {string} queuedCompany
 * @param {string} observedCompany
 */
export function linkedinCompaniesMatch(queuedCompany, observedCompany) {
  const queued = linkedinCompanyKey(queuedCompany);
  const observed = linkedinCompanyKey(observedCompany);
  if (!queued || !observed) return true;
  if (queued === observed) return true;
  return Math.min(queued.length, observed.length) >= 4
    && (queued.startsWith(observed) || observed.startsWith(queued));
}

/**
 * Convert a LinkedIn "active" result into an identity-mismatch result when the
 * public posting belongs to a different employer than the queued role.
 * @param {{ items: Array<Record<string, unknown>> }} target
 * @param {HealthResult} result
 * @returns {HealthResult}
 */
export function annotateLinkedInIdentity(target, result) {
  if (result.result !== 'active' || result.method !== 'linkedin-guest' || !result.observedCompany) {
    return result;
  }
  const mismatchItems = target.items.filter((item) => (
    !linkedinCompaniesMatch(String(item.company || ''), String(result.observedCompany || ''))
  ));
  if (!mismatchItems.length) return result;
  const first = mismatchItems[0];
  const reason = `queued employer "${String(first.company || 'Unknown')}" does not match LinkedIn employer "${result.observedCompany}"`;
  return {
    ...result,
    ...(mismatchItems.length === target.items.length
      ? { result: 'uncertain', code: 'linkedin_identity_mismatch', reason }
      : {}),
    identityMismatchIds: mismatchItems.map((item) => String(item.id || '')).filter(Boolean),
  };
}

/**
 * Apply one confirmed health result. Only mutable queue statuses are touched;
 * applied, skipped, excluded, stale, and terminal application records remain
 * untouched by the sweep.
 * @param {Record<string, unknown>} state
 * @param {{ url: string, items: Array<Record<string, unknown>> }} target
 * @param {HealthResult} result
 * @param {string} [at]
 * @returns {Array<Record<string, unknown>>}
 */
export function applyHealthResult(state, target, result, at = new Date().toISOString()) {
  const updated = [];
  const targetIds = new Set(target.items.map((item) => item.id));
  const identityMismatchIds = new Set(result.identityMismatchIds || []);
  state.items = (Array.isArray(state.items) ? state.items : []).map((item) => {
    if (!targetIds.has(item.id) || !HEALTH_STATUSES.has(String(item.status || ''))) return item;
    const identityMismatch = identityMismatchIds.has(String(item.id || ''));
    const effectiveResult = identityMismatch ? 'uncertain' : result.result;
    const next = {
      ...item,
      liveness: effectiveResult,
      livenessCheckedAt: at,
      ...(effectiveResult === 'active' ? { lastConfirmedActiveAt: at } : {}),
      livenessCheck: {
        result: effectiveResult,
        method: result.method,
        code: identityMismatch ? 'linkedin_identity_mismatch' : (result.code || null),
        reason: result.reason,
        at,
        ...((result.observedTitle || result.observedCompany || result.observedLocation) ? {
          observed: {
            title: result.observedTitle || '',
            company: result.observedCompany || '',
            location: result.observedLocation || '',
          },
        } : {}),
      },
    };
    if (effectiveResult === 'expired' || identityMismatch) {
      next.status = 'stale';
      next.staleAt = at;
      next.staleReason = result.reason;
      next.selectedForToday = false;
      next.queueRank = null;
    }
    updated.push({ id: item.id, previousStatus: item.status, status: next.status, result: effectiveResult });
    return next;
  });
  return updated;
}

/**
 * Stop a LinkedIn sweep immediately on throttling, or after three consecutive
 * malformed/network responses. This prevents one provider outage from turning
 * an entire queue into repeated inconclusive requests.
 * @param {HealthResult} result
 * @param {number} [consecutiveSourceFailures]
 */
export function healthCircuitDecision(result, consecutiveSourceFailures = 0) {
  if (result.code === 'linkedin_guest_blocked') {
    return {
      stop: true,
      consecutiveSourceFailures: consecutiveSourceFailures + 1,
      reason: result.reason,
    };
  }
  const sourceFailure = result.code === 'linkedin_guest_error'
    || result.code === 'linkedin_guest_empty'
    || (result.method === 'playwright-linkedin' && result.result === 'uncertain');
  const nextFailures = sourceFailure ? consecutiveSourceFailures + 1 : 0;
  return {
    stop: nextFailures >= 3,
    consecutiveSourceFailures: nextFailures,
    reason: nextFailures >= 3 ? 'three consecutive inconclusive LinkedIn responses' : '',
  };
}

/** @param {Array<Record<string, unknown>>} results @param {number} skippedRestricted @param {number} deferred */
function summarize(results, skippedRestricted, deferred = 0) {
  const summary = {
    checked: results.length,
    active: 0,
    expired: 0,
    uncertain: 0,
    mismatched: 0,
    deferred,
    skippedRestricted,
  };
  for (const result of results) {
    summary[result.result] = (summary[result.result] || 0) + 1;
    if (Array.isArray(result.identityMismatchIds) && result.identityMismatchIds.length) summary.mismatched++;
  }
  return summary;
}

/**
 * Run a bounded queue health sweep. Dry-run is the default; `apply: true` is
 * required to persist liveness changes and mark confirmed closed roles stale.
 * @param {{ root?: string, limit?: number, all?: boolean, apply?: boolean, browser?: boolean, linkedinOnly?: boolean }} [options]
 */
export async function runQueueHealth(options = {}) {
  const root = options.root || ROOT;
  const queueFile = path.join(root, 'data', 'job-queue.json');
  const lockFile = path.join(root, 'data', '.queue-health.lock');
  const release = acquireExclusiveLock(lockFile, 'queue health sweep');
  const apply = options.apply === true;
  let browser = null;
  let page = null;
  let headed = null;
  let browserError = null;
  let browserToolsPromise = null;

  async function getBrowserTools() {
    if (browserError) return null;
    if (browser && page) return { page, getHeadedPage: headed ? () => headed.get() : undefined };
    if (browserToolsPromise) return browserToolsPromise;
    browserToolsPromise = (async () => {
      try {
        browser = await chromium.launch({ headless: true });
        page = await newLivenessPage(browser);
        headed = createHeadedPageProvider(chromium);
        return { page, getHeadedPage: () => headed.get() };
      } catch (error) {
        browserError = error instanceof Error ? error.message : String(error);
        return null;
      }
    })();
    return browserToolsPromise;
  }

  try {
    const state = readQueueState(queueFile);
    const selected = selectHealthTargets(state, {
      limit: options.limit,
      all: options.all,
      linkedinOnly: options.linkedinOnly,
    });
    const reports = [];
    let consecutiveSourceFailures = 0;
    let stoppedEarly = null;
    for (const target of selected.targets) {
      let result;
      try {
        result = await checkHealthUrl(target.url, {
          allowBrowser: options.browser === true,
          getBrowserTools,
        });
      } catch (error) {
        result = {
          result: 'uncertain',
          method: 'error',
          code: 'health_check_error',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      result = annotateLinkedInIdentity(target, result);
      reports.push({
        url: target.url,
        ids: target.items.map((item) => item.id),
        company: target.items[0]?.company || '',
        title: target.items[0]?.title || '',
        ...result,
      });
      if (apply) applyHealthResult(state, target, result);
      const circuit = healthCircuitDecision(result, consecutiveSourceFailures);
      consecutiveSourceFailures = circuit.consecutiveSourceFailures;
      if (circuit.stop) {
        stoppedEarly = {
          code: result.code || 'provider_circuit_open',
          reason: circuit.reason,
          afterChecked: reports.length,
        };
        break;
      }
    }

    const deferred = selected.targets.length - reports.length;
    const summary = summarize(reports, selected.skippedRestricted.length, deferred);
    const result = {
      ok: true,
      dryRun: !apply,
      browser: options.browser === true,
      scope: `${options.linkedinOnly ? 'linkedin:' : ''}${options.all ? 'all' : `limit:${selected.targets.length}`}`,
      summary,
      skippedRestricted: selected.skippedRestricted.map((item) => ({ id: item.id, company: item.company, title: item.title })),
      reports,
      browserError,
      stoppedEarly,
    };
    if (apply) {
      const at = new Date().toISOString();
      state.generatedAt = at;
      state.lastHealthCheck = {
        at,
        mode: 'apply',
        browser: options.browser === true,
        scope: result.scope,
        summary,
        browserError,
      };
      saveHealthQueue(root, state);
    }
    return result;
  } finally {
    if (headed) await headed.close();
    if (browser) await browser.close();
    release();
  }
}

/** @param {Record<string, unknown>} result */
export function renderHealthReport(result) {
  const summary = result.summary || {};
  const lines = [
    `Queue health (${result.dryRun ? 'dry run' : 'applied'})`,
    `Checked ${summary.checked || 0} unique URL(s): ${summary.active || 0} active, ${summary.expired || 0} expired, ${summary.uncertain || 0} uncertain.`,
    `LinkedIn identity mismatches: ${summary.mismatched || 0}.`,
    `Restricted alert URLs skipped: ${summary.skippedRestricted || 0}.`,
  ];
  if (summary.deferred) {
    lines.push(`Provider circuit breaker deferred ${summary.deferred} URL(s) without checking them.`);
  }
  if (result.browserError) lines.push(`Browser fallback: ${result.browserError}`);
  const expired = Array.isArray(result.reports) ? result.reports.filter((item) => item.result === 'expired') : [];
  for (const item of expired.slice(0, 20)) lines.push(`STALE ${item.company || 'Unknown'} | ${item.title || 'Untitled'} | ${item.url}`);
  if (expired.length > 20) lines.push(`… ${expired.length - 20} more expired URL(s) in JSON output.`);
  return lines.join('\n');
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const apply = args.includes('--apply');
  const json = args.includes('--json');
  const browser = args.includes('--browser');
  const linkedinOnly = args.includes('--linkedin');
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(args.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || DEFAULT_LIMIT) || DEFAULT_LIMIT));
  runQueueHealth({ limit, all, apply, browser, linkedinOnly })
    .then((result) => console.log(json ? JSON.stringify(result, null, 2) : renderHealthReport(result)))
    .catch((error) => {
      console.error(`queue health: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
