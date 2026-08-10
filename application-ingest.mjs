#!/usr/bin/env node
// @ts-check

/**
 * Import post-application evidence into the local tracker.
 *
 * Gmail reads are deliberately separate from the job-alert ingest: a job alert
 * is discovery evidence, while an authenticated confirmation is application
 * evidence. Jack & Jill is consumed from a short-lived, read-only board
 * snapshot so the scheduled queue never has to inspect browser cookies or
 * perform an account action.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createGmailClient,
  GmailClientError,
  TARGET_GMAIL_ACCOUNT,
} from './gmail-client.mjs';
import {
  hasGmailCredentials,
  loadGmailSettings,
  senderDomain,
} from './gmail.mjs';
import {
  companyFromUrl,
  extractJobUrls,
  getMessageBody,
  isAuthenticEmail,
  parseRoleAtCompany,
} from './plugins/gmail/_helpers.mjs';
import { loadDotenvOnce } from './plugins/_engine.mjs';
import { setRowNotes, setRowStatus } from './tracker-board.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { roleFuzzyMatch, roleTokens } from './role-matcher.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Bump when parser semantics change so messages previously classified by the
// older parser are eligible for one corrective pass.
const PROCESSING_VERSION = 6;
const STATE_FILE = 'data/application-ingest-state.json';
const REVIEW_FILE = 'data/application-import-review.json';
const DEFAULT_DAYS_BACK = 90;
const DEFAULT_MAX_MESSAGES = 300;
const DEFAULT_BOARD_MAX_AGE_DAYS = 3;

export const APPLICATION_CONFIRMATION_QUERY =
  'in:anywhere newer_than:90d {subject:(application) subject:(applied) subject:(applying) subject:(submitted) subject:(submission) subject:(received)}';

const CONFIRMATION_SIGNAL_RE = /\b(?:application\s+(?:has\s+been\s+)?(?:received|submitted|confirmed|confirmation)|application\s+(?:was\s+)?sent(?:\s+to)?|application\s+received|application\s+submitted|(?:thank\s+you|thanks)\s+for\s+(?:your\s+)?application|(?:thank\s+you|thanks)\s+for\s+applying|we\s+(?:have\s+)?received\s+your\s+application|you\s+(?:have\s+)?applied|successfully\s+applied|successfully\s+submitted)\b/i;
const REJECTION_SIGNAL_RE = /\b(?:decided\s+not\s+to\s+move\s+forward|not\s+move\s+forward|regret\s+to\s+inform|won['’]?t\s+be\s+moving\s+forward|will\s+not\s+be\s+moving\s+forward|not\s+be\s+moving\s+forward|not\s+selected|no\s+longer\s+being\s+considered|candidacy\s+at\s+this\s+time|position\s+has\s+been\s+filled)\b/i;
const LINKEDIN_DOMAIN_RE = /(?:^|\.)linkedin\.com$/i;

const ROLE_LANGUAGE_RE = /\b(?:engineer|developer|scientist|analyst|architect|designer|manager|intern|researcher|consultant|specialist|technician|administrator|product|software|data|machine\s+learning|sde)\b/i;
const GENERIC_SENDER_NAMES = new Set([
  'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'icims',
  'workable', 'jobvite', 'linkedin', 'indeed', 'talent', 'careers',
  'airtable automations', 'airtableemail',
  'recruiting', 'notifications', 'no reply', 'noreply', 'do not reply',
]);

const STATUS_BY_BOARD_COLUMN = Object.freeze({
  Applied: 'Applied',
  'In Process': 'Applied',
  Offer: 'Offer',
  Rejected: 'Rejected',
  Discarded: 'Discarded',
});

const STATUS_RANK = Object.freeze({
  Evaluated: 0,
  Applied: 1,
  Responded: 2,
  Interview: 3,
  Offer: 4,
  Rejected: 4,
  Discarded: 4,
  SKIP: 5,
});

/** @param {unknown} value @returns {string} */
function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * LinkedIn can send application-shaped notifications from addresses such as
 * jobs-noreply@linkedin.com and newsletters-noreply@linkedin.com. DMARC can
 * authenticate those messages, but it cannot turn LinkedIn into the employer
 * or ATS. Keep this provenance check separate from the generic DMARC helper,
 * which is still useful for other Gmail classification tasks.
 *
 * @param {string} from
 * @returns {boolean}
 */
export function isLinkedInApplicationSender(from) {
  return LINKEDIN_DOMAIN_RE.test(senderDomain(from).replace(/\.$/, ''));
}

/** @param {unknown} value @returns {string} */
function cell(value) {
  return text(value).replace(/[|\t\r\n]/g, ' ');
}

/** @param {string} value @returns {string} */
function companyKey(value) {
  const suffixes = new Set(['incorporated', 'corporation', 'company', 'holdings', 'limited', 'llc', 'inc', 'corp', 'co', 'ai']);
  const tokens = text(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && suffixes.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('');
}

/** @param {string} value @returns {string} */
function roleKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** @param {string} value @returns {string} */
function stripHtml(value) {
  return String(value || '')
    .replace(/<\s*(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#39;/gi, "'")
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** @param {Array<{name?: string, value?: string}>} headers @param {string} name */
function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  return headers.find((header) => text(header.name).toLowerCase() === wanted)?.value || '';
}

/** @param {string} value @returns {string} */
function displayFromSlug(value) {
  return text(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** @param {string} from @returns {string} */
function companyFromSender(from) {
  const display = text(from).match(/^\s*["']?([^<"']+?)["']?\s*</)?.[1] || '';
  const displayClean = cell(display)
    .replace(/\b(?:team|jobs?|careers?|recruiting|talent|notifications?|alerts?|updates?|no\s*reply|do\s+not\s+reply)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (displayClean && !GENERIC_SENDER_NAMES.has(displayClean.toLowerCase())) return displayClean;

  const domain = senderDomain(from);
  const host = domain.split('.')[0] || '';
  if (!host || GENERIC_SENDER_NAMES.has(host.toLowerCase())) return '';
  return displayFromSlug(host);
}

/** @param {string} value @returns {string} */
function normalizeCompanyCandidate(value) {
  return cell(value)
    .replace(/^(?:the|at)\s+/i, '')
    .replace(/[\s.,;:!]+$/, '')
    .trim();
}

/** @param {string} value @returns {string} */
function normalizeRoleCandidate(value) {
  return cell(value)
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/^[\s:–—|-]+|[\s.,;:!]+$/g, '')
    .replace(/\s+(?:role|position|job)\s*$/i, '')
    .replace(/\s+(?:application|candidate)\s+(?:is|was|has).*$/i, '')
    .trim();
}

/** @param {string} role @returns {boolean} */
function looksLikeRole(role) {
  return role.length >= 3
    && role.length <= 120
    && ROLE_LANGUAGE_RE.test(role)
    && !/\b(?:thank\s+you|after\s+reviewing|your\s+application|has\s+decided|best\s+of\s+luck|candidacy)\b/i.test(role);
}

/** @param {string} company @returns {boolean} */
function looksLikeCompany(company) {
  const words = company.split(/\s+/).filter(Boolean);
  return company.length >= 2
    && company.length <= 80
    && words.length <= 8
    && !/^https?:/i.test(company)
    && !/\b(?:your\s+candidacy|at\s+this\s+time|after\s+reviewing|we\s+have|thank\s+you|best\s+of\s+luck|application|hiring\s+manager)\b/i.test(company);
}

/** @param {string} value @returns {{ role: string, company: string } | null} */
function parseRoleCompanyText(value) {
  const clean = text(value)
    .replace(/^(?:application|your application|position|role|job title)\s*[:\-–—|]\s*/i, '')
    .replace(/^application\s+(?:received|submitted|confirmation)\s*[:\-–—|]\s*/i, '')
    .trim();
  const roleSentencePatterns = [
    /\brole\s+of\s*[:\-–—]?\s*(.{3,120}?)\s+role\s+(?:here\s+)?(?:at|with)\s+([^.!?\r\n]{2,80})(?=[.!?]|$)/i,
    /\b(?:(?:thank\s+you|thanks)\s+for\s+)?apply(?:ing)?\s+(?:for|to)\s+(?:(?:the|our|a|an)\s+)?([A-Z][^.!?\r\n]{2,120}?)\s+role\s+(?:here\s+)?(?:at|with)\s+([^.!?\r\n]{2,80})(?=[.!?]|$)/i,
    /\b(?:for|to)\s+(?:(?:the|our|a|an)\s+)([A-Z][^.!?\r\n]{2,120}?)\s+role\s+(?:here\s+)?(?:at|with)\s+([^.!?\r\n]{2,80})(?=[.!?]|$)/i,
    /\binterest(?:ed)?\s+in\s+(?:(?:the|our|a|an)\s+)?([A-Z][^.!?\r\n]{2,120}?)\s+role\s+(?:here\s+)?(?:at|with)\s+([^.!?\r\n]{2,80})(?=[.!?]|$)/i,
  ];
  for (const pattern of roleSentencePatterns) {
    const roleSentence = clean.match(pattern);
    if (!roleSentence) continue;
    const role = normalizeRoleCandidate(roleSentence[1]);
    const company = normalizeCompanyCandidate(roleSentence[2]);
    if (looksLikeRole(role) && looksLikeCompany(company)) return { role, company };
  }
  const variants = [clean, clean.replace(/^(?:to|at|with|for)\s+/i, '')];
  for (const variant of variants) {
    const parsed = parseRoleAtCompany(variant);
    if (parsed && looksLikeRole(parsed.role)) {
      const role = normalizeRoleCandidate(parsed.role);
      const company = normalizeCompanyCandidate(parsed.company);
      if (looksLikeRole(role) && looksLikeCompany(company)) return { role, company };
    }
    const match = variant.match(/^(.{3,120}?)\s+(?:at|with)\s+(.{2,80})$/i);
    if (match) {
      const role = normalizeRoleCandidate(match[1]);
      const company = normalizeCompanyCandidate(match[2]);
      if (looksLikeRole(role) && looksLikeCompany(company)) return { role, company };
    }
    const dashed = variant.match(/^(.{3,120}?)\s+[-–—|]\s+(.{2,80})$/);
    if (dashed) {
      const role = normalizeRoleCandidate(dashed[1]);
      const company = normalizeCompanyCandidate(dashed[2]);
      if (looksLikeRole(role) && looksLikeCompany(company) && !/^apply(?:\s+now)?$/i.test(company)) return { role, company };
    }
  }
  return null;
}

/** @param {string} body @returns {{ role: string, company: string } | null} */
function parseRoleCompanyBody(body) {
  const lines = stripHtml(body).split('\n').map(text).filter(Boolean);
  let role = '';
  let company = '';
  for (const line of lines) {
    const pair = parseRoleCompanyText(line);
    if (pair) return pair;
    const roleMatch = line.match(/^(?:position|role|job title|job)\s*[:\-–—]\s*(.+)$/i);
    if (roleMatch && looksLikeRole(normalizeRoleCandidate(roleMatch[1]))) role = normalizeRoleCandidate(roleMatch[1]);
    const appliedRoleMatch = line.match(/\b(?:apply|applying)\s+(?:for|to)\s+(?:(?:the|our|a|an)\s+)?([^.!?\r\n]{3,120}?)\s+role\b/i);
    if (appliedRoleMatch && looksLikeRole(normalizeRoleCandidate(appliedRoleMatch[1]))) role = normalizeRoleCandidate(appliedRoleMatch[1]);
    const companyMatch = line.match(/^(?:company|employer)\s*[:\-–—]\s*(.+)$/i);
    if (companyMatch) company = normalizeCompanyCandidate(companyMatch[1]);
  }
  return role ? { role, company } : null;
}

/** @param {string} body @returns {{ role: string, company: string } | null} */
function parseLinkedInJobEvidence(body) {
  const lines = stripHtml(body).split('\n').map(text).filter(Boolean);
  const sentIndex = lines.findIndex((line) => /^Your application was sent to\s+.+/i.test(line));
  if (sentIndex >= 0 && lines[sentIndex + 1] && lines[sentIndex + 2]) {
    const subjectCompany = normalizeCompanyCandidate(lines[sentIndex].replace(/^Your application was sent to\s+/i, ''));
    const role = normalizeRoleCandidate(lines[sentIndex + 1]);
    const company = normalizeCompanyCandidate(lines[sentIndex + 2]);
    if (looksLikeRole(role) && looksLikeCompany(company) && sameCompany(subjectCompany, company)) return { role, company };
  }
  const labels = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']https?:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/\d+[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(body || '').matchAll(anchorPattern)) labels.push(stripHtml(match[1]));
  const markdownPattern = /\[([^\]]+)\]\(https?:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/\d+[^)]*\)/gi;
  for (const match of String(body || '').matchAll(markdownPattern)) labels.push(stripHtml(match[1]));
  for (const label of labels) {
    const beforeLocation = text(label).split(/\s+·\s+/)[0];
    const match = beforeLocation.match(/^(.+?)\s+([A-Z][A-Za-z0-9&.'-]{1,80})$/);
    if (!match) continue;
    const role = normalizeRoleCandidate(match[1]);
    const company = normalizeCompanyCandidate(match[2]);
    if (looksLikeRole(role) && looksLikeCompany(company)) return { role, company };
  }
  return null;
}

/** @param {string} url @returns {string} */
function companyFromAnyJobUrl(url) {
  const known = companyFromUrl(url);
  if (known) return displayFromSlug(known);
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (/ashbyhq\.com$/i.test(parsed.hostname) && parts[0]) return displayFromSlug(parts[0]);
    if (/workable\.com$/i.test(parsed.hostname) && parts[0]) return displayFromSlug(parts[0]);
  } catch { /* ignore malformed email links */ }
  return '';
}

/** @param {unknown} message @returns {string} */
function messageDate(message) {
  if (message && typeof message === 'object') {
    const raw = /** @type {Record<string, unknown>} */ (message);
    const internal = Number(raw.internalDate);
    if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString().slice(0, 10);
    const headers = raw.payload && typeof raw.payload === 'object'
      ? /** @type {Record<string, unknown>} */ (raw.payload).headers
      : [];
    if (Array.isArray(headers)) {
      const dateHeader = headers.find((header) => header && typeof header === 'object'
        && text(/** @type {Record<string, unknown>} */ (header).name).toLowerCase() === 'date');
      const parsed = Date.parse(text(dateHeader && typeof dateHeader === 'object'
        ? /** @type {Record<string, unknown>} */ (dateHeader).value : ''));
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse one full Gmail message without persisting the body. DMARC is a hard
 * authentication gate, but sender provenance is a separate gate: provider
 * notifications cannot become direct employer/ATS confirmation. A
 * confirmation with missing role/company fields is review-only.
 *
 * @param {{ id?: string, internalDate?: string, payload?: Record<string, unknown> }} message
 * @returns {{ confidence: 'high'|'review'|'ignore', reason: string, evidenceType?: 'company-or-ats-confirmation'|'provider-submission', status?: 'Applied'|'Rejected', company?: string, role?: string, url?: string, messageId?: string, date: string, subject: string, from: string }}
 */
export function parseApplicationConfirmation(message) {
  const payload = message.payload || {};
  const rawHeaders = Array.isArray(payload.headers) ? payload.headers : [];
  const headers = rawHeaders.filter((header) => header && typeof header === 'object').map((header) => ({
    name: text(/** @type {Record<string, unknown>} */ (header).name),
    value: text(/** @type {Record<string, unknown>} */ (header).value),
  }));
  const subject = headerValue(headers, 'subject');
  const from = headerValue(headers, 'from');
  const body = getMessageBody(payload);
  const plainBody = stripHtml(body);
  const combined = `${subject}\n${plainBody}`;
  const date = messageDate(message);
  const messageId = text(message.id);

  if (!isAuthenticEmail(headers)) {
    return { confidence: 'ignore', reason: 'email did not pass the DMARC authentication gate', date, subject, from, ...(messageId ? { messageId } : {}) };
  }
  const status = REJECTION_SIGNAL_RE.test(combined) ? 'Rejected' : 'Applied';
  if (!CONFIRMATION_SIGNAL_RE.test(combined) && status !== 'Rejected') {
    return { confidence: 'ignore', reason: 'no unambiguous application-confirmation language', date, subject, from, ...(messageId ? { messageId } : {}) };
  }

  const urls = extractJobUrls(body);
  const linkedInSubject = isLinkedInApplicationSender(from)
    ? subject.match(/^Your application to\s+(.{3,120}?)\s+at\s+(.{2,80})$/i)
    : null;
  const subjectPair = linkedInSubject
    ? {
      role: normalizeRoleCandidate(linkedInSubject[1]),
      company: normalizeCompanyCandidate(linkedInSubject[2]),
    }
    : parseRoleCompanyText(subject);
  const bodyPair = parseRoleCompanyBody(body);
  const linkedInPair = parseLinkedInJobEvidence(body);
  const pair = isLinkedInApplicationSender(from)
    ? subjectPair || linkedInPair
    : subjectPair || bodyPair;
  const role = pair?.role || '';
  const company = pair?.company
    || companyFromAnyJobUrl(urls[0] || '')
    || companyFromSender(from);
  const url = urls[0] || '';
  if (isLinkedInApplicationSender(from)) {
    return {
      confidence: 'review',
      reason: 'LinkedIn-originated email is provider evidence, not direct employer or ATS confirmation',
      evidenceType: 'provider-submission',
      status,
      ...(company ? { company: normalizeCompanyCandidate(company) } : {}),
      ...(role ? { role: normalizeRoleCandidate(role) } : {}),
      ...(url ? { url } : {}),
      date,
      subject,
      from,
      ...(messageId ? { messageId } : {}),
    };
  }
  if (!role || !company) {
    return {
      confidence: 'review',
      reason: `confirmation is authentic but missing ${role ? 'company' : company ? 'role' : 'role and company'}`,
      status,
      ...(company ? { company } : {}),
      ...(role ? { role } : {}),
      ...(url ? { url } : {}),
      date,
      subject,
      from,
      ...(messageId ? { messageId } : {}),
    };
  }
  return {
    confidence: 'high',
    reason: 'authenticated application confirmation with role and company evidence',
    evidenceType: 'company-or-ats-confirmation',
    status,
    company: normalizeCompanyCandidate(company),
    role: normalizeRoleCandidate(role),
    ...(url ? { url } : {}),
    date,
    subject,
    from,
    ...(messageId ? { messageId } : {}),
  };
}

/** @param {string} root @returns {Set<string>} */
function loadProcessedIds(root) {
  const file = path.join(root, STATE_FILE);
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.processing_version !== PROCESSING_VERSION) return new Set();
    return new Set(Array.isArray(parsed.processed_message_ids)
      ? parsed.processed_message_ids.filter((id) => typeof id === 'string')
      : []);
  } catch { return new Set(); }
}

/** @param {string} root @param {Set<string>} ids */
function saveProcessedIds(root, ids) {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, STATE_FILE), `${JSON.stringify({
    account_email: TARGET_GMAIL_ACCOUNT,
    processing_version: PROCESSING_VERSION,
    processed_message_ids: [...ids].slice(-5000),
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

/**
 * Read confirmation emails from the verified Gmail account.
 *
 * @param {{ root?: string, client?: Awaited<ReturnType<typeof createGmailClient>>, limit?: number, daysBack?: number, logger?: (...args: unknown[]) => void }} [options]
 */
export async function collectGmailApplicationSignals(options = {}) {
  const root = options.root || process.cwd();
  const settings = loadGmailSettings(root);
  const daysBack = Number(options.daysBack || settings.application_days_back || DEFAULT_DAYS_BACK);
  const limit = Number(options.limit || settings.application_max_messages || DEFAULT_MAX_MESSAGES);
  const safeDays = Number.isInteger(daysBack) && daysBack > 0 ? daysBack : DEFAULT_DAYS_BACK;
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : DEFAULT_MAX_MESSAGES;
  const logger = options.logger || console.log;
  const client = options.client || await createGmailClient({
    expectedAccount: String(settings.account_email || TARGET_GMAIL_ACCOUNT),
  });
  const accountEmail = await client.verifyAccount();
  const query = APPLICATION_CONFIRMATION_QUERY.replace(/newer_than:\d+d/, `newer_than:${safeDays}d`);
  logger(`gmail applications: account ${accountEmail}; querying ${query}`);
  const messages = await client.listMessages(query, { limit: safeLimit });
  const processed = loadProcessedIds(root);
  const signals = [];
  const review = [];
  let considered = 0;

  for (const message of messages) {
    const id = text(message.id);
    if (!id || processed.has(id)) continue;
    considered++;
    let full;
    try {
      full = await client.getMessage(id, 'full');
    } catch (error) {
      logger(`gmail applications: failed to fetch message ${id} — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const payload = full.payload && typeof full.payload === 'object'
      ? /** @type {Record<string, unknown>} */ (full.payload)
      : {};
    const parsed = parseApplicationConfirmation({ id, internalDate: text(full.internalDate), payload });
    if (parsed.confidence === 'high') signals.push(parsed);
    if (parsed.confidence === 'review') review.push(parsed);
    if (parsed.confidence !== 'ignore') processed.add(id);
  }
  return { accountEmail, query, scanned: messages.length, considered, signals, review, processed };
}

/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function rawBoardCards(value) {
  if (!value || typeof value !== 'object') return [];
  const root = /** @type {Record<string, unknown>} */ (value);
  if (Array.isArray(root.cards)) return root.cards.filter((card) => card && typeof card === 'object');
  if (!Array.isArray(root.columns)) return [];
  return root.columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const record = /** @type {Record<string, unknown>} */ (column);
    const status = text(record.status || record.name || record.title);
    return Array.isArray(record.cards)
      ? record.cards.filter((card) => card && typeof card === 'object').map((card) => ({
        .../** @type {Record<string, unknown>} */ (card),
        status,
      }))
      : [];
  });
}

/** @param {unknown} value @param {string} observedAt @returns {Array<Record<string, unknown>>} */
export function normalizeJackBoardCards(value, observedAt = new Date().toISOString()) {
  const root = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  const snapshotObservedAt = text(root.observedAt) || observedAt;
  const sourceUrl = text(root.sourceUrl) || 'https://app.jackandjill.ai/jack/dashboard/jobs/kanban';
  const cards = [];
  for (const raw of rawBoardCards(value)) {
    const card = /** @type {Record<string, unknown>} */ (raw);
    const status = text(card.status || card.column || card.stage);
    const title = text(card.role || card.title || card.name);
    const company = text(card.company || card.employer);
    if (!status || !title || !company) continue;
    cards.push({
      source: 'jackandjill',
      sourceLabel: 'Jack & Jill board',
      sourceUrl: text(card.sourceUrl || card.url || card.href) || sourceUrl,
      ...(text(card.sourceId || card.id || card.jobId || card.reviewId) ? { sourceId: text(card.sourceId || card.id || card.jobId || card.reviewId) } : {}),
      ...(text(card.applyUrl || card.jobUrl || card.postingUrl) ? { applyUrl: text(card.applyUrl || card.jobUrl || card.postingUrl) } : {}),
      observedAt: snapshotObservedAt,
      status,
      boardStatus: status,
      title,
      role: title,
      company,
      ...(text(card.location) ? { location: text(card.location) } : {}),
      ...(text(card.ageText) ? { ageText: text(card.ageText) } : {}),
    });
  }
  return cards;
}

/** @param {string} root @returns {Record<string, unknown> | null} */
function readBoardSnapshot(root) {
  const file = path.join(root, 'data', 'jackandjill-board.json');
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    throw new Error(`Jack & Jill board snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {Record<string, unknown> | null} snapshot @param {number} maxAgeDays @param {string} now */
function boardSnapshotIsFresh(snapshot, maxAgeDays, now) {
  if (!snapshot) return false;
  const observed = Date.parse(text(snapshot.observedAt));
  if (!Number.isFinite(observed)) return false;
  const age = Date.parse(now) - observed;
  return age >= 0 && age <= maxAgeDays * 86_400_000;
}

/** @param {string} root @returns {Array<Record<string, unknown>>} */
function readTrackerRows(root) {
  const file = path.join(root, 'data', 'applications.md');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean);
}

/** @param {string} a @param {string} b @returns {boolean} */
function sameCompany(a, b) {
  const left = companyKey(a);
  const right = companyKey(b);
  if (!left || !right) return false;
  return left === right || (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)));
}

/** @param {string} a @param {string} b @returns {boolean} */
function sameRoleVariant(a, b) {
  const left = roleKey(a);
  const right = roleKey(b);
  return left.length >= 12 && right.length >= 12 && (left.includes(right) || right.includes(left));
}

/** @param {string} role @returns {boolean} */
function genericRole(role) {
  const tokens = roleTokens(role);
  return tokens.length <= 2 || /^(?:software|backend|full[- ]?stack)\s+engineer$/i.test(text(role));
}

/** @param {Array<Record<string, unknown>>} rows @param {{company?: string, role?: string}} record */
function findTrackerMatch(rows, record) {
  const companyRows = rows.filter((row) => sameCompany(text(row.company), text(record.company)));
  if (!companyRows.length) return null;
  const exact = companyRows.find((row) => roleKey(text(row.role)) === roleKey(text(record.role)));
  if (exact) return exact;
  const fuzzy = companyRows.filter((row) => roleFuzzyMatch(text(row.role), text(record.role)));
  if (fuzzy.length === 1) return fuzzy[0];
  const variant = companyRows.filter((row) => sameRoleVariant(text(row.role), text(record.role)));
  if (variant.length === 1) return variant[0];
  if (companyRows.length === 1 && (genericRole(text(companyRows[0].role)) || genericRole(text(record.role)))) return companyRows[0];
  return null;
}

/** @param {string} status @returns {string} */
function boardStatus(status) {
  return STATUS_BY_BOARD_COLUMN[text(status)] || '';
}

/** @param {string} current @param {string} desired @returns {boolean} */
function shouldPromote(current, desired) {
  if (current === 'SKIP' || current === 'Discarded' || current === 'Rejected') return false;
  return Number(STATUS_RANK[desired] || 0) > Number(STATUS_RANK[current] || 0);
}

/** @param {Array<Record<string, unknown>>} signals @param {Array<Record<string, unknown>>} cards */
function combineIncoming(signals, cards) {
  const grouped = new Map();
  const add = (record) => {
    const company = text(record.company);
    const role = text(record.role || record.title);
    const status = text(record.status);
    if (!company || !role || !status) return;
    const key = `${companyKey(company)}::${roleKey(role)}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...record, company, role, sources: [record] });
      return;
    }
    current.sources.push(record);
    if (Number(STATUS_RANK[status] || 0) > Number(STATUS_RANK[current.status] || 0)) current.status = status;
  };
  for (const signal of signals) add({ ...signal, source: 'gmail', status: signal.status || 'Applied', role: signal.role, company: signal.company });
  for (const card of cards) {
    const status = boardStatus(text(card.status));
    if (!status) continue;
    add({ ...card, source: 'jackandjill', status, role: card.role || card.title, company: card.company });
  }
  return [...grouped.values()];
}

/** @param {Record<string, unknown>} record @returns {boolean} */
function isBlockedEmailSignal(record) {
  return isLinkedInApplicationSender(text(record.from));
}

/** @param {Record<string, unknown>} incoming @returns {string} */
function importNote(incoming) {
  const parts = [];
  const sources = Array.isArray(incoming.sources) ? incoming.sources : [incoming];
  const seen = new Set();
  for (const source of sources) {
    const record = /** @type {Record<string, unknown>} */ (source);
    const kind = text(record.source);
    const date = text(record.date || record.observedAt).slice(0, 10);
    const boardStage = text(record.boardStatus || record.status);
    const label = kind === 'gmail'
      ? `Gmail ${record.status === 'Rejected' ? 'rejection' : 'application confirmation'}${date ? ` ${date}` : ''}`
      : `Jack & Jill board: ${boardStage}${date ? ` (${date})` : ''}`;
    if (!seen.has(label)) { parts.push(label); seen.add(label); }
  }
  return `Imported evidence: ${parts.join('; ')}.`;
}

/**
 * Build a reviewable plan without mutating the tracker.
 *
 * @param {{ rows: Array<Record<string, unknown>>, emailSignals?: Array<Record<string, unknown>>, boardCards?: Array<Record<string, unknown>>, observedAt?: string }} input
 */
export function buildImportPlan(input) {
  const rows = input.rows || [];
  const emailSignals = input.emailSignals || [];
  const blockedEmailSignals = emailSignals.filter(isBlockedEmailSignal);
  const incoming = combineIncoming(emailSignals.filter((signal) => !isBlockedEmailSignal(signal)), input.boardCards || []);
  const actions = [];
  const review = blockedEmailSignals.map((signal) => ({
    confidence: 'review',
    reason: 'LinkedIn-originated email is provider evidence, not direct employer or ATS confirmation',
    status: text(signal.status) || 'Applied',
    ...(text(signal.company) ? { company: text(signal.company) } : {}),
    ...(text(signal.role) ? { role: text(signal.role) } : {}),
    ...(text(signal.url) ? { url: text(signal.url) } : {}),
    ...(text(signal.date) ? { date: text(signal.date) } : {}),
    ...(text(signal.subject) ? { subject: text(signal.subject) } : {}),
    from: text(signal.from),
    sources: [{ ...signal, source: 'gmail' }],
    observedAt: input.observedAt || new Date().toISOString(),
  }));
  let nextNum = rows.reduce((max, row) => Math.max(max, Number(row.num) || 0), 0) + 1;
  for (const record of incoming) {
    const match = findTrackerMatch(rows, record);
    const note = importNote(record);
    if (!match) {
      actions.push({ type: 'add', num: nextNum++, company: cell(record.company), role: cell(record.role), status: record.status, notes: note, sourceUrl: text(record.url || record.sourceUrl) });
      continue;
    }
    const currentStatus = text(match.status);
    if (currentStatus === 'SKIP' || currentStatus === 'Discarded' || currentStatus === 'Rejected') {
      review.push({
        reason: `external evidence says ${record.status}, but tracker preserves ${currentStatus}`,
        company: text(record.company),
        role: text(record.role),
        status: record.status,
        trackerNum: match.num,
        sources: record.sources,
        observedAt: input.observedAt || new Date().toISOString(),
      });
      continue;
    }
    const currentNotes = text(match.notes);
    const addNote = note.split('; ').filter((part) => part && !currentNotes.includes(part)).join('; ');
    const nextNotes = addNote ? `${currentNotes}${currentNotes ? ' ' : ''}${addNote}` : currentNotes;
    if (shouldPromote(currentStatus, text(record.status)) || nextNotes !== currentNotes) {
      actions.push({
        type: 'update',
        num: Number(match.num),
        status: shouldPromote(currentStatus, text(record.status)) ? text(record.status) : currentStatus,
        notes: nextNotes,
        company: text(match.company),
        role: text(match.role),
      });
    }
  }
  return { actions, review, incomingCount: incoming.length };
}

/** @param {string} root @param {Array<Record<string, unknown>>} additions @param {(...args: unknown[]) => void} logger */
async function mergeNewTrackerRows(root, additions, logger) {
  if (!additions.length) return;
  const additionsDir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-application-import-'));
  try {
    for (const addition of additions) {
      const slug = `${String(addition.company).toLowerCase()}-${String(addition.role).toLowerCase()}`
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'application';
      const file = path.join(additionsDir, `${String(addition.num).padStart(4, '0')}-${slug}.tsv`);
      writeFileSync(file, [
        addition.num,
        new Date().toISOString().slice(0, 10),
        cell(addition.company),
        cell(addition.role),
        addition.status,
        'N/A',
        '❌',
        '—',
        cell(addition.notes),
      ].join('\t') + '\n', 'utf8');
    }
    const result = await execFileAsync(process.execPath, [path.join(ROOT, 'merge-tracker.mjs'), '--verify'], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CAREER_OPS_TRACKER: path.join(root, 'data', 'applications.md'), CAREER_OPS_ADDITIONS: additionsDir },
    });
    logger(String(result.stdout || '').trim());
  } finally {
    rmSync(additionsDir, { recursive: true, force: true });
  }
}

/** @param {string} root @param {Array<Record<string, unknown>>} updates */
function applyTrackerUpdates(root, updates) {
  for (const update of updates) {
    if (update.status) setRowStatus(root, Number(update.num), text(update.status));
    if (update.notes) setRowNotes(root, Number(update.num), text(update.notes));
  }
}

/** @param {string} root @param {Array<Record<string, unknown>>} review */
function saveReview(root, review) {
  if (!review.length) return;
  mkdirSync(path.join(root, 'data'), { recursive: true });
  let existing = [];
  const file = path.join(root, REVIEW_FILE);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      existing = Array.isArray(parsed?.items) ? parsed.items : [];
    } catch { existing = []; }
  }
  const key = (item) => `${text(item.messageId)}::${companyKey(text(item.company))}::${roleKey(text(item.role))}::${text(item.reason)}`;
  const merged = new Map(existing.map((item) => [key(item), item]));
  for (const item of review) merged.set(key(item), item);
  writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    items: [...merged.values()].slice(-500),
  }, null, 2)}\n`, 'utf8');
}

/**
 * Run the daily application import. Gmail is read-only; Jack & Jill uses the
 * local snapshot produced by an explicit authenticated board inspection.
 *
 * @param {{ root?: string, dryRun?: boolean, skipGmail?: boolean, boardSnapshot?: Record<string, unknown> | null, client?: Awaited<ReturnType<typeof createGmailClient>>, limit?: number, logger?: (...args: unknown[]) => void }} [options]
 */
export async function syncApplicationIngest(options = {}) {
  const root = options.root || process.cwd();
  await loadDotenvOnce(root);
  const dryRun = options.dryRun === true;
  const logger = options.logger || console.log;
  const now = new Date().toISOString();
  const errors = [];
  let email = { scanned: 0, signals: [], review: [], processed: new Set(), skipped: false };
  if (!options.skipGmail) {
    if (!options.client && !hasGmailCredentials()) {
      email.skipped = true;
      errors.push(`Gmail application ingest unavailable until OAuth values are configured for ${TARGET_GMAIL_ACCOUNT}`);
    } else {
      try {
        email = await collectGmailApplicationSignals({ root, client: options.client, limit: options.limit, logger });
      } catch (error) {
        errors.push(`Gmail application ingest failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    email.skipped = true;
  }

  const snapshot = options.boardSnapshot === undefined ? readBoardSnapshot(root) : options.boardSnapshot;
  const settings = loadGmailSettings(root);
  const maxAgeDays = Number(settings.jackandjill_board_max_age_days || DEFAULT_BOARD_MAX_AGE_DAYS);
  const freshBoard = snapshot && boardSnapshotIsFresh(snapshot, Number.isFinite(maxAgeDays) ? maxAgeDays : DEFAULT_BOARD_MAX_AGE_DAYS, now)
    ? snapshot
    : null;
  if (snapshot && !freshBoard) errors.push('Jack & Jill board snapshot is stale or missing observedAt; no board statuses imported');
  const boardCards = freshBoard ? normalizeJackBoardCards(freshBoard, now) : [];
  const plan = buildImportPlan({ rows: readTrackerRows(root), emailSignals: email.signals, boardCards, observedAt: now });
  if (!dryRun) {
    await mergeNewTrackerRows(root, plan.actions.filter((action) => action.type === 'add'), logger);
    applyTrackerUpdates(root, plan.actions.filter((action) => action.type === 'update'));
    saveReview(root, [...email.review, ...plan.review]);
    if (email.processed instanceof Set && email.processed.size) saveProcessedIds(root, email.processed);
  }
  const added = plan.actions.filter((action) => action.type === 'add').length;
  const updated = plan.actions.filter((action) => action.type === 'update').length;
  logger(`application ingest${dryRun ? ' (dry run)' : ''}: ${added} new, ${updated} updated, ${plan.review.length + email.review.length} review item(s), ${boardCards.length} Jack & Jill card(s) considered`);
  return {
    email: { scanned: email.scanned, signals: email.signals.length, review: email.review.length, skipped: email.skipped },
    board: { cards: boardCards.length, fresh: Boolean(freshBoard) },
    plan,
    errors,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const boardOnly = args.includes('--board-only');
  await syncApplicationIngest({ dryRun, skipGmail: boardOnly });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { await main(); }
  catch (error) {
    const message = error instanceof GmailClientError ? error.message : error instanceof Error ? error.message : String(error);
    console.error(`application-ingest: ${message}`);
    process.exitCode = 1;
  }
}
