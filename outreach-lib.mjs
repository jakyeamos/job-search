// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  applicationKey,
  normalizeText,
  normalizeUrl,
} from './queue-lib.mjs';

export const OUTREACH_SCHEMA_VERSION = 2;
export const OUTREACH_STATE_PATH = 'data/outreach-state.json';
export const OUTREACH_CONTACTS_PATH = 'data/outreach-contacts.json';
export const OUTREACH_MAX_SEND_ATTEMPTS = 3;
export const OUTREACH_SEND_STALE_MS = 15 * 60 * 1000;
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
const CONFIRMATION_RE = /(?:application\s+(?:was\s+)?(?:received|submitted)|thank\s+you\s+for\s+applying|thanks\s+for\s+applying|we['’]?ve\s+received\s+your\s+application|successfully\s+applied)/i;
const TITLE_STOPWORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'the', 'to', 'with', 'software', 'engineer', 'developer']);
const COMPANY_STOPWORDS = new Set(['and', 'more', 'jobs', 'job', 'for', 'you', 'apply', 'now', 'new', 'york', 'your']);
const AGGREGATE_COMPANY_RE = /\band\s+\d+\s+more\b|\b\d+\s+more\s+jobs?\b|\bfor\s+you\b|\bapply\s+now\b/i;
const BLOCKED_MESSAGE_RE = /(?:\+?1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|expected\s+(?:(?:may|spring|fall|summer|winter)\s+)?20\d{2}|(?:spring|fall|summer|winter)\s+20\d{2}|\btwo\s+courses?\s+remaining\b)/i;
const FIRST_PARTY_RELATIONSHIP_SOURCE = 'first-party-relationship';

/** @param {string} value */
function lower(value) { return normalizeText(value).toLowerCase(); }

/** @param {unknown} value */
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/** @param {unknown} value */
function asString(value) { return typeof value === 'string' ? normalizeText(value) : ''; }

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
  return {
    ...record,
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
    path: file,
  };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      schemaVersion: OUTREACH_SCHEMA_VERSION,
      records: Array.isArray(parsed?.records) ? parsed.records.filter(isRecord).map(migrateRecord) : [],
      settings: isRecord(parsed?.settings) ? parsed.settings : {},
      scan: isRecord(parsed?.scan) ? parsed.scan : {},
      outbox: Array.isArray(parsed?.outbox) ? parsed.outbox.filter(isRecord) : [],
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

/** @param {Record<string, unknown>} state @param {{ recordKey: string, contactId: string, kind: 'initial'|'followup', to: string, subject: string, body: string, hash: string, now?: string }} payload */
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
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    lastError: null,
    gmailMessageId: null,
    threadId: null,
    providerStatus: null,
  };
  state.outbox.push(entry);
  return entry;
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
  const summary = { total: 0, pending: 0, sending: 0, accepted: 0, unknown: 0, failed: 0, blocked: 0 };
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
  ].join('|')).digest('hex').slice(0, 16);
}

/** @param {Record<string, unknown>} contact @param {Record<string, unknown>} item */
function normalizeContact(contact, item) {
  const name = asString(contact.name);
  const title = asString(contact.title);
  const email = lower(contact.email);
  const sourceUrl = normalizeUrl(asString(contact.sourceUrl || contact.emailSourceUrl));
  const profileUrl = normalizeUrl(asString(contact.profileUrl));
  const sourceType = lower(contact.sourceType || contact.source || '');
  const domain = emailDomain(email);
  const publicEvidenceEligible = Boolean(sourceUrl)
    && ['company-site', 'job-posting', 'public-profile', 'application-contact', 'user-provided'].includes(sourceType);
  const firstPartyEvidenceEligible = sourceType === FIRST_PARTY_RELATIONSHIP_SOURCE
    && asBoolean(contact.relationshipVerified)
    && Boolean(asString(contact.sourceMessageId));
  const emailEligible = Boolean(email)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && !FREE_EMAIL_DOMAINS.has(domain)
    && asBoolean(contact.emailVerified)
    && contact.publicProfessional !== false
    && contact.guessed !== true
    && contact.private !== true
    && (publicEvidenceEligible || firstPartyEvidenceEligible);
  const relevance = lower(contact.roleRelevance || contact.relevance || 'high');
  const type = contactType(contact);
  const baseScore = type === 'hiring_manager' ? 100 : type === 'recruiter' ? 96 : type === 'connection' ? 91 : 85;
  const relevanceScore = relevance === 'high' ? 20 : relevance === 'medium' ? 10 : 0;
  const score = baseScore + relevanceScore + (emailEligible ? 5 : 0) + (profileUrl ? 2 : 0);
  return {
    id: contactId(contact),
    name,
    title,
    company: asString(contact.company || item.company),
    email: emailEligible ? email : null,
    emailVerified: emailEligible,
    emailSourceUrl: sourceUrl || null,
    profileUrl: profileUrl || null,
    sourceUrl: sourceUrl || profileUrl || null,
    sourceType: sourceType || 'public-profile',
    roleRelevance: relevance,
    type,
    score,
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

/** @param {Array<Record<string, unknown>>} contacts @param {Record<string, unknown>} item */
export function rankContacts(contacts, item) {
  const normalized = contacts
    .filter((contact) => isRecord(contact)
      && asString(contact.name)
      && asString(contact.title)
      && (asString(contact.sourceUrl || contact.profileUrl)
        || (lower(contact.sourceType || contact.source || '') === FIRST_PARTY_RELATIONSHIP_SOURCE && asString(contact.sourceMessageId)))
      && companyMatches(contact, item)
      && lower(contact.roleRelevance || contact.relevance || 'high') !== 'low')
    .map((contact) => normalizeContact(contact, item));
  const deduped = new Map();
  for (const contact of normalized) {
    const key = lower(contact.email || contact.profileUrl || contact.name);
    const current = deduped.get(key);
    if (!current || contact.score > current.score) deduped.set(key, contact);
  }
  return [...deduped.values()].sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

/** @param {Array<Record<string, unknown>>} contacts @param {number} limit */
export function selectContacts(contacts, limit = 2) {
  const selected = [];
  let recruiterSelected = false;
  let hiringManagerSelected = false;
  const ordered = [...contacts].sort((left, right) => {
    const emailPriority = Number(right.emailEligible === true) - Number(left.emailEligible === true);
    return emailPriority || (Number(right.score) || 0) - (Number(left.score) || 0);
  });
  for (const contact of ordered) {
    if (selected.length >= Math.min(2, Math.max(1, limit))) break;
    if (contact.type === 'recruiter') {
      if (recruiterSelected) continue;
      recruiterSelected = true;
    }
    if (contact.type === 'hiring_manager') {
      if (hiringManagerSelected) continue;
      hiringManagerSelected = true;
    }
    selected.push(contact);
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

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {Record<string, unknown>} contact @param {'initial'|'followup'} kind */
export function buildEmailMessage(profile, item, contact, kind = 'initial') {
  const candidateName = asString(profile.candidate?.full_name) || 'Jakye Amos';
  const company = asString(item.company) || 'your team';
  const title = asString(item.title) || 'the role';
  const hook = roleHook(item);
  const proof = proofPoint(profile, item);
  const firstName = asString(contact.name).split(/\s+/)[0] || 'there';
  const relationshipLabel = asString(contact.relationshipLabel);
  const warmBridge = contact.connection === true && relationshipLabel
    ? `Because of our ${relationshipLabel.toLowerCase()}, I wanted to reach out directly.`
    : '';
  if (kind === 'followup') {
    const subject = `Following up — ${title} at ${company}`;
    const body = `Hi ${firstName},\n\nJust following up on my application for the ${title} role at ${company}. ${warmBridge || `The work around ${hook} is especially close to ${proof.toLowerCase().replace(/[.]$/, '')}.`} Happy to send anything else that would be useful.\n\nThanks,\n${candidateName}`;
    return { subject, body, hash: messageHash(subject, body), kind };
  }
  const subject = `Applied for ${title} at ${company}`;
  const opening = warmBridge
    ? `I recently applied for the ${title} role at ${company}. ${warmBridge}`
    : `I applied for the ${title} role at ${company} and wanted to reach out because the focus on ${hook} lines up with the work I have been doing.`;
  const body = `Hi ${firstName},\n\n${opening} ${proof}.\n\nI would be glad to share more context if useful. My work is here: ${asString(profile.candidate?.portfolio_url) || 'https://jakye.netlify.app/'}\n\nThanks for taking a look,\n${candidateName}`;
  return { subject, body, hash: messageHash(subject, body), kind };
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {Record<string, unknown>} contact */
export function buildLinkedInDraft(profile, item, contact) {
  const firstName = asString(contact.name).split(/\s+/)[0] || 'there';
  const title = asString(item.title) || 'the role';
  const company = asString(item.company).replace(/[.]+$/, '') || 'your team';
  const hook = roleHook(item);
  const relationshipLabel = asString(contact.relationshipLabel);
  const bridge = contact.connection === true && relationshipLabel
    ? `We have an existing ${relationshipLabel.toLowerCase()}, so I wanted to say hello.`
    : `I have been building ${hook} and thought the overlap was worth a note.`;
  const message = `Hi ${firstName} — I applied for ${title} at ${company}. ${bridge} I would enjoy hearing how the team approaches it.`;
  return message.length <= 300 ? message : `${message.slice(0, 297).trimEnd()}...`;
}

/** @param {string} subject @param {string} body */
function messageHash(subject, body) {
  return createHash('sha256').update(`${subject}\n${body}`).digest('hex').slice(0, 20);
}

/** @param {string} subject @param {string} body */
export function validateMessage(subject, body) {
  const reasons = [];
  if (!asString(subject) || !asString(body)) reasons.push('message is empty');
  if (BLOCKED_MESSAGE_RE.test(`${subject}\n${body}`)) reasons.push('message contains blocked personal or graduation-status wording');
  if (body.length > 1800) reasons.push('message exceeds the email body limit');
  if (!/https:\/\//i.test(body)) reasons.push('message is missing an approved proof link');
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
  const validation = validateMessage(asString(message.subject), asString(message.body));
  if (!validation.ok) throw new Error(`outreach message blocked for ${asString(item.title)}: ${validation.reasons.join('; ')}`);
  return { to, subject: asString(message.subject), body: asString(message.body), hash: asString(message.hash) };
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
