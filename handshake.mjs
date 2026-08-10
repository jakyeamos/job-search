#!/usr/bin/env node
// @ts-check

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HANDSHAKE_SOURCE,
  HANDSHAKE_SOURCE_LABEL,
  isHandshakeUrl,
  normalizeHandshakeJobUrl,
  normalizeHandshakeJobs,
  normalizeText,
} from './handshake-lib.mjs';
import {
  HANDSHAKE_INBOX_SOURCE_LABEL,
  isHandshakeInboxUrl,
  normalizeHandshakeInboxThreads,
} from './handshake-inbox-lib.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SESSION = 'career-ops-handshake';
const DEFAULT_CACHE_FILE = path.join(ROOT, 'data', 'handshake-recommendations.json');
const DEFAULT_STATUS_FILE = path.join(ROOT, 'data', 'handshake-sync-status.json');
const DEFAULT_INBOX_CACHE_FILE = path.join(ROOT, 'data', 'handshake-inbox.json');
const DEFAULT_INBOX_STATUS_FILE = path.join(ROOT, 'data', 'handshake-inbox-sync-status.json');
const DEFAULT_TIMEOUT_SECONDS = 45;
const DEFAULT_DISCOVERY_LIMIT = 10;
const MAX_DISCOVERY_LIMIT = 20;
const DEFAULT_INBOX_LIMIT = 50;
const MAX_INBOX_LIMIT = 100;
const DETAIL_WAIT_SECONDS = 8;

const HANDSHAKE_HOST_RE = /(?:^|\.)joinhandshake\.com$/i;

export const READ_PAGE_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const textOf = (node) => clean(node && (node.innerText || node.textContent));
  const body = document.querySelector('main, [role="main"], article') || document.body;
  const bodyText = textOf(body);
  const anchors = [...document.querySelectorAll('a[href]')];
  const jobLinks = anchors.map((anchor) => {
    const href = anchor.href || '';
    const match = href.match(/https?:\\/\\/(?:app\\.)?joinhandshake\\.com\\/(?:emp\\/)?(?:jobs|job-search)\\/\\d+/i);
    if (!match) return null;
    const card = anchor.closest('article, li, [data-testid], [role="article"]');
    const ariaLabel = clean(anchor.getAttribute('aria-label'));
    return {
      url: match[0],
      title: textOf(anchor) || ariaLabel,
      ariaLabel,
      cardText: textOf(card || anchor) || ariaLabel,
    };
  }).filter(Boolean);
  const visibleControls = [...document.querySelectorAll('button, a, [role="button"]')];
  const applyControl = visibleControls.find((node) => /\\bapply(?: now)?\\b/i.test(textOf(node)));
  const loginControl = visibleControls.find((node) => /^(?:sign in|log in|login|create account)$/i.test(textOf(node)));
  const authenticatedNav = visibleControls.some((node) => /^(?:feed|profile|messages|my jobs|career center)$/i.test(textOf(node)));
  const companyNode = document.querySelector('a[href*="/e/"], a[href*="/employers/"], [data-testid*="company" i], [data-testid*="employer" i], [class*="company" i], [class*="employer" i]');
  const locationNode = document.querySelector('[data-testid*="location" i], [class*="location" i], [aria-label*="location" i]');
  const locationCandidate = [...document.querySelectorAll('div, span, p, li')]
    .map((node) => ({ node, text: textOf(node) }))
    .filter(({ text }) => text.length > 3 && text.length <= 180
      && (/^(?:onsite|on-site|remote|hybrid)\b/i.test(text) || /\bbased in\b/i.test(text)))
    .sort((left, right) => left.text.length - right.text.length)[0];
  const locationFromBody = bodyText.match(/\b(?:onsite|on-site|remote|hybrid),?\s+based in\s+.*?(?=\s+work in person|\s+job\s)/i)?.[0] || '';
  const descriptionHeading = [...document.querySelectorAll('h1, h2, h3, h4')]
    .find((node) => /^job description$/i.test(textOf(node)));
  let descriptionNode = null;
  let descriptionCursor = descriptionHeading;
  for (let index = 0; index < 4 && descriptionCursor; index += 1) {
    descriptionCursor = descriptionCursor.parentElement;
    if (!descriptionCursor) continue;
    const candidateText = textOf(descriptionCursor);
    if (descriptionCursor.querySelector('p, li, button[aria-label^="Show more"], button[aria-label^="Show less"]')
      && candidateText.length > 0) {
      descriptionNode = descriptionCursor;
      break;
    }
  }
  const description = textOf(descriptionNode || body).replace(/\s+(?:More|Less)$/i, '').trim();
  const heading = document.querySelector('h1') || document.querySelector('h2, [role="heading"]');
  return {
    url: location.href,
    pageTitle: clean(document.title),
    title: textOf(heading),
    company: textOf(companyNode) || clean(companyNode && companyNode.getAttribute('aria-label')),
    location: textOf(locationNode) || locationFromBody || (locationCandidate && locationCandidate.text) || '',
    description,
    bodyText,
    applyAvailable: Boolean(applyControl),
    applyLabel: textOf(applyControl),
    hasLoginControl: Boolean(loginControl),
    hasAuthenticatedNav: authenticatedNav,
    jobLinks,
  };
})()`;

export const READ_INBOX_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const textOf = (node) => clean(node && (node.innerText || node.textContent));
  const absoluteUrl = (value) => {
    try {
      const url = new URL(String(value || ''), location.origin);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  };
  const inboxId = (href) => href.match(/\\/inbox\\/(\\d+)/i)?.[1] || '';
  const anchors = [...document.querySelectorAll('a[href]')];
  const threadLinks = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#')) continue;
    const href = absoluteUrl(anchor.href);
    const conversationId = inboxId(href);
    if (!conversationId || seen.has(conversationId)) continue;
    seen.add(conversationId);
    const label = clean(anchor.getAttribute('aria-label'));
    const text = textOf(anchor);
    const heading = anchor.querySelector('h1, h2, h3, [role="heading"]');
    const dateNode = anchor.querySelector('p');
    const participantName = textOf(heading);
    const dateLabel = textOf(dateNode);
    const unreadNode = anchor.querySelector('[aria-label*="unread" i], [data-unread="true"], [data-testid*="unread" i]');
    const previewText = clean((text || label)
      .replace(participantName, '')
      .replace(dateLabel, '')
      .replace(/^Unread\\s*,?\\s*/i, ''));
    threadLinks.push({
      conversationId,
      threadUrl: href,
      participantName,
      dateLabel,
      previewText,
      unread: Boolean(unreadNode) || /\\bunread\\b/i.test(label),
      visibleOrder: threadLinks.length,
    });
  }

  const composer = [...document.querySelectorAll('[contenteditable="true"], textarea')]
    .find((node) => node.getAttribute('aria-label') === 'Message'
      || node.getAttribute('role') === 'textbox'
      || node.closest('.editor-wrapper'));
  let threadRoot = null;
  let cursor = composer;
  for (let depth = 0; depth < 14 && cursor; depth += 1, cursor = cursor.parentElement) {
    const candidateText = textOf(cursor);
    const hasProfile = Boolean(cursor.querySelector('a[href*="/profiles/"]'));
    const hasJobLink = Boolean(cursor.querySelector('a[href*="/jobs/"], a[href*="/emp/jobs/"]'));
    if (hasProfile && candidateText.length > 150 && (hasJobLink || /\\bSend\\b/i.test(candidateText))) {
      threadRoot = cursor;
      break;
    }
  }

  const selectedThread = threadRoot ? (() => {
    const headings = [...threadRoot.querySelectorAll('h1, h2, h3, [role="heading"]')]
      .map(textOf).filter(Boolean);
    const profile = threadRoot.querySelector('a[href*="/profiles/"]');
    const selectedUrl = absoluteUrl(location.href);
    const selectedId = inboxId(selectedUrl);
    const jobLinks = [...threadRoot.querySelectorAll('a[href*="/jobs/"], a[href*="/emp/jobs/"]')]
      .map((anchor) => ({ url: absoluteUrl(anchor.href), title: textOf(anchor) }))
      .filter((link) => link.url);
    return {
      conversationId: selectedId,
      threadUrl: selectedId ? selectedUrl : '',
      participantName: headings[0] || textOf(profile),
      company: headings[1] || '',
      threadText: candidateTextFor(threadRoot),
      jobLinks,
      selected: true,
    };
  })() : null;

  function candidateTextFor(node) {
    return clean(node && (node.innerText || node.textContent)).slice(0, 30000);
  }

  const controls = [...document.querySelectorAll('button, a, [role="button"]')];
  const loginControl = controls.find((node) => /^(?:sign in|log in|login|create account)$/i.test(textOf(node)));
  const navText = [...document.querySelectorAll('nav')].map(textOf).join(' ');
  const hasAuthenticatedNav = !loginControl && /\\bInbox\\b/i.test(navText) && /\\bFeed\\b/i.test(navText);
  const inboxHeading = [...document.querySelectorAll('h1, h2, [role="heading"]')].some((node) => /^Inbox$/i.test(textOf(node)));
  const inboxNav = anchors.find((anchor) => /\\/inbox(?:\\?|$)/i.test(anchor.getAttribute('href') || '') && /unread/i.test(anchor.getAttribute('aria-label') || ''));
  const unreadFromNav = clean(inboxNav && (inboxNav.getAttribute('aria-label') || inboxNav.innerText)).match(/(\\d+)\\s+unread/i)?.[1];
  const selectedFilter = document.querySelector('[role="tab"][aria-selected="true"]');
  return {
    url: location.href,
    pageTitle: clean(document.title),
    inboxHeading,
    hasLoginControl: Boolean(loginControl),
    hasAuthenticatedNav,
    filter: textOf(selectedFilter),
    unreadCount: unreadFromNav ? Number(unreadFromNav) : threadLinks.filter((thread) => thread.unread).length,
    threads: threadLinks,
    selectedThread,
  };
})()`;

/** @param {string[]} args */
function parseArgs(args) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
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
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positionals };
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
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_DISCOVERY_LIMIT, Math.floor(value))) : DEFAULT_DISCOVERY_LIMIT;
}

/** @param {Map<string, string|boolean>} flags */
function inboxLimitValue(flags) {
  const value = Number(flagValue(flags, 'limit', String(DEFAULT_INBOX_LIMIT)));
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_INBOX_LIMIT, Math.floor(value))) : DEFAULT_INBOX_LIMIT;
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
    try { return JSON.parse(candidate); } catch { /* try a later JSON envelope */ }
  }
  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    try { return JSON.parse(trimmed.slice(firstObject, lastObject + 1)); } catch { /* report a bridge parse error */ }
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
  const rows = objectValues(unwrapEnvelope(value));
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return null;
    const record = /** @type {Record<string, unknown>} */ (row);
    const id = normalizeText(record.id || record.targetId || record.tabId || record.pageId || record.page);
    const url = normalizeText(record.url || record.href || record.location);
    if (!id || !url) return null;
    return {
      id,
      url,
      title: normalizeText(record.title || record.name),
    };
  }).filter(Boolean);
}

/** @param {unknown} value */
export function normalizeCreatedTab(value) {
  const raw = unwrapEnvelope(value);
  if (typeof raw === 'string') return normalizeText(raw);
  if (!raw || typeof raw !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (raw);
  return normalizeText(record.page || record.id || record.targetId || record.tabId || record.pageId);
}

/** @param {unknown} value @param {number} limit */
export function collectHandshakeCandidates(value, limit = DEFAULT_DISCOVERY_LIMIT) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const candidates = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    const sourceUrl = normalizeText(record.url || record.sourceUrl);
    const canonicalUrl = normalizeHandshakeJobUrl(sourceUrl);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    candidates.push({
      url: canonicalUrl,
      sourceUrl,
      title: normalizeText(record.title),
      cardText: normalizeText(record.cardText),
      ariaLabel: normalizeText(record.ariaLabel),
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
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
    const typed = /** @type {Error & { stdout?: string, stderr?: string }} */ (error);
    const detail = redactError(typed.stderr || typed.stdout || typed.message || String(error));
    const wrapped = new Error(`OpenCLI browser bridge failed: ${detail}`, { cause: error });
    // @ts-ignore — a small machine-readable boundary for callers and tests.
    wrapped.code = /daemon|extension|connect|bridge|target|session/i.test(detail)
      ? 'bridge-unavailable'
      : 'bridge-error';
    throw wrapped;
  }
}

/** @param {string} url */
function isHandshakePage(url) {
  try { return HANDSHAKE_HOST_RE.test(new URL(url).hostname); } catch { return false; }
}

/** @param {Record<string, unknown>} data */
function pageLooksAuthenticated(data) {
  if (data.hasLoginControl === true && data.hasAuthenticatedNav !== true) return false;
  return data.hasAuthenticatedNav === true || data.applyAvailable === true || Boolean(data.jobLinks?.length);
}

/** @param {Record<string, any>} data */
function pageLooksAuthenticatedInbox(data) {
  if (data.hasLoginControl === true && data.hasAuthenticatedNav !== true) return false;
  return data.inboxHeading === true && data.hasAuthenticatedNav === true;
}

/** @param {unknown} value */
function inferHandshakeLocation(value) {
  const text = normalizeText(value);
  return text.match(/\b(?:onsite|on-site|remote|hybrid),?\s+based in\s+.*?(?=\s+work in person|\s+job\s)/i)?.[0]
    || text.match(/\b(?:onsite|on-site|remote|hybrid)\b/i)?.[0]
    || '';
}

/** @param {string} tabId @param {string} tabUrl @param {string} session @param {number} timeout */
async function readTab(tabId, tabUrl, session, timeout) {
  const raw = await runBrowser(session, ['eval', '--tab', tabId, READ_PAGE_SCRIPT], timeout);
  const value = unwrapEnvelope(raw);
  if (!value || typeof value !== 'object') throw new Error(`Handshake tab ${tabId} returned no DOM record`);
  const data = /** @type {Record<string, any>} */ (value);
  return {
    ...data,
    url: data.url || tabUrl,
    location: normalizeText(data.location || data.workplace || inferHandshakeLocation(data.bodyText || data.description)),
    authenticated: pageLooksAuthenticated(data),
  };
}

/** @param {string} tabId @param {string} tabUrl @param {string} session @param {number} timeout */
async function readInboxTab(tabId, tabUrl, session, timeout) {
  const raw = await runBrowser(session, ['eval', '--tab', tabId, READ_INBOX_SCRIPT], timeout);
  const value = unwrapEnvelope(raw);
  if (!value || typeof value !== 'object') throw new Error(`Handshake inbox tab ${tabId} returned no DOM record`);
  const data = /** @type {Record<string, any>} */ (value);
  const url = data.url || tabUrl;
  if (!isHandshakeInboxUrl(url)) {
    throw new Error(`Handshake inbox tab ${tabId} returned an unexpected URL (${url || 'unknown URL'})`);
  }
  return {
    ...data,
    url,
    authenticated: pageLooksAuthenticatedInbox(data),
  };
}

/** @param {string} session @param {string} tabId @param {string} url @param {number} timeout */
async function navigateDetailTab(session, tabId, url, timeout) {
  await runBrowser(session, ['open', '--tab', tabId, url], timeout);
  await runBrowser(session, ['wait', '--tab', tabId, 'time', String(DETAIL_WAIT_SECONDS)], timeout);
}

/** @param {string} session @param {string} tabId @param {number} timeout */
export async function readVisibleApplyControl(session, tabId, timeout) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await runBrowser(session, [
      'find', '--tab', tabId, '--text', 'Apply',
    ], timeout);
    const value = unwrapEnvelope(raw);
    if (value && typeof value === 'object') {
      const entries = Array.isArray(value.entries) ? value.entries : [];
      const match = entries.find((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const record = /** @type {Record<string, any>} */ (entry);
        const label = normalizeText(record.attrs?.['aria-label'] || record.ariaLabel || record.text);
        return record.visible !== false
          && (record.role === 'button' || String(record.tag || '').toLowerCase() === 'button')
          && /\bapply\b/i.test(label);
      });
      if (match && typeof match === 'object') {
        const record = /** @type {Record<string, any>} */ (match);
        return { label: normalizeText(record.attrs?.['aria-label'] || record.ariaLabel || record.text) };
      }
    }
    if (attempt === 0) await runBrowser(session, ['wait', '--tab', tabId, 'time', '3'], timeout);
  }
  return null;
}

/** @param {string} session @param {string} tabId @param {Record<string, any>} page @param {number} timeout */
async function expandDescription(session, tabId, page, timeout) {
  const title = normalizeText(page.title).toLowerCase();
  const company = normalizeText(page.company).toLowerCase();
  if (!title || !company) return false;
  const raw = await runBrowser(session, [
    'find', '--tab', tabId, '--css', 'button[aria-label^="Show more"]',
  ], timeout);
  const value = unwrapEnvelope(raw);
  if (!value || typeof value !== 'object') return false;
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const match = entries.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = /** @type {Record<string, any>} */ (entry);
    const label = normalizeText(record.attrs?.['aria-label'] || record.ariaLabel).toLowerCase();
    return label.includes(title) && label.includes(company);
  });
  if (!match || typeof match !== 'object') return false;
  const ref = normalizeText(match.ref);
  if (!ref) return false;
  await runBrowser(session, ['click', '--tab', tabId, ref], timeout);
  await runBrowser(session, ['wait', '--tab', tabId, 'time', '1'], timeout);
  return true;
}

/** @param {string} tabId @param {string} requestedUrl @param {string} session @param {number} timeout */
async function readDetailTab(tabId, requestedUrl, session, timeout) {
  let page = await readTab(tabId, requestedUrl, session, timeout);
  if (page.applyAvailable !== true) {
    try {
      await runBrowser(session, ['wait', '--tab', tabId, 'time', '3'], timeout);
      page = await readTab(tabId, requestedUrl, session, timeout);
    } catch {
      // Keep the first rendered state if the optional readiness retry fails.
    }
  }
  let descriptionExpanded = false;
  try {
    descriptionExpanded = await expandDescription(session, tabId, page, timeout);
  } catch {
    // Expansion is optional; the detail record stays bound to the visible excerpt.
  }
  if (descriptionExpanded) page = await readTab(tabId, requestedUrl, session, timeout);
  let visibleApplyControl = null;
  try {
    visibleApplyControl = await readVisibleApplyControl(session, tabId, timeout);
    if (visibleApplyControl) {
      page = {
        ...page,
        applyAvailable: true,
        applyLabel: page.applyLabel || visibleApplyControl.label,
      };
    }
  } catch {
    // The DOM snapshot remains the primary read; the structured control check is additive.
  }
  return {
    ...page,
    descriptionExpanded,
    visibleApplyControlFound: Boolean(visibleApplyControl),
    visibleApplyControlLabel: visibleApplyControl?.label || '',
  };
}

/** @param {Record<string, any>} data @param {string} requestedUrl @param {string} observedAt */
function recordFromDetailPage(data, requestedUrl, observedAt) {
  const currentUrl = normalizeText(data.url || requestedUrl);
  if (!isHandshakeUrl(currentUrl)) {
    throw new Error(`detail navigation did not remain on a Handshake job page (${currentUrl || 'unknown URL'})`);
  }
  return normalizeHandshakeJobs([{
    ...data,
    url: currentUrl,
    sourceUrl: currentUrl,
    observedAt,
    authenticated: data.authenticated === true,
  }], { observedAt, authenticated: data.authenticated === true });
}

/** @param {Record<string, any>} data @param {string} tabUrl @param {string} observedAt */
function recordsFromPage(data, tabUrl, observedAt) {
  if (isHandshakeUrl(tabUrl)) {
    return normalizeHandshakeJobs([{
      ...data,
      url: tabUrl,
      description: data.description || data.bodyText,
      sourceUrl: tabUrl,
      observedAt,
      authenticated: data.authenticated === true,
    }], { observedAt, authenticated: data.authenticated === true });
  }
  const links = Array.isArray(data.jobLinks) ? data.jobLinks.slice(0, 50) : [];
  return normalizeHandshakeJobs(links.map((link) => ({
    ...link,
    url: link.url,
    description: '',
    observedAt,
    authenticated: data.authenticated === true,
  })), { observedAt, authenticated: data.authenticated === true });
}

/** @param {string} file @param {Record<string, unknown>} payload */
function writeJson(file, payload) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** @param {Map<string, string|boolean>} flags */
async function doctor(flags) {
  const session = flagValue(flags, 'session', DEFAULT_SESSION);
  const checkedAt = new Date().toISOString();
  try {
    const tabs = normalizeTabRecords(await runBrowser(session, ['tab', 'list'], timeoutMs(flags)));
    const handshakeTabs = tabs.filter((tab) => isHandshakePage(tab.url));
    const inboxTabs = handshakeTabs.filter((tab) => isHandshakeInboxUrl(tab.url));
    return {
      ok: true,
      source: HANDSHAKE_SOURCE,
      session,
      checkedAt,
      bridge: 'connected',
      handshakeTabs: handshakeTabs.length,
      inboxTabs: inboxTabs.length,
      tabs: handshakeTabs,
    };
  } catch (error) {
    return {
      ok: false,
      source: HANDSHAKE_SOURCE,
      session,
      checkedAt,
      bridge: 'unavailable',
      outcome: error?.code || 'bridge-error',
      error: redactError(error instanceof Error ? error.message : String(error)),
      next: 'Start the OpenCLI daemon and connect its browser-bridge extension, then rerun this doctor.',
    };
  }
}

/** @param {Map<string, string|boolean>} flags */
async function sync(flags) {
  const session = flagValue(flags, 'session', DEFAULT_SESSION);
  const cacheFile = flagValue(flags, 'cache-file', DEFAULT_CACHE_FILE);
  const statusFile = flagValue(flags, 'status-file', DEFAULT_STATUS_FILE);
  const observedAt = new Date().toISOString();
  const write = booleanFlag(flags, 'write');
  const limit = limitValue(flags);
  try {
    const tabs = normalizeTabRecords(await runBrowser(session, ['tab', 'list'], timeoutMs(flags)));
    const allHandshakeTabs = tabs.filter((tab) => isHandshakePage(tab.url));
    const handshakeTabs = allHandshakeTabs.filter((tab) => !isHandshakeInboxUrl(tab.url));
    if (!allHandshakeTabs.length) {
      const result = {
        ok: false,
        source: HANDSHAKE_SOURCE,
        sourceLabel: HANDSHAKE_SOURCE_LABEL,
        command: 'sync',
        session,
        observedAt,
        outcome: 'no-handshake-tab',
        error: 'No open Handshake tab was found in the connected Chrome session.',
        cachePreserved: existsSync(cacheFile),
      };
      if (write) writeJson(statusFile, result);
      return result;
    }
    if (!handshakeTabs.length) {
      const result = {
        ok: false,
        source: HANDSHAKE_SOURCE,
        sourceLabel: HANDSHAKE_SOURCE_LABEL,
        command: 'sync',
        session,
        observedAt,
        outcome: 'no-handshake-job-tab',
        error: 'Only Handshake inbox tabs were found; use node handshake.mjs inbox --write for inbox evidence.',
        cachePreserved: existsSync(cacheFile),
      };
      if (write) writeJson(statusFile, result);
      return result;
    }

    const detailRecords = [];
    const feedRecords = [];
    const feedLinks = [];
    const warnings = [];
    let authenticated = false;
    let sourceTab = null;
    for (const tab of handshakeTabs) {
      try {
        const page = isHandshakeUrl(tab.url)
          ? await readDetailTab(tab.id, tab.url, session, timeoutMs(flags))
          : await readTab(tab.id, tab.url, session, timeoutMs(flags));
        authenticated ||= page.authenticated === true;
        if (page.authenticated !== true) {
          warnings.push(`${tab.url}: page did not expose an authenticated Handshake surface`);
          continue;
        }
        if (isHandshakeUrl(tab.url)) {
          detailRecords.push(...recordsFromPage(page, tab.url, observedAt));
        } else {
          sourceTab ||= tab;
          feedRecords.push(...recordsFromPage(page, tab.url, observedAt));
          if (Array.isArray(page.jobLinks)) feedLinks.push(...page.jobLinks);
        }
      } catch (error) {
        warnings.push(`${tab.url}: ${redactError(error instanceof Error ? error.message : String(error))}`);
      }
    }

    const candidates = collectHandshakeCandidates(feedLinks, limit);
    const discovery = {
      mode: 'bounded-detail-pages',
      limit,
      candidates: candidates.length,
      attempted: 0,
      verified: 0,
      incomplete: 0,
      failed: 0,
      blocked: false,
      descriptionExpanded: 0,
      applyControlDetected: 0,
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
        warnings.push('Detail discovery found candidates but no authenticated non-detail Handshake tab was available to reuse.');
      } else {
        for (const candidate of candidates) {
          discovery.attempted += 1;
          try {
            await navigateDetailTab(session, detailTabId, candidate.url, timeoutMs(flags));
            const page = await readDetailTab(detailTabId, candidate.url, session, timeoutMs(flags));
            authenticated ||= page.authenticated === true;
            if (page.visibleApplyControlFound === true) discovery.applyControlDetected += 1;
            if (page.authenticated !== true) {
              throw new Error('detail page did not expose an authenticated Handshake surface');
            }
            const jobs = recordFromDetailPage(page, candidate.url, observedAt);
            if (!jobs.length) throw new Error('detail page returned no normalized job record');
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
    const jobs = normalizeHandshakeJobs([...detailRecords, ...fallbackRecords], { observedAt, authenticated }).slice(0, limit);
    const result = {
      ok: true,
      source: HANDSHAKE_SOURCE,
      sourceLabel: HANDSHAKE_SOURCE_LABEL,
      command: 'sync',
      session,
      transport: 'opencli-browser-bridge',
      authenticated,
      observedAt,
      tabs: handshakeTabs,
      records: jobs,
      discovery,
      warnings,
      ...(jobs.length === 0 && existsSync(cacheFile) ? { cachePreserved: true } : {}),
    };
    if (write) {
      if (jobs.length > 0 || !existsSync(cacheFile) || booleanFlag(flags, 'replace-empty')) {
        writeJson(cacheFile, {
          schemaVersion: 1,
          source: HANDSHAKE_SOURCE,
          sourceLabel: HANDSHAKE_SOURCE_LABEL,
          transport: 'opencli-browser-bridge',
          session,
          authenticated,
          observedAt,
          jobs,
        });
      }
      writeJson(statusFile, result);
    }
    return result;
  } catch (error) {
    const result = {
      ok: false,
      source: HANDSHAKE_SOURCE,
      sourceLabel: HANDSHAKE_SOURCE_LABEL,
      command: 'sync',
      session,
      observedAt,
      outcome: error?.code || 'bridge-error',
      error: redactError(error instanceof Error ? error.message : String(error)),
      cachePreserved: existsSync(cacheFile),
      next: 'Start the OpenCLI daemon and connect its browser-bridge extension, then rerun node handshake.mjs sync --write.',
    };
    if (write) writeJson(statusFile, result);
    return result;
  }
}

/** @param {Map<string, string|boolean>} flags */
async function inbox(flags) {
  const session = flagValue(flags, 'session', DEFAULT_SESSION);
  const cacheFile = flagValue(flags, 'cache-file', DEFAULT_INBOX_CACHE_FILE);
  const statusFile = flagValue(flags, 'status-file', DEFAULT_INBOX_STATUS_FILE);
  const observedAt = new Date().toISOString();
  const write = booleanFlag(flags, 'write');
  const limit = inboxLimitValue(flags);
  try {
    const tabs = normalizeTabRecords(await runBrowser(session, ['tab', 'list'], timeoutMs(flags)));
    const inboxTabs = tabs.filter((tab) => isHandshakeInboxUrl(tab.url));
    if (!inboxTabs.length) {
      const result = {
        ok: false,
        source: HANDSHAKE_SOURCE,
        sourceLabel: HANDSHAKE_INBOX_SOURCE_LABEL,
        command: 'inbox',
        session,
        observedAt,
        outcome: 'no-inbox-tab',
        error: 'No open Handshake inbox tab was found in the connected Chrome session.',
        readOnly: true,
        cachePreserved: existsSync(cacheFile),
        next: 'Open Handshake Inbox in the authenticated Chrome session, then rerun node handshake.mjs inbox --write.',
      };
      if (write) writeJson(statusFile, result);
      return result;
    }

    const rawThreads = [];
    const warnings = [];
    let authenticated = false;
    let unreadCount = 0;
    const filters = [];
    for (const tab of inboxTabs) {
      try {
        const page = await readInboxTab(tab.id, tab.url, session, timeoutMs(flags));
        authenticated ||= page.authenticated === true;
        if (page.authenticated !== true) {
          warnings.push(`${tab.url}: page did not expose an authenticated Handshake inbox surface`);
          continue;
        }
        if (Number.isFinite(Number(page.unreadCount))) unreadCount = Math.max(unreadCount, Number(page.unreadCount));
        if (normalizeText(page.filter)) filters.push(normalizeText(page.filter));
        if (Array.isArray(page.threads)) rawThreads.push(...page.threads);
        if (page.selectedThread && typeof page.selectedThread === 'object') rawThreads.push(page.selectedThread);
      } catch (error) {
        warnings.push(`${tab.url}: ${redactError(error instanceof Error ? error.message : String(error))}`);
      }
    }

    if (!authenticated) {
      const result = {
        ok: false,
        source: HANDSHAKE_SOURCE,
        sourceLabel: HANDSHAKE_INBOX_SOURCE_LABEL,
        command: 'inbox',
        session,
        observedAt,
        outcome: 'unauthenticated-inbox',
        error: 'Handshake inbox tabs were present but did not expose authenticated navigation.',
        tabs: inboxTabs,
        warnings,
        readOnly: true,
        cachePreserved: existsSync(cacheFile),
      };
      if (write) writeJson(statusFile, result);
      return result;
    }

    const threads = normalizeHandshakeInboxThreads(rawThreads, { observedAt, authenticated })
      .slice(0, limit);
    const selectedThreads = threads.filter((thread) => thread.selected === true || Boolean(thread.threadText));
    const result = {
      ok: true,
      source: HANDSHAKE_SOURCE,
      sourceLabel: HANDSHAKE_INBOX_SOURCE_LABEL,
      sourceId: 'handshake-inbox',
      command: 'inbox',
      session,
      transport: 'opencli-browser-bridge',
      authenticated,
      observedAt,
      limit,
      unreadCount,
      threadCount: threads.length,
      filters: [...new Set(filters)],
      tabs: inboxTabs,
      threads,
      selectedThreads,
      warnings,
      readOnly: true,
      actions: {
        inspectVisibleContent: true,
        reply: false,
        markRead: false,
        archive: false,
        apply: false,
      },
      ...(threads.length === 0 && existsSync(cacheFile) ? { cachePreserved: true } : {}),
    };
    if (write) {
      if (threads.length > 0 || !existsSync(cacheFile) || booleanFlag(flags, 'replace-empty')) {
        writeJson(cacheFile, {
          schemaVersion: 1,
          source: HANDSHAKE_SOURCE,
          sourceLabel: HANDSHAKE_INBOX_SOURCE_LABEL,
          sourceId: 'handshake-inbox',
          transport: 'opencli-browser-bridge',
          session,
          authenticated,
          observedAt,
          unreadCount,
          threads,
          policy: result.actions,
        });
      }
      writeJson(statusFile, result);
    }
    return result;
  } catch (error) {
    const result = {
      ok: false,
      source: HANDSHAKE_SOURCE,
      sourceLabel: HANDSHAKE_INBOX_SOURCE_LABEL,
      command: 'inbox',
      session,
      observedAt,
      outcome: error?.code || 'bridge-error',
      error: redactError(error instanceof Error ? error.message : String(error)),
      readOnly: true,
      cachePreserved: existsSync(cacheFile),
      next: 'Start the OpenCLI daemon and connect its browser-bridge extension, then rerun node handshake.mjs inbox --write.',
    };
    if (write) writeJson(statusFile, result);
    return result;
  }
}

/** @param {string[]} args */
async function main(args) {
  const command = args[0] || 'doctor';
  const { flags } = parseArgs(args.slice(1));
  if (command === 'doctor') return doctor(flags);
  if (command === 'sync') return sync(flags);
  if (command === 'inbox') return inbox(flags);
  throw new Error(`Unknown Handshake command: ${command}. Use doctor, sync, or inbox.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result?.ok === false) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      source: HANDSHAKE_SOURCE,
      ok: false,
      outcome: 'command-error',
      error: redactError(error instanceof Error ? error.message : String(error)),
    }, null, 2));
    process.exitCode = 1;
  }
}
