#!/usr/bin/env node
// @ts-check

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTHENTICATED_MARKETPLACE_SOURCE_IDS,
  canonicalMarketplaceUrl,
  getMarketplaceSource,
  isMarketplaceHost,
  normalizeMarketplaceJobs,
  normalizeText,
} from './authenticated-marketplace-lib.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_SECONDS = 45;
const DEFAULT_DISCOVERY_LIMIT = 10;
const MAX_DISCOVERY_LIMIT = 20;
const DETAIL_WAIT_SECONDS = 6;

/**
 * Read-only DOM extraction shared by Wellfound, Contra, and Braintrust.
 * It deliberately does not click, type, save, apply, message, or submit.
 */
export const READ_MARKETPLACE_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const textOf = (node) => clean(node && (node.innerText || node.textContent));
  const absoluteUrl = (value) => {
    try {
      const url = new URL(String(value || ''), location.origin);
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  };
  const body = document.querySelector('main, [role="main"], article') || document.body;
  const bodyText = textOf(body);
  const controls = [...document.querySelectorAll('button, a, [role="button"]')];
  const applyControl = controls.find((node) => /\\bapply(?: now)?\\b/i.test(textOf(node)));
  const loginControl = controls.find((node) => /^(?:sign in|log in|login|create account|join)$/i.test(textOf(node)));
  const navText = [...document.querySelectorAll('nav, header')].map(textOf).join(' ');
  const accountControl = controls.find((node) => /^(?:profile|my profile|account|dashboard|messages|inbox|sign out|log out|my jobs|my work)$/i.test(textOf(node)));
  const hasAuthenticatedNav = !loginControl && Boolean(accountControl)
    || (!loginControl && /\\b(?:dashboard|messages|inbox|my profile|sign out|log out|saved jobs|my jobs|my work|wallet balance|feed)\\b/i.test(navText));
  const headings = [...document.querySelectorAll('h1, h2, [role="heading"]')];
  const heading = headings[0];
  const textForSelector = (selector) => textOf(document.querySelector(selector));
  const company = textForSelector('[data-testid*="company" i], [data-testid*="client" i], [data-testid*="employer" i], [class*="company" i], [class*="client" i], [class*="employer" i]');
  const location = textForSelector('[data-testid*="location" i], [class*="location" i], [aria-label*="location" i]');
  const anchors = [...document.querySelectorAll('a[href]')];
  const jobLinks = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const url = absoluteUrl(anchor.href || anchor.getAttribute('href'));
    if (!url || seen.has(url)) continue;
    let pathName = '';
    try { pathName = new URL(url).pathname; } catch { continue; }
    if (!/\\/(?:emp\\/)?(?:jobs?|job-search|opportunities?|projects?)(?:\\/|$)/i.test(pathName)
      && !/\\/talent\\/(?:jobs?|opportunities?)(?:\\/|$)/i.test(pathName)) continue;
    const card = anchor.closest('article, li, [role="article"], [data-testid*="card" i], [class*="card" i]');
    const anchorText = textOf(anchor) || clean(anchor.getAttribute('aria-label'));
    const cardText = textOf(card || anchor) || anchorText;
    jobLinks.push({ url, title: anchorText, ariaLabel: clean(anchor.getAttribute('aria-label')), cardText });
    seen.add(url);
  }
  const cards = [...document.querySelectorAll('article, [role="article"], [data-testid*="job" i], [data-testid*="opportunity" i], [class*="job-card" i], [class*="opportunity-card" i]')]
    .map((card) => ({ text: textOf(card), link: absoluteUrl(card.querySelector('a[href]')?.href) }))
    .filter((card) => card.link && card.text && !jobLinks.some((link) => link.url === card.link))
    .filter((card) => /\\b(?:apply|project|role|job|opportunity|client|contract)\\b/i.test(card.text));
  for (const card of cards) {
    jobLinks.push({ url: card.link, title: '', ariaLabel: '', cardText: card.text });
  }
  const metadata = bodyText.match(/(?:\\$|€|£)\\s?[\\d,.]+(?:\\s*[kK])?(?:\\s*(?:-|to)\\s*(?:\\$|€|£)?\\s?[\\d,.]+(?:\\s*[kK])?)?(?:\\s*\\/(?:hr|hour|year|yr|project))?/i)?.[0] || '';
  const jobType = bodyText.match(/\\b(?:full[- ]?time|part[- ]?time|contract|freelance|temporary|internship|project[- ]based)\\b/i)?.[0] || '';
  const commitment = bodyText.match(/\\b(?:less than 10|10-20|20-30|30-40|40\\+|full[- ]?time|part[- ]?time)\\s*(?:hours?|hrs?)(?: per week)?\\b/i)?.[0] || '';
  return {
    url: location.href,
    pageTitle: clean(document.title),
    title: textOf(heading),
    company,
    location,
    description: bodyText,
    bodyText,
    compensation: metadata,
    jobType,
    commitment,
    applyAvailable: Boolean(applyControl),
    applyLabel: textOf(applyControl),
    hasLoginControl: Boolean(loginControl),
    hasAuthenticatedNav,
    jobLinks,
  };
})()`;

/** @param {string[]} args */
function parseArgs(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) continue;
    const equals = value.indexOf('=');
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else flags.set(name, true);
  }
  return flags;
}

/** @param {Map<string, string|boolean>} flags @param {string} name @param {string} fallback */
function flagValue(flags, name, fallback = '') {
  const value = flags.get(name);
  return value === undefined || value === true ? fallback : String(value);
}

/** @param {Map<string, string|boolean>} flags @param {string} name */
function booleanFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined || value === true) return value === true;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** @param {Map<string, string|boolean>} flags */
function limitValue(flags) {
  const value = Number(flagValue(flags, 'limit', String(DEFAULT_DISCOVERY_LIMIT)));
  return Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Math.floor(value)))
    : DEFAULT_DISCOVERY_LIMIT;
}

/** @param {Map<string, string|boolean>} flags */
function timeoutMs(flags) {
  const value = Number(flagValue(flags, 'timeout', String(DEFAULT_TIMEOUT_SECONDS)));
  const seconds = Number.isFinite(value) && value > 0 ? Math.min(300, Math.floor(value)) : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1_000;
}

/** @param {unknown} value */
function redactError(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

/** @param {string} text */
export function parseOpenCliOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (/^Waited\b/i.test(trimmed)) return { message: trimmed };
  const candidates = [trimmed, ...trimmed.split('\n').map((line) => line.trim()).filter(Boolean).reverse()];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next JSON envelope */ }
  }
  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    try { return JSON.parse(trimmed.slice(firstObject, lastObject + 1)); } catch { /* report below */ }
  }
  throw new Error('OpenCLI browser command did not return JSON');
}

/** @param {unknown} value */
function unwrapEnvelope(value) {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    if (typeof current === 'string') {
      try { current = JSON.parse(current); continue; } catch { return current; }
    }
    if (!current || typeof current !== 'object') return current;
    const record = /** @type {Record<string, unknown>} */ (current);
    const next = ['result', 'data', 'value', 'output'].find((key) => Object.hasOwn(record, key));
    if (!next) return current;
    current = record[next];
  }
  return current;
}

/** @param {unknown} value */
function objectValues(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of ['tabs', 'targets', 'pages', 'items', 'data', 'result']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

/** @param {unknown} value */
export function normalizeTabRecords(value) {
  return objectValues(unwrapEnvelope(value)).map((row) => {
    if (!row || typeof row !== 'object') return null;
    const record = /** @type {Record<string, unknown>} */ (row);
    const id = normalizeText(record.id || record.targetId || record.tabId || record.pageId || record.page);
    const url = normalizeText(record.url || record.href || record.location);
    if (!id || !url) return null;
    return { id, url, title: normalizeText(record.title || record.name) };
  }).filter(Boolean);
}

/** @param {string} session @param {string[]} args @param {number} timeout */
async function runBrowser(session, args, timeout) {
  const executable = process.env.OPENCLI_BIN || 'opencli';
  try {
    const result = await execFileAsync(executable, ['browser', session, ...args], {
      cwd: ROOT,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseOpenCliOutput(result.stdout);
  } catch (error) {
    const typed = /** @type {Error & { stdout?: string, stderr?: string, code?: string }} */ (error);
    const detail = redactError(typed.stderr || typed.stdout || typed.message || String(error));
    const wrapped = new Error(`OpenCLI browser bridge failed: ${detail}`, { cause: error });
    // @ts-ignore — machine-readable boundary for callers and tests.
    wrapped.code = /daemon|extension|connect|bridge|target|session/i.test(detail)
      ? 'bridge-unavailable'
      : 'bridge-error';
    throw wrapped;
  }
}

/** @param {Record<string, unknown>} data */
export function pageLooksAuthenticated(data) {
  if (data.hasLoginControl === true && data.hasAuthenticatedNav !== true) return false;
  return data.hasAuthenticatedNav === true;
}

/** @param {string} source @param {unknown} value @param {number} limit */
export function collectMarketplaceCandidates(source, value, limit = DEFAULT_DISCOVERY_LIMIT) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const candidates = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    const sourceUrl = normalizeText(record.url || record.sourceUrl);
    const canonicalUrl = canonicalMarketplaceUrl(source, sourceUrl);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    candidates.push({
      url: canonicalUrl,
      sourceUrl,
      title: normalizeText(record.title),
      ariaLabel: normalizeText(record.ariaLabel),
      cardText: normalizeText(record.cardText || record.text),
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/** @param {string} source @param {string} tabUrl @param {Record<string, any>} data @param {string} observedAt */
function recordsFromPage(source, tabUrl, data, observedAt) {
  const detailUrl = canonicalMarketplaceUrl(source, data.url || tabUrl);
  if (detailUrl) {
    return normalizeMarketplaceJobs([{
      ...data,
      url: data.url || tabUrl,
      canonicalUrl: detailUrl,
      sourceUrl: data.url || tabUrl,
      description: data.description || data.bodyText,
      observedAt,
      authenticated: data.authenticated === true,
    }], { source, observedAt, authenticated: data.authenticated === true });
  }
  const links = Array.isArray(data.jobLinks) ? data.jobLinks.slice(0, 100) : [];
  return normalizeMarketplaceJobs(links.map((link) => ({
    ...link,
    url: link.url,
    sourceUrl: link.url,
    description: link.cardText || '',
    observedAt,
    authenticated: data.authenticated === true,
  })), { source, observedAt, authenticated: data.authenticated === true });
}

/** @param {string} source @param {string} tabId @param {string} tabUrl @param {string} session @param {number} timeout */
async function readTab(source, tabId, tabUrl, session, timeout) {
  const raw = await runBrowser(session, ['eval', '--tab', tabId, READ_MARKETPLACE_SCRIPT], timeout);
  const value = unwrapEnvelope(raw);
  if (!value || typeof value !== 'object') throw new Error(`Marketplace tab ${tabUrl} returned no DOM record`);
  const data = /** @type {Record<string, any>} */ (value);
  const pageUrl = normalizeText(data.url || tabUrl);
  if (!isMarketplaceHost(source, pageUrl)) throw new Error(`tab moved outside ${source}: ${pageUrl || 'unknown URL'}`);
  return { ...data, url: pageUrl, authenticated: pageLooksAuthenticated(data) };
}

/** @param {string} session @param {string} tabId @param {string} url @param {number} timeout */
async function navigateDetailTab(session, tabId, url, timeout) {
  await runBrowser(session, ['open', '--tab', tabId, url], timeout);
  await runBrowser(session, ['wait', '--tab', tabId, 'time', String(DETAIL_WAIT_SECONDS)], timeout);
}

/** @param {string} source @param {Map<string, string|boolean>} flags */
async function syncGeneric(source, flags) {
  const config = getMarketplaceSource(source);
  const session = flagValue(flags, 'session', config.session);
  const cacheFile = flagValue(flags, 'cache-file', path.join(ROOT, config.cacheFile));
  const statusFile = flagValue(flags, 'status-file', path.join(ROOT, config.statusFile));
  const observedAt = new Date().toISOString();
  const write = booleanFlag(flags, 'write');
  const limit = limitValue(flags);
  const preserve = { cachePreserved: existsSync(cacheFile), readOnly: true };
  const actions = { inspectVisibleContent: true, apply: false, save: false, message: false, submit: false };
  const writeStatus = (result) => { if (write) writeJson(statusFile, result); return result; };
  try {
    const tabs = normalizeTabRecords(await runBrowser(session, ['tab', 'list'], timeoutMs(flags)));
    const sourceTabs = tabs.filter((tab) => isMarketplaceHost(source, tab.url));
    if (!sourceTabs.length) {
      return writeStatus({
        ok: false,
        source,
        sourceLabel: config.sourceLabel,
        command: 'sync',
        session,
        observedAt,
        outcome: `no-${source}-tab`,
        error: `No open ${config.sourceLabel} tab was found in the connected Chrome session.`,
        ...preserve,
        next: `Open ${config.sourceLabel} in an authenticated Chrome tab, then rerun node marketplace.mjs sync --source ${source} --write.`,
      });
    }

    const feedRecords = [];
    const detailRecords = [];
    const feedLinks = [];
    const warnings = [];
    let authenticated = false;
    let sourceTab = null;
    for (const tab of sourceTabs) {
      try {
        const page = await readTab(source, tab.id, tab.url, session, timeoutMs(flags));
        authenticated ||= page.authenticated === true;
        if (page.authenticated !== true) {
          warnings.push(`${tab.url}: page did not expose authenticated account navigation`);
          continue;
        }
        if (canonicalMarketplaceUrl(source, tab.url)) {
          detailRecords.push(...recordsFromPage(source, tab.url, page, observedAt));
        } else {
          sourceTab ||= tab;
          feedRecords.push(...recordsFromPage(source, tab.url, page, observedAt));
          if (Array.isArray(page.jobLinks)) feedLinks.push(...page.jobLinks);
        }
      } catch (error) {
        warnings.push(`${tab.url}: ${redactError(error instanceof Error ? error.message : String(error))}`);
      }
    }

    const candidates = collectMarketplaceCandidates(source, feedLinks, limit);
    const discovery = {
      mode: 'bounded-detail-pages',
      limit,
      candidates: candidates.length,
      attempted: 0,
      verified: 0,
      incomplete: 0,
      failed: 0,
      blocked: false,
      tabStrategy: 'reuse-bound-source-tab',
      sourceTabRestored: false,
    };
    const detailedCanonicalUrls = new Set();
    const detailTabId = sourceTab?.id || '';
    const sourceTabUrl = sourceTab?.url || '';
    try {
      if (candidates.length && !detailTabId) {
        discovery.blocked = true;
        discovery.incomplete = candidates.length;
        warnings.push('Detail discovery found candidates but no authenticated non-detail source tab was available to reuse.');
      } else {
        for (const candidate of candidates) {
          discovery.attempted += 1;
          try {
            await navigateDetailTab(session, detailTabId, candidate.url, timeoutMs(flags));
            const page = await readTab(source, detailTabId, candidate.url, session, timeoutMs(flags));
            authenticated ||= page.authenticated === true;
            if (page.authenticated !== true) throw new Error('detail page did not expose authenticated account navigation');
            const jobs = recordsFromPage(source, candidate.url, page, observedAt);
            if (!jobs.length) throw new Error('detail page returned no normalized opportunity record');
            detailRecords.push(...jobs);
            for (const job of jobs) detailedCanonicalUrls.add(job.canonicalUrl);
            if (jobs.some((job) => job.liveness === 'active')) discovery.verified += 1;
            else discovery.incomplete += 1;
          } catch (error) {
            discovery.failed += 1;
            warnings.push(`${candidate.url}: detail discovery failed: ${redactError(error instanceof Error ? error.message : String(error))}`);
          }
        }
      }
    } finally {
      if (detailTabId && sourceTabUrl) {
        try {
          await navigateDetailTab(session, detailTabId, sourceTabUrl, timeoutMs(flags));
          discovery.sourceTabRestored = true;
        } catch (error) {
          warnings.push(`source tab ${detailTabId}: restore failed: ${redactError(error instanceof Error ? error.message : String(error))}`);
        }
      }
    }

    const candidateUrls = new Set(candidates.map((candidate) => candidate.url));
    const fallbackRecords = feedRecords.filter((job) => candidateUrls.has(job.canonicalUrl) && !detailedCanonicalUrls.has(job.canonicalUrl));
    const jobs = normalizeMarketplaceJobs([...detailRecords, ...fallbackRecords], { source, observedAt, authenticated }).slice(0, limit);
    const result = {
      ok: true,
      source,
      sourceLabel: config.sourceLabel,
      command: 'sync',
      session,
      transport: 'opencli-browser-bridge',
      authenticated,
      observedAt,
      tabs: sourceTabs,
      records: jobs,
      discovery,
      warnings,
      actions,
      ...(jobs.length === 0 && existsSync(cacheFile) ? { cachePreserved: true } : {}),
    };
    if (write) {
      if (jobs.length > 0 || !existsSync(cacheFile) || booleanFlag(flags, 'replace-empty')) {
        writeJson(cacheFile, {
          schemaVersion: 1,
          source,
          sourceLabel: config.sourceLabel,
          transport: 'opencli-browser-bridge',
          session,
          authenticated,
          observedAt,
          jobs,
          policy: actions,
        });
      }
      writeJson(statusFile, result);
    }
    return result;
  } catch (error) {
    return writeStatus({
      ok: false,
      source,
      sourceLabel: config.sourceLabel,
      command: 'sync',
      session,
      observedAt,
      outcome: error?.code || 'bridge-error',
      error: redactError(error instanceof Error ? error.message : String(error)),
      ...preserve,
      actions,
      next: `Start the OpenCLI daemon and connect its browser bridge, then rerun node marketplace.mjs sync --source ${source} --write.`,
    });
  }
}

/** @param {string} source @param {Map<string, string|boolean>} flags */
async function syncSource(source, flags) {
  if (source === 'handshake') {
    const config = getMarketplaceSource(source);
    const args = ['sync', '--session', flagValue(flags, 'session', config.session), '--cache-file', flagValue(flags, 'cache-file', path.join(ROOT, config.cacheFile)), '--status-file', flagValue(flags, 'status-file', path.join(ROOT, config.statusFile)), '--limit', String(limitValue(flags)), '--timeout', String(Math.ceil(timeoutMs(flags) / 1_000))];
    if (booleanFlag(flags, 'write')) args.push('--write');
    if (booleanFlag(flags, 'replace-empty')) args.push('--replace-empty');
    try {
      const result = await execFileAsync(process.execPath, [path.join(ROOT, 'handshake.mjs'), ...args], {
        cwd: ROOT,
        timeout: timeoutMs(flags) * 8,
        maxBuffer: 16 * 1024 * 1024,
      });
      return parseOpenCliOutput(result.stdout);
    } catch (error) {
      const typed = /** @type {Error & { stdout?: string, stderr?: string, code?: string }} */ (error);
      try {
        if (typed.stdout) return parseOpenCliOutput(typed.stdout);
      } catch { /* return a stable error result below */ }
      return {
        ok: false,
        source,
        sourceLabel: config.sourceLabel,
        command: 'sync',
        session: flagValue(flags, 'session', config.session),
        observedAt: new Date().toISOString(),
        outcome: typed.code || 'bridge-error',
        error: redactError(typed.stderr || typed.message || String(error)),
        cachePreserved: existsSync(flagValue(flags, 'cache-file', path.join(ROOT, config.cacheFile))),
        readOnly: true,
      };
    }
  }
  return syncGeneric(source, flags);
}

/** @param {string} source @param {Map<string, string|boolean>} flags */
async function doctorSource(source, flags) {
  const config = getMarketplaceSource(source);
  const session = flagValue(flags, 'session', config.session);
  const checkedAt = new Date().toISOString();
  try {
    const tabs = normalizeTabRecords(await runBrowser(session, ['tab', 'list'], timeoutMs(flags)));
    const sourceTabs = tabs.filter((tab) => isMarketplaceHost(source, tab.url));
    return { ok: true, source, sourceLabel: config.sourceLabel, session, checkedAt, bridge: 'connected', tabs: sourceTabs, readOnly: true };
  } catch (error) {
    return {
      ok: false,
      source,
      sourceLabel: config.sourceLabel,
      session,
      checkedAt,
      bridge: 'unavailable',
      outcome: error?.code || 'bridge-error',
      error: redactError(error instanceof Error ? error.message : String(error)),
      readOnly: true,
      next: 'Start the OpenCLI daemon and connect its browser-bridge extension, then rerun this doctor.',
    };
  }
}

/** @param {string} file @param {unknown} payload */
function writeJson(file, payload) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** @param {Map<string, string|boolean>} flags @param {'doctor'|'sync'} command */
async function runCommand(flags, command) {
  const requested = flagValue(flags, 'source', 'all');
  const sources = requested === 'all' ? [...AUTHENTICATED_MARKETPLACE_SOURCE_IDS] : [requested];
  for (const source of sources) getMarketplaceSource(source);
  const results = [];
  for (const source of sources) results.push(command === 'doctor' ? await doctorSource(source, flags) : await syncSource(source, flags));
  if (requested === 'all') return { ok: results.every((result) => result.ok), command, results };
  return results[0];
}

/** @param {string[]} args */
export async function main(args) {
  const command = args[0] || 'doctor';
  if (!['doctor', 'sync'].includes(command)) throw new Error('Usage: node marketplace.mjs doctor|sync --source <wellfound|contra|braintrust|handshake|all>');
  return runCommand(parseArgs(args.slice(1)), command);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result?.ok === false) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, command: process.argv[2] || 'doctor', outcome: 'command-error', error: redactError(error instanceof Error ? error.message : String(error)) }, null, 2));
    process.exitCode = 1;
  }
}
