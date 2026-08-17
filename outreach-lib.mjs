// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  applicationKey,
  normalizeText,
  normalizeUrl,
} from './queue-lib.mjs';
import { validateOutreachDraftReceipt } from './outreach-draft-quality.mjs';
import { buildOutreachArtifactRequest, validateRdwArtifactReceipt } from './rdw-writing.mjs';

export const OUTREACH_SCHEMA_VERSION = 3;
export const OUTREACH_MESSAGE_VERSION = 5;
export const OUTREACH_DISCOVERY_PIPELINE_VERSION = 14;
export const OUTREACH_STATE_PATH = 'data/outreach-state.json';
export const OUTREACH_CONTACTS_PATH = 'data/outreach-contacts.json';
export const OUTREACH_MAX_SEND_ATTEMPTS = 3;
export const OUTREACH_SEND_STALE_MS = 15 * 60 * 1000;
export const OUTREACH_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
export const DISCOVERY_CACHE_TTLS_MS = Object.freeze({
  found: 7 * 24 * 60 * 60 * 1000,
  no_contacts: 24 * 60 * 60 * 1000,
  unavailable: 2 * 60 * 60 * 1000,
  error: 30 * 60 * 1000,
});

export const DEFAULT_OUTREACH_POLICY = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  senderEmail: 'jakyejobs@gmail.com',
  maxContactsPerApplication: 2,
  dailyInitialEmailLimit: 10,
  dailyFollowUpLimit: 10,
  rampInitialEmailLimit: 2,
  followUpBusinessDays: 5,
  requireVerifiedPublicEmail: true,
  linkedinAutoSend: false,
  noAttachments: true,
});

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com',
]);
const BLOCKED_PROVIDER_EMAIL_DOMAINS = new Set([
  'linkedin.com',
  'teamworkonline.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workday.com',
  'myworkdayjobs.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'wellfound.com',
  'angel.co',
  'builtin.com',
  'joinhandshake.com',
  'smartrecruiters.com',
  'icims.com',
  'jobvite.com',
  'workable.com',
  'bamboohr.com',
]);
const BLOCKED_PROVIDER_EMAILS = new Set([
  'newsletters-noreply@linkedin.com',
  'hit-reply@linkedin.com',
]);
const CONFIRMATION_RE = /(?:application\s+(?:was\s+)?(?:received|submitted)|thank\s+you\s+for\s+applying|thanks\s+for\s+applying|we['’]?ve\s+received\s+your\s+application|successfully\s+applied)/i;
const TITLE_STOPWORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'the', 'to', 'with', 'software', 'engineer', 'developer']);
const COMPANY_STOPWORDS = new Set(['and', 'more', 'jobs', 'job', 'for', 'you', 'apply', 'now', 'new', 'york', 'your']);
const AGGREGATE_COMPANY_RE = /\band\s+\d+\s+more\b|\b\d+\s+more\s+jobs?\b|\bfor\s+you\b|\bapply\s+now\b/i;
const BLOCKED_MESSAGE_RE = /(?:\+?1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|expected\s+(?:(?:may|spring|fall|summer|winter)\s+)?20\d{2}|(?:spring|fall|summer|winter)\s+20\d{2}|\btwo\s+courses?\s+remaining\b)/i;
const PROOF_FRAGMENT_START_RE = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i;
const FINITE_VERB_RE = /\b(?:am|are|be|been|being|built|build|created|create|delivered|designed|developed|gave|give|had|has|have|improved|implemented|is|launched|led|manage|managed|provided|shipped|was|were|worked|work)\b/i;
const FIRST_PARTY_RELATIONSHIP_SOURCE = 'first-party-relationship';

/** @param {string} value */
function lower(value) { return normalizeText(value).toLowerCase(); }

/** @param {unknown} value */
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/** @param {unknown} value */
function asString(value) { return typeof value === 'string' ? normalizeText(value) : ''; }

/** Preserve intentional email paragraphs while normalizing only transport line endings. @param {unknown} value */
function asMessageBody(value) { return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''; }

/** @param {unknown} value */
function asBoolean(value) { return value === true; }

/** @param {unknown} value @param {number} fallback */
function asNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** @param {Record<string, unknown>} signal */
function normalizeSubmissionSignal(signal) {
  return {
    source: asString(signal.source) || 'unknown',
    at: asString(signal.at) || new Date().toISOString(),
    messageId: asString(signal.messageId) || null,
    subject: asString(signal.subject) || null,
    confirmed: asBoolean(signal.confirmed),
    submissionId: asString(signal.submissionId) || null,
    evidence: isRecord(signal.evidence) ? signal.evidence : null,
  };
}

/** @param {Record<string, unknown>} record */
function migrateRecord(record) {
  const submission = isRecord(record.submission) ? record.submission : {};
  const signals = Array.isArray(submission.signals)
    ? submission.signals.filter(isRecord).map(normalizeSubmissionSignal)
    : [];
  const confirmedSignal = signals.find((signal) => signal.confirmed === true);
  const confirmed = submission.confirmed === true || Boolean(confirmedSignal);
  const contacts = Array.isArray(record.contacts)
    ? record.contacts.filter(isSafePersistedContact)
    : record.contacts;
  const discoveredContacts = Array.isArray(record.discoveredContacts)
    ? record.discoveredContacts.filter(isSafePersistedContact)
    : record.discoveredContacts;
  const removedContacts = (Array.isArray(record.contacts) && contacts.length !== record.contacts.length)
    || (Array.isArray(record.discoveredContacts) && discoveredContacts.length !== record.discoveredContacts.length);
  const discovery = removedContacts && isRecord(record.discovery)
    ? {
      ...record.discovery,
      pipelineVersion: 0,
      status: 'stale',
      cacheExpiresAt: null,
      nextAttemptAt: null,
      candidateCount: Array.isArray(discoveredContacts) ? discoveredContacts.length : 0,
      reason: 'Unsafe legacy provider contact evidence was removed; discovery refresh required.',
      phases: sanitizeDiscoveryPhases(record.discovery.phases),
    }
    : record.discovery;
  const status = Array.isArray(contacts)
    && contacts.length === 0
    && record.status === 'drafted'
    ? (confirmed ? 'awaiting_contacts' : 'awaiting_submission_confirmation')
    : record.status;
  return {
    ...record,
    status,
    ...(Array.isArray(contacts) ? { contacts } : {}),
    ...(Array.isArray(discoveredContacts) ? { discoveredContacts } : {}),
    ...(discovery ? { discovery } : {}),
    submission: {
      ...submission,
      signals,
      confirmed,
      confirmedAt: asString(submission.confirmedAt) || (confirmedSignal?.at || null),
      confirmedSource: asString(submission.confirmedSource) || (confirmedSignal?.source || null),
      submissionId: asString(submission.submissionId) || (confirmedSignal?.submissionId || null),
    },
  };
}

/** @param {unknown} contact */
function isSafePersistedContact(contact) {
  return isRecord(contact)
    && !isProviderGeneratedContactEmail(contact.email)
    && hasTargetCompanyContactEvidence(contact);
}

/** @param {unknown} phases */
function sanitizeDiscoveryPhases(phases) {
  if (!isRecord(phases)) return phases;
  const warmNetwork = isRecord(phases.warmNetwork) ? phases.warmNetwork : null;
  if (!warmNetwork || !Array.isArray(warmNetwork.contacts)) return phases;
  return {
    ...phases,
    warmNetwork: {
      ...warmNetwork,
      contacts: warmNetwork.contacts.filter(isSafePersistedContact),
    },
  };
}

/** @param {Record<string, unknown>} profile */
export function loadOutreachPolicy(profile = {}) {
  const configured = isRecord(profile.outreach_policy) ? profile.outreach_policy : {};
  const policy = { ...DEFAULT_OUTREACH_POLICY, ...configured };
  return {
    ...policy,
    schemaVersion: 1,
    senderEmail: lower(policy.senderEmail) || DEFAULT_OUTREACH_POLICY.senderEmail,
    enabled: asBoolean(policy.enabled),
    maxContactsPerApplication: Math.min(2, Math.max(1, Math.round(asNumber(policy.maxContactsPerApplication, 2)))),
    dailyInitialEmailLimit: Math.min(10, Math.max(1, Math.round(asNumber(policy.dailyInitialEmailLimit, 10)))),
    dailyFollowUpLimit: Math.min(10, Math.max(1, Math.round(asNumber(policy.dailyFollowUpLimit, 10)))),
    rampInitialEmailLimit: Math.min(10, Math.max(1, Math.round(asNumber(policy.rampInitialEmailLimit, 2)))),
    followUpBusinessDays: Math.min(20, Math.max(1, Math.round(asNumber(policy.followUpBusinessDays, 5)))),
    requireVerifiedPublicEmail: policy.requireVerifiedPublicEmail !== false,
    linkedinAutoSend: false,
    noAttachments: true,
  };
}

/** @param {string} file */
export function loadOutreachState(file) {
  if (!existsSync(file)) return {
    schemaVersion: OUTREACH_SCHEMA_VERSION,
    records: [],
    settings: {},
    scan: {},
    outbox: [],
    sendAuthorizations: [],
    path: file,
  };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const outbox = Array.isArray(parsed?.outbox)
      ? parsed.outbox.filter(isRecord).filter((entry) => !isProviderGeneratedContactEmail(entry.to))
      : [];
    const outboxIds = new Set(outbox.map((entry) => asString(entry.id)).filter(Boolean));
    return {
      schemaVersion: OUTREACH_SCHEMA_VERSION,
      records: Array.isArray(parsed?.records) ? parsed.records.filter(isRecord).map(migrateRecord) : [],
      settings: isRecord(parsed?.settings) ? parsed.settings : {},
      scan: isRecord(parsed?.scan) ? parsed.scan : {},
      outbox,
      sendAuthorizations: Array.isArray(parsed?.sendAuthorizations)
        ? parsed.sendAuthorizations.filter(isRecord).filter((authorization) => {
          const entries = Array.isArray(authorization.entries) ? authorization.entries.filter(isRecord) : [];
          return entries.every((entry) => !isProviderGeneratedContactEmail(entry.to)
            && (!asString(entry.id) || outboxIds.has(asString(entry.id))));
        })
        : [],
      lastProcess: isRecord(parsed?.lastProcess) ? parsed.lastProcess : null,
      updatedAt: asString(parsed?.updatedAt) || null,
      path: file,
    };
  } catch {
    return {
      schemaVersion: OUTREACH_SCHEMA_VERSION,
      records: [],
      settings: {},
      scan: {},
      outbox: [],
      sendAuthorizations: [],
      lastProcess: null,
      path: file,
      loadError: 'outreach state is not valid JSON',
    };
  }
}

/** @param {string} file @param {Record<string, unknown>} state */
export function saveOutreachState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  const persisted = {
    schemaVersion: OUTREACH_SCHEMA_VERSION,
    records: Array.isArray(state.records) ? state.records : [],
    settings: isRecord(state.settings) ? state.settings : {},
    scan: isRecord(state.scan) ? state.scan : {},
    outbox: Array.isArray(state.outbox) ? state.outbox : [],
    sendAuthorizations: Array.isArray(state.sendAuthorizations) ? state.sendAuthorizations : [],
    lastProcess: isRecord(state.lastProcess) ? state.lastProcess : null,
    updatedAt: asString(state.updatedAt) || new Date().toISOString(),
  };
  writeFileSync(temp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** @param {Record<string, unknown>} item */
export function outreachKey(item) {
  return applicationKey(item);
}

/** @param {Record<string, unknown>} item @param {{ source: string, at?: string, messageId?: string, subject?: string, confirmed?: boolean, submissionId?: string, evidence?: Record<string, unknown> }} signal */
export function upsertSubmissionSignal(state, item, signal) {
  const key = outreachKey(item);
  const evidence = normalizeSubmissionSignal(signal);
  const at = evidence.at;
  const existing = state.records.find((record) => record.key === key);
  const isTerminal = (status) => ['paused', 'complete', 'suppressed', 'needs_application_identity'].includes(status);
  if (existing) {
    const submission = isRecord(existing.submission) ? existing.submission : {};
    const signals = Array.isArray(submission.signals) ? submission.signals : [];
    const signalKey = `${evidence.source}:${evidence.messageId || evidence.submissionId || (evidence.source === 'queue_applied' ? '' : evidence.at)}`;
    const known = signals.find((entry) => `${entry.source}:${entry.messageId || entry.submissionId || (entry.source === 'queue_applied' ? '' : entry.at)}` === signalKey);
    if (known) {
      if (evidence.confirmed === true) Object.assign(known, evidence);
    } else {
      signals.push(evidence);
    }
    const confirmedSignal = signals.find((entry) => entry.confirmed === true);
    const confirmed = submission.confirmed === true || Boolean(confirmedSignal);
    existing.submission = {
      ...submission,
      signals,
      confirmed,
      confirmedAt: asString(submission.confirmedAt) || (confirmedSignal?.at || null),
      confirmedSource: asString(submission.confirmedSource) || (confirmedSignal?.source || null),
      submissionId: asString(submission.submissionId) || (confirmedSignal?.submissionId || null),
      firstAt: submission.firstAt || at,
      lastAt: at,
    };
    if (!isTerminal(existing.status)) existing.status = confirmed ? 'awaiting_contacts' : 'awaiting_submission_confirmation';
    return existing;
  }
  const confirmed = evidence.confirmed === true;
  const record = {
    key,
    itemId: asString(item.id) || null,
    company: asString(item.company),
    title: asString(item.title),
    location: asString(item.location),
    applyUrl: normalizeUrl(asString(item.applyUrl || item.canonicalUrl)),
    lane: asString(item.lane),
    fitScore: asNumber(item.fitScore, null),
    status: confirmed ? 'awaiting_contacts' : 'awaiting_submission_confirmation',
    submission: {
      firstAt: at,
      lastAt: at,
      signals: [evidence],
      confirmed,
      confirmedAt: confirmed ? at : null,
      confirmedSource: confirmed ? evidence.source : null,
      submissionId: confirmed ? evidence.submissionId : null,
    },
    contacts: [],
    createdAt: at,
    updatedAt: at,
  };
  state.records.push(record);
  return record;
}

/** @param {string} file @param {Record<string, unknown>} item @param {{ source: string, at?: string, messageId?: string, subject?: string, confirmed?: boolean, submissionId?: string, evidence?: Record<string, unknown> }} signal */
export function recordSubmissionSignal(file, item, signal) {
  const state = loadOutreachState(file);
  const record = upsertSubmissionSignal(state, item, signal);
  state.updatedAt = new Date().toISOString();
  saveOutreachState(file, state);
  return record;
}

/** @param {Record<string, unknown>} record */
export function hasConfirmedSubmission(record) {
  return record?.submission?.confirmed === true;
}

/** @param {string} status @param {number} [candidateCount] */
export function discoveryCacheTtlMs(status, candidateCount = 0) {
  if (status === 'found' || (candidateCount > 0 && !['error', 'unavailable'].includes(status))) {
    return DISCOVERY_CACHE_TTLS_MS.found;
  }
  return DISCOVERY_CACHE_TTLS_MS[status] || DISCOVERY_CACHE_TTLS_MS.error;
}

/** @param {Array<Record<string, unknown>>} previous @param {Array<Record<string, unknown>>} fresh @param {boolean} preservePrevious */
export function retainDiscoveryContacts(previous, fresh, preservePrevious) {
  const candidates = preservePrevious ? [...previous, ...fresh] : fresh;
  const seen = new Set();
  return candidates.filter((contact) => {
    if (!isRecord(contact)) return false;
    const key = lower(asString(contact.email) || normalizeUrl(asString(contact.profileUrl)) || asString(contact.name));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {string} recordKey @param {string} contactId @param {'initial'|'followup'} kind @param {string} messageHashValue */
export function outreachMessageId(recordKey, contactId, kind, messageHashValue) {
  const digest = createHash('sha256')
    .update(`${recordKey}|${contactId}|${kind}|${messageHashValue}`)
    .digest('hex')
    .slice(0, 32);
  return `career-ops-${digest}`;
}

/** @param {Record<string, unknown>} state @param {{ recordKey: string, contactId: string, kind: 'initial'|'followup', to: string, subject: string, body: string, hash: string, messageVersion?: number, rdwRequest?: Record<string, unknown>|null, rdwReceipt?: Record<string, unknown>|null, draftQuality?: Record<string, unknown>|null, now?: string }} payload */
export function ensureOutboxEntry(state, payload) {
  if (!Array.isArray(state.outbox)) state.outbox = [];
  const now = payload.now || new Date().toISOString();
  const id = outreachMessageId(payload.recordKey, payload.contactId, payload.kind, payload.hash);
  const existing = state.outbox.find((entry) => entry.id === id);
  if (existing) {
    if (!existing.to) existing.to = payload.to;
    if (!existing.subject) existing.subject = payload.subject;
    if (!existing.body) existing.body = payload.body;
    if (!existing.hash) existing.hash = payload.hash;
    if (!existing.messageVersion) existing.messageVersion = payload.messageVersion;
    if (!existing.rdwRequest) existing.rdwRequest = payload.rdwRequest || null;
    if (!existing.rdwReceipt) existing.rdwReceipt = payload.rdwReceipt || null;
    if (!existing.draftQuality) existing.draftQuality = payload.draftQuality || null;
    if (!existing.status) existing.status = 'pending';
    if (!existing.createdAt) existing.createdAt = now;
    if (!existing.updatedAt) existing.updatedAt = now;
    return existing;
  }
  const entry = {
    id,
    recordKey: payload.recordKey,
    contactId: payload.contactId,
    kind: payload.kind,
    to: payload.to,
    subject: payload.subject,
    body: payload.body,
    hash: payload.hash,
    messageVersion: payload.messageVersion || null,
    rdwRequest: payload.rdwRequest || null,
    rdwReceipt: payload.rdwReceipt || null,
    draftQuality: payload.draftQuality || null,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    lastError: null,
    gmailMessageId: null,
    gmailDraftId: null,
    threadId: null,
    providerStatus: null,
  };
  state.outbox.push(entry);
  return entry;
}

/** @param {unknown} value */
export function isProviderGeneratedContactDomain(value) {
  const domain = asString(value).toLowerCase().replace(/^@/, '');
  return [...BLOCKED_PROVIDER_EMAIL_DOMAINS].some((provider) => domain === provider || domain.endsWith(`.${provider}`));
}

/** @param {unknown} value */
export function isProviderGeneratedContactEmail(value) {
  const email = asString(value).toLowerCase();
  if (!email) return false;
  if (BLOCKED_PROVIDER_EMAILS.has(email)) return true;
  const domain = email.split('@')[1] || '';
  return isProviderGeneratedContactDomain(domain);
}

/** @param {Record<string, unknown>} contact */
export function isVerifiedContactForExplicitSend(contact) {
  return isRecord(contact)
    && contact.emailEligible === true
    && contact.emailVerified === true
    && contact.emailHypothesis !== true
    && contact.guessed !== true
    && contact.private !== true
    && !isProviderGeneratedContactEmail(contact.email)
    && hasTargetCompanyContactEvidence(contact)
    && asString(contact.email);
}

/** @param {Record<string, unknown>} entry */
function authorizationSnapshot(entry) {
  return {
    id: asString(entry.id),
    recordKey: asString(entry.recordKey),
    contactId: asString(entry.contactId),
    kind: asString(entry.kind),
    to: lower(entry.to),
    subject: asString(entry.subject),
    body: asString(entry.body),
    hash: asString(entry.hash),
  };
}

/** @param {Array<Record<string, unknown>>} entries */
function authorizationBatchHash(entries) {
  return createHash('sha256')
    .update(JSON.stringify(entries.map(authorizationSnapshot).sort((left, right) => left.id.localeCompare(right.id))))
    .digest('hex')
    .slice(0, 32);
}

/** @param {Record<string, unknown>} state @param {string|Date} [now] */
export function getActiveSendAuthorization(state, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const authorizations = Array.isArray(state.sendAuthorizations) ? state.sendAuthorizations : [];
  for (const authorization of [...authorizations].reverse()) {
    if (authorization.status !== 'active') continue;
    const expiresAtMs = new Date(authorization.expiresAt || 0).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      authorization.status = 'expired';
      authorization.expiredAt = new Date(nowMs).toISOString();
      continue;
    }
    return authorization;
  }
  return null;
}

/**
 * Create a one-time authorization for an exact, already-rendered outbox batch.
 * This deliberately does not authorize guessed, private, or convention-derived addresses.
 *
 * @param {Record<string, unknown>} state
 * @param {{ entryIds: string[], account?: string, now?: string|Date, ttlMs?: number }} options
 */
export function authorizeOutreachBatch(state, options) {
  const entryIds = [...new Set((options.entryIds || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!entryIds.length) throw new Error('send authorization requires at least one outbox entry');
  if (getActiveSendAuthorization(state, options.now)) throw new Error('an outreach send authorization is already active');
  const outbox = Array.isArray(state.outbox) ? state.outbox : [];
  const entries = entryIds.map((id) => outbox.find((entry) => entry.id === id));
  if (entries.some((entry) => !entry)) throw new Error('send authorization includes an unknown outbox entry');
  const records = Array.isArray(state.records) ? state.records : [];
  for (const entry of entries) {
    if (!['pending', 'unknown'].includes(entry.status)) {
      throw new Error(`outbox entry ${entry.id} is not pending review`);
    }
    const record = records.find((candidate) => candidate.key === entry.recordKey);
    const contact = record?.contacts?.find((candidate) => candidate.id === entry.contactId);
    if (!isVerifiedContactForExplicitSend(contact)) {
      throw new Error(`outbox entry ${entry.id} does not have a verified public recipient`);
    }
    if (!asString(entry.hash) || messageFingerprint(entry.subject, entry.body) !== entry.hash) {
      throw new Error(`outbox entry ${entry.id} changed after its message was rendered`);
    }
  }
  const now = new Date(options.now || new Date());
  if (!Number.isFinite(now.getTime())) throw new Error('send authorization time is invalid');
  const snapshots = entries.map(authorizationSnapshot).sort((left, right) => left.id.localeCompare(right.id));
  const batchHash = authorizationBatchHash(snapshots);
  const authorization = {
    id: `career-ops-auth-${batchHash}`,
    status: 'active',
    account: lower(options.account),
    authorizedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Math.max(60_000, Number(options.ttlMs) || OUTREACH_AUTHORIZATION_TTL_MS)).toISOString(),
    entryIds: snapshots.map((entry) => entry.id),
    batchHash,
    entries: snapshots,
    attempts: 0,
    consumedAt: null,
  };
  if (!Array.isArray(state.sendAuthorizations)) state.sendAuthorizations = [];
  state.sendAuthorizations.push(authorization);
  return authorization;
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} entry @param {string|Date} [now] */
export function isOutboxEntryAuthorized(state, entry, now = new Date()) {
  const authorization = getActiveSendAuthorization(state, now);
  if (!authorization || !authorization.entryIds.includes(entry.id)) return false;
  const snapshot = authorization.entries?.find((candidate) => candidate.id === entry.id);
  return Boolean(snapshot)
    && JSON.stringify(authorizationSnapshot(entry)) === JSON.stringify(snapshot);
}

/** @param {Record<string, unknown>} state @param {string|Date} [now] */
export function refreshSendAuthorization(state, now = new Date()) {
  const authorization = getActiveSendAuthorization(state, now);
  if (!authorization) return null;
  const entries = (state.outbox || []).filter((entry) => authorization.entryIds.includes(entry.id));
  if (entries.length === authorization.entryIds.length
    && entries.every((entry) => ['accepted', 'blocked', 'failed'].includes(entry.status))) {
    authorization.status = 'consumed';
    authorization.consumedAt = new Date(now).toISOString();
  }
  return authorization;
}

/** @param {Record<string, unknown>} state @param {string|Date} [now] */
export function sendAuthorizationSummary(state, now = new Date()) {
  const authorization = getActiveSendAuthorization(state, now);
  if (!authorization) return null;
  const entries = (state.outbox || []).filter((entry) => authorization.entryIds.includes(entry.id));
  return {
    id: authorization.id,
    status: authorization.status,
    account: authorization.account || null,
    authorizedAt: authorization.authorizedAt,
    expiresAt: authorization.expiresAt,
    batchHash: authorization.batchHash,
    entryIds: authorization.entryIds,
    pendingCount: entries.filter((entry) => ['pending', 'unknown', 'sending'].includes(entry.status)).length,
  };
}

/** @param {number} attempts */
export function outboxRetryDelayMs(attempts) {
  return Math.min(4 * 60 * 60 * 1000, 15 * 60 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

/** @param {string|Date} value @param {number} attempts */
export function outboxNextAttemptAt(value, attempts) {
  return new Date(new Date(value).getTime() + outboxRetryDelayMs(attempts)).toISOString();
}

/** @param {Record<string, unknown>} entry @param {string|Date} [now] */
export function outboxEntryDue(entry, now = new Date()) {
  if (!['pending', 'unknown'].includes(entry.status)) return false;
  if (Number(entry.attempts || 0) >= OUTREACH_MAX_SEND_ATTEMPTS) return false;
  const nextAttemptAt = new Date(entry.nextAttemptAt || 0).getTime();
  return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= new Date(now).getTime();
}

/** @param {Record<string, unknown>} state */
export function summarizeOutbox(state) {
  const summary = { total: 0, pending: 0, sending: 0, drafting: 0, draft_created: 0, accepted: 0, unknown: 0, failed: 0, blocked: 0 };
  for (const entry of Array.isArray(state.outbox) ? state.outbox : []) {
    summary.total += 1;
    if (entry.status in summary) summary[entry.status] += 1;
  }
  return summary;
}

/** @param {Record<string, unknown>} contact @param {Record<string, unknown>} item */
function companyMatches(contact, item) {
  const contactCompany = lower(contact.company);
  const itemCompany = lower(item.company);
  if (!contactCompany || !itemCompany) return true;
  return contactCompany === itemCompany
    || contactCompany.includes(itemCompany)
    || itemCompany.includes(contactCompany);
}

/** @param {string} email */
function emailDomain(email) { return lower(email.split('@')[1] || ''); }

/** @param {Record<string, unknown>} contact */
export function hasTargetCompanyContactEvidence(contact) {
  return lower(contact.sourceType || contact.source || '') !== FIRST_PARTY_RELATIONSHIP_SOURCE
    || asString(contact.relationshipType) === 'existing_target_company_relationship';
}

/** @param {Record<string, unknown>} contact */
function contactType(contact) {
  const title = lower(contact.title);
  if (/(?:hiring\s+manager|engineering\s+manager|team\s+lead|head\s+of|director|vp\s+engineering|founder|cto)/i.test(title)) return 'hiring_manager';
  if (/(?:recruit(?:er|ing|ment)|talent\s+(?:acquisition|partner)|sourcing|people\s+partner)/i.test(title)) return 'recruiter';
  if (contact.connection === true) return 'connection';
  return 'peer';
}

/** @param {Record<string, unknown>} contact */
function contactId(contact) {
  return createHash('sha256').update([
    lower(contact.name),
    lower(contact.email),
    normalizeUrl(asString(contact.profileUrl)),
    normalizeUrl(asString(contact.xProfileUrl)),
  ].join('|')).digest('hex').slice(0, 16);
}

/** @param {Record<string, unknown>} contact @param {Record<string, unknown>} item @param {{ allowUnverifiedHypotheses?: boolean }} [options] */
function normalizeContact(contact, item, options = {}) {
  const name = asString(contact.name);
  const title = asString(contact.title);
  const email = lower(contact.email);
  const sourceUrl = normalizeUrl(asString(contact.sourceUrl || contact.emailSourceUrl));
  const profileUrl = normalizeUrl(asString(contact.profileUrl));
  const xProfileUrl = normalizeUrl(asString(contact.xProfileUrl));
  const xHandle = asString(contact.xHandle);
  const sourceType = lower(contact.sourceType || contact.source || '');
  const domain = emailDomain(email);
  const publicEvidenceEligible = Boolean(sourceUrl)
    && ['company-site', 'job-posting', 'public-profile', 'application-contact', 'user-provided'].includes(sourceType);
  const firstPartyEvidenceEligible = sourceType === FIRST_PARTY_RELATIONSHIP_SOURCE
    && asBoolean(contact.relationshipVerified)
    && hasTargetCompanyContactEvidence(contact)
    && Boolean(asString(contact.sourceMessageId));
  const hypothesisEligible = options.allowUnverifiedHypotheses === true
    && asBoolean(contact.emailHypothesis)
    && asBoolean(contact.guessed)
    && asString(contact.emailVerificationState) === 'unverified-hypothesis'
    && Number(contact.conventionSampleCount) >= 2
    && Number(contact.conventionCoverage) > 0
    && Array.isArray(contact.conventionEvidenceUrls)
    && contact.conventionEvidenceUrls.length > 0;
  const verifiedEmailEligible = Boolean(email)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && !FREE_EMAIL_DOMAINS.has(domain)
    && asBoolean(contact.emailVerified)
    && contact.publicProfessional !== false
    && contact.guessed !== true
    && contact.private !== true
    && (publicEvidenceEligible || firstPartyEvidenceEligible);
  const emailEligible = hypothesisEligible || verifiedEmailEligible;
  const relevance = lower(contact.roleRelevance || contact.relevance || 'high');
  const type = contactType(contact);
  const baseScore = type === 'hiring_manager' ? 100 : type === 'recruiter' ? 96 : type === 'connection' ? 91 : 85;
  const relevanceScore = relevance === 'high' ? 20 : relevance === 'medium' ? 10 : 0;
  const channelPriority = verifiedEmailEligible ? 4 : xProfileUrl ? 3 : emailEligible ? 2 : profileUrl ? 1 : 0;
  const primaryOutreachChannel = verifiedEmailEligible ? 'email' : xProfileUrl ? 'x' : emailEligible ? 'email' : profileUrl ? 'linkedin' : null;
  const score = baseScore + relevanceScore + (verifiedEmailEligible ? 5 : xProfileUrl ? 3 : emailEligible ? 2 : profileUrl ? 1 : 0);
  return {
    id: contactId(contact),
    name,
    title,
    company: asString(contact.company || item.company),
    email: emailEligible ? email : null,
    emailVerified: verifiedEmailEligible && asBoolean(contact.emailVerified),
    emailVerificationType: asString(contact.emailVerificationType) || (hypothesisEligible ? 'unverified-convention-hypothesis' : null),
    emailVerificationState: asString(contact.emailVerificationState) || null,
    exactEmailEvidence: asBoolean(contact.exactEmailEvidence),
    emailHypothesis: asBoolean(contact.emailHypothesis),
    guessed: asBoolean(contact.guessed),
    sendable: asBoolean(contact.sendable),
    verificationQuery: asString(contact.verificationQuery) || null,
    verificationSourceUrl: normalizeUrl(asString(contact.verificationSourceUrl)) || null,
    emailSourceUrl: sourceUrl || null,
    profileUrl: profileUrl || null,
    xProfileUrl: xProfileUrl || null,
    xHandle: xHandle || null,
    sourceUrl: sourceUrl || profileUrl || xProfileUrl || null,
    sourceType: sourceType || 'public-profile',
    roleRelevance: relevance,
    routingContact: asBoolean(contact.routingContact) || relevance === 'company',
    type,
    score,
    channelPriority,
    primaryOutreachChannel,
    emailEligible,
    relationshipType: asString(contact.relationshipType) || null,
    relationshipLabel: asString(contact.relationshipLabel) || null,
    relationshipSource: asString(contact.relationshipSource) || null,
    relationshipEvidenceUrl: normalizeUrl(asString(contact.relationshipEvidenceUrl)) || null,
    relationshipVerified: asBoolean(contact.relationshipVerified),
    connection: contact.connection === true,
    sourceMessageId: asString(contact.sourceMessageId) || null,
    sourceMailbox: asString(contact.sourceMailbox) || null,
  };
}

/** @param {Array<Record<string, unknown>>} contacts @param {Record<string, unknown>} item @param {{ allowUnverifiedHypotheses?: boolean }} [options] */
export function rankContacts(contacts, item, options = {}) {
  const normalized = contacts
    .filter((contact) => isRecord(contact)
      && asString(contact.name)
      && asString(contact.title)
      && !isProviderGeneratedContactEmail(contact.email)
      && (asString(contact.sourceUrl || contact.profileUrl)
        || (lower(contact.sourceType || contact.source || '') === FIRST_PARTY_RELATIONSHIP_SOURCE && asString(contact.sourceMessageId)))
      && hasTargetCompanyContactEvidence(contact)
      && companyMatches(contact, item)
      && lower(contact.roleRelevance || contact.relevance || 'high') !== 'low')
    .map((contact) => normalizeContact(contact, item, options));
  const deduped = new Map();
  for (const contact of normalized) {
    const key = lower(contact.email || contact.profileUrl || contact.xProfileUrl || contact.name);
    const current = deduped.get(key);
    if (!current
      || contact.channelPriority > current.channelPriority
      || (contact.channelPriority === current.channelPriority && contact.score > current.score)) {
      deduped.set(key, contact);
    }
  }
  return [...deduped.values()].sort((left, right) => (
    right.channelPriority - left.channelPriority
    || right.score - left.score
    || left.name.localeCompare(right.name)
  ));
}

/** @param {Array<Record<string, unknown>>} contacts @param {number} limit */
export function selectContacts(contacts, limit = 2) {
  const selected = [];
  const selectedIds = new Set();
  let recruiterSelected = false;
  let hiringManagerSelected = false;
  const targetLimit = Math.min(2, Math.max(1, limit));
  const ordered = [...contacts].sort((left, right) => {
    const channelPriority = (Number(right.channelPriority) || 0) - (Number(left.channelPriority) || 0);
    return channelPriority || (Number(right.score) || 0) - (Number(left.score) || 0);
  });
  const strongerChannels = ordered.filter((contact) => Number(contact.channelPriority) >= 2);
  const pool = strongerChannels.length >= targetLimit ? strongerChannels : ordered;
  for (const contact of pool) {
    if (selected.length >= targetLimit) break;
    if (contact.type === 'recruiter') {
      if (recruiterSelected) continue;
      recruiterSelected = true;
    }
    if (contact.type === 'hiring_manager') {
      if (hiringManagerSelected) continue;
      hiringManagerSelected = true;
    }
    selected.push(contact);
    selectedIds.add(contact.id);
  }
  // Channel quality outranks persona diversity. Fill remaining slots from the
  // same strongest pool before allowing a LinkedIn-only fallback.
  for (const contact of pool) {
    if (selected.length >= targetLimit) break;
    if (selectedIds.has(contact.id)) continue;
    selected.push(contact);
    selectedIds.add(contact.id);
  }
  return selected;
}

/** @param {Record<string, unknown>} item */
export function buildContactSearchQuery(item) {
  return `${asString(item.company)} ${asString(item.title)} hiring manager recruiter team`.trim();
}

/** @param {Record<string, unknown>} item */
function roleHook(item) {
  const text = lower(`${item.title} ${item.description}`);
  const hooks = [
    ['developer tooling', /developer tools?|devtools|developer experience|quality|testing|ci\/cd/],
    ['backend and API systems', /backend|back-end|api|service|serverless|distributed/],
    ['AI and agent workflows', /applied ai|genai|llm|agent|rag|copilot|machine learning/],
    ['data and analytics workflows', /data|analytics|sql|pipeline|warehouse|snowflake/],
    ['client-facing product delivery', /client|customer|solutions|forward[- ]deployed|implementation/],
    ['full-stack product engineering', /full[- ]stack|frontend|front-end|product engineer|web/],
  ];
  return hooks.find(([, pattern]) => pattern.test(text))?.[0] || 'the engineering work described in the role';
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item */
function proofPoint(profile, item) {
  const points = Array.isArray(profile.narrative?.proof_points)
    ? profile.narrative.proof_points.filter((point) => typeof point === 'string')
    : [];
  const text = lower(`${item.title} ${item.description} ${item.lane}`);
  const relevant = points.find((point) => {
    const candidate = lower(point);
    if (text.includes('data') || text.includes('analytics')) return /amazon|data|analytics|pipeline|basketball/i.test(candidate);
    if (text.includes('tool') || text.includes('platform')) return /quality|pre-cr|developer|tool|platform|amazon/i.test(candidate);
    if (text.includes('ai') || text.includes('llm') || text.includes('agent')) return /ai|tenure|bidcamp|forward|amazon/i.test(candidate);
    return /amazon|forward|tenure|bidcamp/i.test(candidate);
  });
  return relevant || points[0] || 'three Amazon SDE internships and backend, AI, and data systems I have built independently';
}

/** @param {string} value */
function lowerFirst(value) {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}

/** @param {string} value */
function terminalSentence(value) {
  const text = asString(value).replace(/[.!?]+$/g, '').trim();
  return text ? `${text}.` : '';
}

/**
 * Profile proof points are often resume-style fragments. Convert those into
 * complete prose before they reach a draft; never concatenate a raw bullet
 * after a finished sentence.
 * @param {Record<string, unknown>} profile
 * @param {Record<string, unknown>} item
 */
function proofSentence(profile, item) {
  const raw = terminalSentence(proofPoint(profile, item));
  if (!raw) return 'My background includes building reliable software systems.';
  if (/^(?:I|I['’]m|I['’]ve|My|We|The)\b/i.test(raw)) return raw;
  if (/^(?:built|created|designed|developed|implemented|launched|led|managed|provided|shipped|worked|improved)\b/i.test(raw)) {
    return terminalSentence(`I ${lowerFirst(raw)}`);
  }
  return terminalSentence(`My background includes ${lowerFirst(raw)}`);
}

/**
 * @param {Record<string, unknown>} profile
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>} contact
 * @param {'initial'|'followup'} kind
 * @param {{ variant?: number }} [options]
 */
export function buildEmailMessage(profile, item, contact, kind = 'initial', options = {}) {
  const candidateName = asString(profile.candidate?.full_name) || 'Jakye Amos';
  const company = asString(item.company) || 'your team';
  const title = asString(item.title) || 'the role';
  const hook = roleHook(item);
  const proof = proofSentence(profile, item);
  const firstName = asString(contact.name).split(/\s+/)[0] || 'there';
  const relationshipLabel = asString(contact.relationshipLabel);
  const contactRole = asString(contact.title || contact.role);
  const variant = Math.abs(Math.trunc(Number(options.variant) || 0)) % 3;
  const warmBridge = contact.connection === true && relationshipLabel
    ? /case western reserve university/i.test(relationshipLabel)
      ? 'Since we both attended Case Western Reserve University, I thought I would say hello.'
      : `Since we share ${lowerFirst(relationshipLabel)}, I thought I would say hello.`
    : '';
  const relevance = warmBridge ? relationshipLabel : hook;
  const portfolioUrl = asString(profile.candidate?.portfolio_url) || 'https://jakye.netlify.app/';
  if (kind === 'followup') {
    const subject = `Following up: ${title} at ${company}`;
    const followUpBodies = [
      `Hi ${firstName},\n\nI am following up on my application for the ${title} role at ${company}. ${warmBridge || `The role's focus on ${hook} connects with my background. ${proof}`} Happy to send anything else that would help. My work: ${portfolioUrl}\n\nThanks,\n${candidateName}`,
      `Hi ${firstName},\n\nI am following up after applying for the ${title} role at ${company}. ${contactRole ? `Given your work as ${contactRole}, I would value your perspective on what the team prioritizes.` : 'I would value your perspective on what the team prioritizes.'}\n\nMy background includes ${hook}, and I am happy to provide more context. Portfolio: ${portfolioUrl}\n\nBest,\n${candidateName}`,
      `Hi ${firstName},\n\nA quick follow-up on my application for ${title} at ${company}: ${proof} ${contactRole ? `Your perspective as ${contactRole} could help me understand the team better.` : 'Your perspective could help me understand the team better.'}\n\nExamples of my work: ${portfolioUrl}\n\nThank you,\n${candidateName}`,
    ];
    const body = followUpBodies[variant];
    const rdwRequest = buildOutreachArtifactRequest({ profile, item, contact, subject, body, relevance, proof, kind });
    return { subject, body, hash: messageFingerprint(subject, body), kind, messageVersion: OUTREACH_MESSAGE_VERSION, rdwRequest };
  }
  const initialMessages = [
    {
      subject: `Applied for ${title} at ${company}`,
      body: `Hi ${firstName},\n\n${warmBridge
        ? `I recently applied for the ${title} role at ${company}. ${warmBridge}`
        : `I applied for the ${title} role at ${company} because its focus on ${hook} lines up with the work I have been doing.`} ${proof}\n\nHappy to share more context if that would help. My work: ${portfolioUrl}\n\nThanks for taking a look,\n${candidateName}`,
    },
    {
      subject: `Question about ${title} at ${company}`,
      body: `Hi ${firstName},\n\nI recently applied for the ${title} role at ${company}. ${warmBridge || (contactRole
        ? `Your role as ${contactRole} made you seem like a good person to ask what the team values in this position.`
        : 'I thought you might be a good person to ask what the team values in this position.')}\n\n${proof} If you have a moment, I would appreciate any advice on what matters most for this team. Portfolio: ${portfolioUrl}\n\nBest,\n${candidateName}`,
    },
    {
      subject: `${title} application: ${company}`,
      body: `Hi ${firstName},\n\nI applied for ${title} at ${company}. The opportunity to work on ${hook} stood out to me. ${proof}\n\n${warmBridge || (contactRole
        ? `As ${contactRole}, you may have a useful perspective on how this work fits into the team.`
        : 'You may have a useful perspective on how this work fits into the team.')} You can see examples of my work at ${portfolioUrl}\n\nThank you,\n${candidateName}`,
    },
  ];
  const { subject, body } = initialMessages[variant];
  const rdwRequest = buildOutreachArtifactRequest({ profile, item, contact, subject, body, relevance, proof, kind });
  return { subject, body, hash: messageFingerprint(subject, body), kind, messageVersion: OUTREACH_MESSAGE_VERSION, rdwRequest };
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {Record<string, unknown>} contact @param {{ variant?: number }} [options] */
export function buildLinkedInDraft(profile, item, contact, options = {}) {
  const firstName = asString(contact.name).split(/\s+/)[0] || 'there';
  const title = asString(item.title) || 'the role';
  const company = asString(item.company).replace(/[.]+$/, '') || 'your team';
  const variant = Math.abs(Math.trunc(Number(options.variant) || 0)) % 3;
  if (contact.routingContact === true || lower(contact.roleRelevance || contact.relevance) === 'company') {
    const messages = [
      `Hi ${firstName}, I recently applied for ${title} at ${company}. I'm trying to connect with the right person on the hiring or engineering team. Would you mind pointing me in the right direction?`,
      `Hi ${firstName}, I applied for ${title} at ${company}. You may not be connected to the opening, but could you point me to someone on the hiring or engineering team?`,
      `Hi ${firstName}, I recently submitted an application for ${title} at ${company}. Could you help me find the right recruiter or engineering contact?`,
    ];
    const message = messages[variant];
    return message.length <= 300 ? message : `${message.slice(0, 297).trimEnd()}...`;
  }
  const hook = roleHook(item);
  const relationshipLabel = asString(contact.relationshipLabel);
  const bridge = contact.connection === true && relationshipLabel
    ? `We have ${lowerFirst(relationshipLabel)}, so I wanted to say hello.`
    : `I have been building ${hook} and thought the overlap was worth a note.`;
  const messages = [
    `Hi ${firstName}, I applied for ${title} at ${company}. ${bridge} I'd be interested to hear how the team approaches it.`,
    `Hi ${firstName}, I recently applied for ${title} at ${company}. Your work at ${company} made you seem like a useful person to ask what the team values most in this area.`,
    `Hi ${firstName}, I submitted an application for ${title} at ${company}. The role's focus on ${hook} overlaps with my recent work, and I would value your perspective on the team.`,
  ];
  const message = messages[variant];
  return message.length <= 300 ? message : `${message.slice(0, 297).trimEnd()}...`;
}

/** @param {string} subject @param {string} body */
export function messageFingerprint(subject, body) {
  return createHash('sha256').update(`${subject}\n${body}`).digest('hex').slice(0, 20);
}

/** @param {string} body */
function comparableOutreachContent(body) {
  return asString(body)
    .replace(/^\s*(?:hi|hello|dear)\s+[^,\n]+,?\s*/i, '')
    .replace(/https?:\/\/\S+/gi, '<link>')
    .toLowerCase()
    .replace(/[^a-z0-9<>]+/g, ' ')
    .trim();
}

/** @param {string} value */
function wordTrigrams(value) {
  const words = comparableOutreachContent(value).split(/\s+/).filter(Boolean);
  if (words.length < 3) return new Set(words);
  return new Set(words.slice(0, -2).map((word, index) => `${word} ${words[index + 1]} ${words[index + 2]}`));
}

/**
 * Compare two recipient-facing drafts after removing the salutation and URL.
 * A score near 1 means the recipients would see effectively the same copy.
 * @param {string} left
 * @param {string} right
 */
export function outreachContentSimilarity(left, right) {
  const leftShingles = wordTrigrams(left);
  const rightShingles = wordTrigrams(right);
  if (!leftShingles.size || !rightShingles.size) return 0;
  let overlap = 0;
  for (const shingle of leftShingles) if (rightShingles.has(shingle)) overlap += 1;
  return (2 * overlap) / (leftShingles.size + rightShingles.size);
}

/**
 * Rewrite later recipients when they would receive substantially the same
 * copy. Multiple contacts at one company remain eligible, but salutation-only
 * variants are iterated into meaningfully different messages first.
 * @param {Array<Record<string, unknown>>} contacts
 * @param {(contact: Record<string, unknown>, context: { attempt: number, index: number, collision: Record<string, unknown> }) => Record<string, unknown>} rewrite
 */
export function iterateRecipientContentCollisions(contacts, rewrite) {
  const earlierDrafts = [];
  return contacts.map((contact, index) => {
    let candidate = contact;
    let initial = isRecord(candidate.initial) ? candidate.initial : {};
    if (candidate.emailEligible !== true || !asString(initial.body)) return candidate;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const collision = earlierDrafts.find((earlier) => outreachContentSimilarity(asString(earlier.initial.body), asString(initial.body)) >= 0.9);
      if (!collision || ['sent', 'draft_created'].includes(asString(initial.status))) break;
      const rewritten = rewrite(candidate, { attempt, index, collision });
      if (!isRecord(rewritten) || !isRecord(rewritten.initial) || !asString(rewritten.initial.body)) break;
      candidate = rewritten;
      initial = rewritten.initial;
    }
    const unresolved = earlierDrafts.find((earlier) => outreachContentSimilarity(asString(earlier.initial.body), asString(initial.body)) >= 0.9);
    if (unresolved && !['sent', 'draft_created'].includes(asString(initial.status))) {
      candidate = {
        ...candidate,
        initial: {
          ...initial,
          status: 'blocked_content_review',
          validationError: `Automatic contact-specific rewriting remained too similar to the message for ${asString(unresolved.name)}.`,
          outboxId: null,
        },
      };
    }
    earlierDrafts.push(candidate);
    return candidate;
  });
}

/** @param {string} subject @param {string} body */
export function validateMessage(subject, body) {
  const reasons = [];
  if (!asString(subject) || !asString(body)) reasons.push('message is empty');
  if (BLOCKED_MESSAGE_RE.test(`${subject}\n${body}`)) reasons.push('message contains blocked personal or graduation-status wording');
  if (body.length > 1800) reasons.push('message exceeds the email body limit');
  if (!/https:\/\//i.test(body)) reasons.push('message is missing an approved proof link');
  const sentences = asString(body).split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.some((sentence, index) => index > 0
    && PROOF_FRAGMENT_START_RE.test(sentence)
    && !FINITE_VERB_RE.test(sentence))) {
    reasons.push('message contains a standalone proof-point fragment');
  }
  return { ok: reasons.length === 0, reasons };
}

/** @param {string|Date} value @param {number} businessDays */
export function addBusinessDays(value, businessDays) {
  const date = new Date(value);
  let remaining = Math.max(0, Math.round(businessDays));
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString();
}

/** @param {string|Date} value */
export function dayKey(value = new Date()) { return new Date(value).toISOString().slice(0, 10); }

/** @param {Record<string, unknown>} state @param {'initial'|'followup'} kind @param {string|Date} [date] */
export function countSentForDay(state, kind, date = new Date()) {
  const day = dayKey(date);
  return (state.records || []).reduce((count, record) => count + (record.contacts || []).reduce((inner, contact) => {
    const event = kind === 'initial' ? contact.initial : contact.followUp;
    return inner + (event?.status === 'sent' && dayKey(event.sentAt) === day ? 1 : 0);
  }, 0), 0);
}

/** @param {Record<string, unknown>} record @param {Record<string, unknown>} contact */
export function followUpSuppressed(record, contact) {
  return record.status === 'paused'
    || record.status === 'suppressed'
    || record.roleClosed === true
    || contact.replied === true
    || contact.bounced === true
    || contact.optedOut === true
    || contact.rejected === true;
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} message */
export function messageForSend(item, message) {
  const to = lower(message.to);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('outreach recipient email is invalid');
  const subject = asString(message.subject);
  const body = asMessageBody(message.body);
  const hash = asString(message.hash);
  if (!hash || messageFingerprint(subject, body) !== hash) throw new Error('outreach message changed after rendering');
  const validation = validateMessage(subject, body);
  if (!validation.ok) throw new Error(`outreach message blocked for ${asString(item.title)}: ${validation.reasons.join('; ')}`);
  const draftQuality = isRecord(message.draftQuality) ? message.draftQuality : null;
  const qualityValidation = validateOutreachDraftReceipt({ channel: 'email', subject, body, receipt: draftQuality });
  if (!qualityValidation.ok) throw new Error(`outreach message blocked by Humanizer/quality gate: ${qualityValidation.reasons.join('; ')}`);
  const rdwRequest = isRecord(message.rdwRequest) ? message.rdwRequest : null;
  const rdwReceipt = isRecord(message.rdwReceipt) ? message.rdwReceipt : null;
  if (message.messageVersion === OUTREACH_MESSAGE_VERSION || rdwRequest || rdwReceipt) {
    if (!rdwRequest || !rdwReceipt) throw new Error('outreach message is missing its RDW request or quality receipt');
    const rdwValidation = validateRdwArtifactReceipt(rdwRequest, rdwReceipt);
    if (!rdwValidation.ok) throw new Error(`outreach message blocked by RDW: ${rdwValidation.reasons.join('; ')}`);
  }
  return { to, subject, body, hash, messageVersion: message.messageVersion, rdwRequest, rdwReceipt, draftQuality };
}

/** @param {string} value @param {string} combined */
function containsApplicationIdentity(value, combined) {
  const normalized = lower(value);
  if (!normalized) return false;
  if (combined.includes(normalized)) return true;
  try {
    const url = new URL(value);
    return url.pathname.split(/[^a-z0-9]+/i).some((token) => token.length >= 6 && combined.includes(token.toLowerCase()));
  } catch {
    return false;
  }
}

/** @param {string} subject @param {string} from @param {string} body @param {Record<string, unknown>} item @param {{ applicationUrl?: string, submissionId?: string }} [identity] */
export function matchesApplicationConfirmation(subject, from, body, item, identity = {}) {
  const combined = lower(`${subject} ${from} ${body}`);
  if (!CONFIRMATION_RE.test(combined)) return false;
  const company = lower(item.company);
  if (!company || AGGREGATE_COMPANY_RE.test(company)) return false;
  const companyPhrase = company.replace(/[^a-z0-9]+/g, ' ').trim();
  const companyTokens = company.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !['inc', 'llc', 'corp', 'company', ...COMPANY_STOPWORDS].includes(token));
  const companyMatch = (companyPhrase && combined.includes(companyPhrase)) || companyTokens.some((token) => combined.includes(token));
  if (!companyMatch) return false;
  if (containsApplicationIdentity(identity.submissionId || '', combined)
    || containsApplicationIdentity(identity.applicationUrl || '', combined)) return true;
  const title = lower(item.title);
  const titlePhrase = title.replace(/[^a-z0-9]+/g, ' ').trim();
  if (titlePhrase && combined.includes(titlePhrase)) return true;
  const titleTokens = title.split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !TITLE_STOPWORDS.has(token));
  return titleTokens.length > 0 && titleTokens.every((token) => combined.includes(token));
}

/** @param {Record<string, unknown>} state @param {string} key */
export function findOutreachRecord(state, key) {
  return (state.records || []).find((record) => record.key === key || record.itemId === key) || null;
}
