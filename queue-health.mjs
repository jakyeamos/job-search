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
import { normalizeUrl, readQueueState, renderQueueMarkdown, writeQueueState } from './queue-lib.mjs';
import { acquireExclusiveLock } from './apply/application-run-state.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(ROOT, 'data', 'job-queue.json');
const HEALTH_LOCK_FILE = path.join(ROOT, 'data', '.queue-health.lock');
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2_000;
const HEALTH_STATUSES = new Set(['ready', 'in_review', 'snoozed']);
const RESTRICTED_HOSTS = new Set(['linkedin.com', 'www.linkedin.com', 'teamworkonline.com', 'www.teamworkonline.com']);

/** @param {string} root @param {Record<string, unknown>} state */
function saveHealthQueue(root, state) {
  writeQueueState(path.join(root, 'data', 'job-queue.json'), state);
  writeFileSync(path.join(root, 'data', 'job-queue.md'), renderQueueMarkdown(state), 'utf8');
}

/** @param {string} rawUrl */
export function isRestrictedHealthUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    return RESTRICTED_HOSTS.has(hostname);
  } catch {
    return false;
  }
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
 * restricted alert URLs are reported separately without being crawled.
 * @param {Record<string, unknown>} state
 * @param {{ limit?: number, all?: boolean }} [options]
 * @returns {{ targets: Array<{ url: string, items: Array<Record<string, unknown>> }>, skippedRestricted: Array<Record<string, unknown>> }}
 */
export function selectHealthTargets(state, options = {}) {
  const grouped = new Map();
  const skippedRestricted = [];
  const items = Array.isArray(state.items) ? state.items : [];
  const candidates = items
    .filter((item) => HEALTH_STATUSES.has(String(item.status || '')))
    .map((item) => ({ item, url: normalizeUrl(String(item.applyUrl || item.canonicalUrl || '')) }))
    .filter(({ item, url }) => {
      if (!url) return false;
      if (String(item.liveness || '') === 'source-alert' || isRestrictedHealthUrl(url)) {
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

/** @typedef {{ result: 'active'|'expired'|'uncertain', method: string, code?: string, reason: string }} HealthResult */

/**
 * Check a URL without starting a browser unless the caller explicitly opts in.
 * @param {string} url
 * @param {{ allowBrowser?: boolean, getBrowserTools?: () => Promise<{ page: import('playwright').Page, getHeadedPage?: () => Promise<import('playwright').Page|null> }|null>, apiChecker?: typeof checkLivenessViaApi, publicChecker?: typeof checkPublicLiveness }} [options]
 * @returns {Promise<HealthResult>}
 */
export async function checkHealthUrl(url, options = {}) {
  if (isRestrictedHealthUrl(url)) {
    return { result: 'uncertain', method: 'skipped', code: 'restricted_source', reason: 'restricted job-alert source is not crawled' };
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
  const browserResult = await checkUrlLivenessWithFallback(browserTools.page, url, {
    getHeadedPage: browserTools.getHeadedPage,
  });
  return {
    result: browserResult.result,
    method: 'playwright',
    code: browserResult.code,
    reason: browserResult.reason,
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
  state.items = (Array.isArray(state.items) ? state.items : []).map((item) => {
    if (!targetIds.has(item.id) || !HEALTH_STATUSES.has(String(item.status || ''))) return item;
    const next = {
      ...item,
      liveness: result.result,
      livenessCheckedAt: at,
      livenessCheck: {
        result: result.result,
        method: result.method,
        code: result.code || null,
        reason: result.reason,
        at,
      },
    };
    if (result.result === 'expired') {
      next.status = 'stale';
      next.staleAt = at;
      next.staleReason = result.reason;
      next.selectedForToday = false;
      next.queueRank = null;
    }
    updated.push({ id: item.id, previousStatus: item.status, status: next.status, result: result.result });
    return next;
  });
  return updated;
}

/** @param {Array<Record<string, unknown>>} results @param {number} skippedRestricted */
function summarize(results, skippedRestricted) {
  const summary = { checked: results.length, active: 0, expired: 0, uncertain: 0, skippedRestricted };
  for (const result of results) summary[result.result] = (summary[result.result] || 0) + 1;
  return summary;
}

/**
 * Run a bounded queue health sweep. Dry-run is the default; `apply: true` is
 * required to persist liveness changes and mark confirmed closed roles stale.
 * @param {{ root?: string, limit?: number, all?: boolean, apply?: boolean, browser?: boolean }} [options]
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
    const selected = selectHealthTargets(state, { limit: options.limit, all: options.all });
    const reports = [];
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
      reports.push({
        url: target.url,
        ids: target.items.map((item) => item.id),
        company: target.items[0]?.company || '',
        title: target.items[0]?.title || '',
        ...result,
      });
      if (apply) applyHealthResult(state, target, result);
    }

    const summary = summarize(reports, selected.skippedRestricted.length);
    const result = {
      ok: true,
      dryRun: !apply,
      browser: options.browser === true,
      scope: options.all ? 'all' : `limit:${selected.targets.length}`,
      summary,
      skippedRestricted: selected.skippedRestricted.map((item) => ({ id: item.id, company: item.company, title: item.title })),
      reports,
      browserError,
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
    `Restricted alert URLs skipped: ${summary.skippedRestricted || 0}.`,
  ];
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
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(args.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || DEFAULT_LIMIT) || DEFAULT_LIMIT));
  runQueueHealth({ limit, all, apply, browser })
    .then((result) => console.log(json ? JSON.stringify(result, null, 2) : renderHealthReport(result)))
    .catch((error) => {
      console.error(`queue health: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
