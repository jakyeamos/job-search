#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GmailClientError,
  TARGET_GMAIL_ACCOUNT,
  createGmailClient,
} from './gmail-client.mjs';
import {
  discoverContactsForApplication,
  isDiscoverableApplication,
  verifyPublicCandidateEmails,
  verifyPublicCandidateXProfiles,
} from './contact-discovery.mjs';
import { discoverWarmContactsForApplication } from './relationship-discovery.mjs';
import { getMessageBody, isAuthenticEmail } from './plugins/gmail/_helpers.mjs';
import { loadDotenvOnce } from './plugins/_engine.mjs';
import { runRdwArtifactCheck } from './rdw-writing.mjs';
import { prepareOutreachDraft, validateOutreachDraftReceipt } from './outreach-draft-quality.mjs';
import { loadReconciledApplications } from './application-evidence.mjs';
import { syncPreparedXOutreachDrafts } from './x-outreach-outbox.mjs';
import {
  DEFAULT_CONTACT_DISCOVERY_LIMIT,
  applicationKey,
  loadProfile,
  readQueueState,
  renderQueueMarkdown,
  writeQueueState,
} from './queue-lib.mjs';
import {
  OUTREACH_CONTACTS_PATH,
  OUTREACH_DISCOVERY_PIPELINE_VERSION,
  OUTREACH_MESSAGE_VERSION,
  OUTREACH_STATE_PATH,
  OUTREACH_MAX_SEND_ATTEMPTS,
  OUTREACH_SEND_STALE_MS,
  addBusinessDays,
  buildContactSearchQuery,
  buildEmailMessage,
  buildLinkedInDraft,
  discoveryCacheTtlMs,
  ensureOutboxEntry,
  findOutreachRecord,
  followUpSuppressed,
  hasConfirmedSubmission,
  hasTargetCompanyContactEvidence,
  isVerifiedContactForExplicitSend,
  iterateRecipientContentCollisions,
  loadOutreachPolicy,
  loadOutreachState,
  matchesApplicationConfirmation,
  messageFingerprint,
  messageForSend,
  outboxEntryDue,
  outboxNextAttemptAt,
  rankContacts,
  retainDiscoveryContacts,
  saveOutreachState,
  selectContacts,
  summarizeOutbox,
  upsertSubmissionSignal,
} from './outreach-lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');
const QUEUE_MARKDOWN_PATH = path.join(ROOT, 'data', 'job-queue.md');
const APPLICATION_RUNS_PATH = path.join(ROOT, 'data', 'application-runs.json');
const STATE_PATH = path.join(ROOT, OUTREACH_STATE_PATH);
const CONTACTS_PATH = path.join(ROOT, OUTREACH_CONTACTS_PATH);
const CONFIRMATION_QUERY = 'in:anywhere {subject:"application received" subject:"thank you for applying" subject:"thanks for applying" subject:"application submitted" subject:"we received your application"} newer_than:30d';

function loadApplicationUniverse() {
  const queue = readQueueState(QUEUE_PATH);
  const queuedItems = Array.isArray(queue.items) ? queue.items : [];
  const reconciled = loadReconciledApplications(ROOT, queuedItems);
  return { queue, items: reconciled.items, evidenceAudit: reconciled.audit };
}

/** @param {unknown} value */
function recordObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @typedef {{
 *  verifyAccount: () => Promise<string>,
 *  listMessages: (query: string, options?: { limit?: number }) => Promise<Array<{ id: string, threadId?: string }>>,
 *  getMessage: (id: string, format?: string) => Promise<Record<string, unknown>>,
 *  listDrafts: (options?: { limit?: number }) => Promise<Array<{ id: string, message?: { id?: string, threadId?: string } }>>,
 *  getDraft: (id: string, format?: string) => Promise<Record<string, unknown>>,
 *  createDraft: (message: { to: string, subject: string, body: string, threadId?: string, headers?: Record<string, string> }) => Promise<Record<string, unknown>>,
 *  updateDraft?: (id: string, message: { to: string, subject: string, body: string, threadId?: string, headers?: Record<string, string> }) => Promise<Record<string, unknown>>,
 *  sendMessage: (message: { to: string, subject: string, body: string, threadId?: string, headers?: Record<string, string> }) => Promise<Record<string, unknown>>,
 * }} RelationshipClient */

/** @param {string[]} args @param {string} flag @param {string} fallback */
function readFlag(args, flag, fallback = '') {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

/** @param {string[]} args @param {string} flag */
function hasFlag(args, flag) { return args.includes(flag); }

/** @param {string} file */
function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** @returns {Array<Record<string, unknown>>} */
function loadContactManifest() {
  const parsed = readJson(CONTACTS_PATH);
  if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === 'object');
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.applications)) {
    return parsed.applications.filter((item) => item && typeof item === 'object');
  }
  return [];
}

/** @param {Record<string, unknown>} item @param {Array<Record<string, unknown>>} manifest */
function contactsForItem(item, manifest) {
  const key = applicationKey(item);
  const match = manifest.find((entry) => {
    const entryKey = String(entry.applicationKey || entry.key || '');
    if (entryKey && (entryKey === key || entryKey === item.id)) return true;
    return String(entry.company || '').toLowerCase() === String(item.company || '').toLowerCase()
      && String(entry.title || '').toLowerCase() === String(item.title || '').toLowerCase();
  });
  const embedded = Array.isArray(item.outreach?.contacts) ? item.outreach.contacts : [];
  return Array.isArray(match?.contacts) ? match.contacts : embedded;
}

/** @param {unknown} previous @param {unknown} fresh @param {string} key */
function mergeDiscoveryEvidence(previous, fresh, key) {
  const merged = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(fresh) ? fresh : [])]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const identity = String(value[key] || '');
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    merged.push(value);
  }
  return merged;
}

/**
 * Render and validate one initial message variant. Every rewrite receives a
 * fresh RDW receipt and fingerprint for the exact revised copy.
 * @param {Record<string, unknown>} profile
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>} contact
 * @param {number} variant
 */
function renderInitialDraft(profile, item, contact, variant = 0) {
  const rendered = buildEmailMessage(profile, item, contact, 'initial', { variant });
  let prepared = rendered;
  try {
    const quality = prepareOutreachDraft({
      channel: 'email',
      subject: rendered.subject,
      body: rendered.body,
      contactName: String(contact.name || ''),
      company: String(item.company || ''),
    });
    if (!quality.receipt.passed) {
      throw new Error(`Humanizer/quality gate failed: ${quality.receipt.quality.errors.join('; ') || quality.receipt.humanizer.errors.join('; ')}`);
    }
    const rdwRequest = {
      ...recordObject(rendered.rdwRequest),
      content: {
        ...recordObject(recordObject(rendered.rdwRequest).content),
        subject: quality.subject,
        body: quality.body,
      },
    };
    prepared = {
      ...rendered,
      subject: quality.subject,
      body: quality.body,
      hash: messageFingerprint(quality.subject, quality.body),
      rdwRequest,
      draftQuality: quality.receipt,
    };
    const rdwReceipt = runRdwArtifactCheck(recordObject(prepared.rdwRequest));
    const validated = { ...prepared, rdwReceipt };
    messageForSend(item, { to: contact.email, ...validated });
    return {
      ...validated,
      messageVersion: OUTREACH_MESSAGE_VERSION,
      status: 'pending',
      validationError: null,
      sentAt: null,
      gmailMessageId: null,
      threadId: null,
      outboxId: null,
    };
  } catch (error) {
    return {
      ...prepared,
      messageVersion: OUTREACH_MESSAGE_VERSION,
      status: 'blocked_content_review',
      validationError: error instanceof Error ? error.message : String(error),
      sentAt: null,
      gmailMessageId: null,
      threadId: null,
      outboxId: null,
    };
  }
}

/** @param {'linkedin'|'x'} channel @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {Record<string, unknown>} contact @param {number} variant */
function renderSocialDraft(channel, profile, item, contact, variant) {
  const raw = buildLinkedInDraft(profile, item, contact, { variant });
  const prepared = prepareOutreachDraft({
    channel,
    body: raw,
    contactName: String(contact.name || ''),
    company: String(item.company || ''),
  });
  if (!prepared.receipt.passed) {
    return {
      body: '',
      receipt: prepared.receipt,
      error: `Humanizer/quality gate failed: ${prepared.receipt.quality.errors.join('; ') || prepared.receipt.humanizer.errors.join('; ')}`,
    };
  }
  return { body: prepared.body, receipt: prepared.receipt, error: null };
}

/** @param {Record<string, unknown>} record @param {Record<string, unknown>} item @param {Record<string, unknown>} profile */
function differentiateRecipientDrafts(record, item, profile) {
  record.contacts = iterateRecipientContentCollisions(record.contacts || [], (contact, context) => {
    const outreachVariant = Number(contact.outreachVariant || 0) + context.attempt;
    return {
      ...contact,
      outreachVariant,
      initial: renderInitialDraft(profile, item, contact, outreachVariant),
    };
  });
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {boolean} dryRun @param {Array<Record<string, unknown>>} [discoveredContacts] @param {Array<Record<string, unknown>>} [discoveredHypotheses] */
function prepareRecord(state, item, dryRun, discoveredContacts = [], discoveredHypotheses = []) {
  const record = upsertSubmissionSignal(state, item, {
    source: 'queue_applied',
    at: item.appliedAt || new Date().toISOString(),
  });
  if (record.status === 'needs_application_identity') return record;
  const profile = loadProfile(ROOT);
  const policy = loadOutreachPolicy(profile);
  const persistedContacts = Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [];
  record.discoveredContacts = persistedContacts.filter((contact) => hasTargetCompanyContactEvidence(recordObject(contact)));
  const importedContacts = Array.isArray(item.outreach?.discovery?.contacts) ? item.outreach.discovery.contacts : [];
  const importedHypotheses = Array.isArray(item.outreach?.discovery?.emailHypotheses) ? item.outreach.discovery.emailHypotheses : [];
  const contacts = selectContacts(rankContacts([
    ...contactsForItem(item, loadContactManifest()),
    ...persistedContacts,
    ...discoveredContacts,
    ...importedContacts,
    ...discoveredHypotheses,
    ...importedHypotheses,
  ], item, { allowUnverifiedHypotheses: policy.requireVerifiedPublicEmail === false }), policy.maxContactsPerApplication);
  const existing = new Map((record.contacts || []).map((contact) => [contact.id, contact]));
  record.contacts = contacts.map((contact, recipientIndex) => {
    const old = existing.get(contact.id);
    const outreachVariant = Number.isFinite(Number(old?.outreachVariant))
      ? Number(old.outreachVariant)
      : recipientIndex;
    const generatedInitial = contact.emailEligible
      ? renderInitialDraft(profile, item, contact, outreachVariant)
      : { status: 'no_verified_email', subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null, threadId: null, outboxId: null };
    const existingInitialStatus = String(old?.initial?.status || '');
    const oldQuality = old?.initial ? validateOutreachDraftReceipt({
      channel: 'email',
      subject: String(old.initial.subject || ''),
      body: String(old.initial.body || ''),
      receipt: old.initial.draftQuality,
    }) : { ok: false };
    const providerDraftCurrent = existingInitialStatus === 'draft_created'
      && old?.initial?.messageVersion === OUTREACH_MESSAGE_VERSION
      && oldQuality.ok
      && old.initial.hash === generatedInitial.hash;
    let initial = generatedInitial;
    if (old?.initial && existingInitialStatus === 'sent') {
      initial = { ...generatedInitial, ...old.initial };
    } else if (old?.initial && providerDraftCurrent) {
      initial = { ...generatedInitial, ...old.initial };
    } else if (old?.initial && existingInitialStatus === 'draft_created') {
      initial = {
        ...generatedInitial,
        status: 'draft_update_pending',
        deliveryStatus: 'gmail_draft_update_pending',
        gmailDraftId: old.initial.gmailDraftId || null,
        gmailMessageId: old.initial.gmailMessageId || null,
        threadId: old.initial.threadId || null,
        outboxId: old.initial.outboxId || null,
      };
    } else if (old?.initial && old.initial.messageVersion === OUTREACH_MESSAGE_VERSION) {
      initial = { ...generatedInitial, ...old.initial };
    }
    const followUp = old?.followUp
      ? { status: 'not_scheduled', dueAt: null, subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null, threadId: null, outboxId: null, ...old.followUp }
      : { status: 'not_scheduled', dueAt: null, subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null, threadId: null, outboxId: null };
    const linkedin = renderSocialDraft('linkedin', profile, item, contact, outreachVariant);
    const x = contact.xProfileUrl
      ? renderSocialDraft('x', profile, item, contact, outreachVariant)
      : { body: '', receipt: null, error: null };
    return {
      ...contact,
      outreachVariant,
      profileUrl: contact.profileUrl,
      xProfileUrl: contact.xProfileUrl,
      xHandle: contact.xHandle,
      linkedinDraft: linkedin.body,
      linkedinDraftQuality: linkedin.receipt,
      linkedinDraftError: linkedin.error,
      xDraft: x.body,
      xDraftQuality: x.receipt,
      xDraftError: x.error,
      initial,
      followUp,
      replied: old?.replied === true,
      bounced: old?.bounced === true,
      optedOut: old?.optedOut === true,
      responseMessageId: old?.responseMessageId || null,
    };
  });
  differentiateRecipientDrafts(record, item, profile);
  record.searchQuery = buildContactSearchQuery(item);
  if (!hasConfirmedSubmission(record)) record.status = 'awaiting_submission_confirmation';
  else if (record.contacts.length) record.status = 'drafted';
  else record.status = 'awaiting_contacts';
  record.updatedAt = new Date().toISOString();
  if (!dryRun) {
    saveOutreachState(STATE_PATH, state);
    if (hasConfirmedSubmission(record)) {
      syncPreparedXOutreachDrafts({
        company: item.company,
        role: item.title,
        contacts: record.contacts,
      });
    }
  }
  return record;
}

/**
 * @param {Record<string, unknown>} record
 * @param {Record<string, unknown>} item
 * @param {boolean} dryRun
 * @param {{
 *   gmailClient?: RelationshipClient | null,
 *   force?: boolean,
 *   sourceState?: { publicSearchUnavailableReason?: string },
 *   allowMissingPostingUrl?: boolean,
 * }} [options]
 */
async function discoverForRecord(record, item, dryRun, options = {}) {
  const allowMissingPostingUrl = options.allowMissingPostingUrl === true;
  if (record.status === 'paused'
    || record.status === 'suppressed'
    || (record.status === 'needs_application_identity' && !allowMissingPostingUrl)) {
    return { status: 'skipped', reason: `record status is ${record.status}`, contacts: [], emailConventions: [], emailHypotheses: [], emailVerification: [], candidateEmailVerification: [], candidateXVerification: [], sources: [], queries: [], errors: [] };
  }
  if (!isDiscoverableApplication(item, { allowMissingPostingUrl })) {
    record.status = 'needs_application_identity';
    record.suppressionReason = 'application evidence does not identify a specific employer';
    record.discovery = {
      status: 'blocked',
      attemptedAt: new Date().toISOString(),
      candidateCount: 0,
      sourceCount: 0,
      reason: 'application identity is not specific enough for contact discovery',
    };
    return { status: 'blocked', reason: 'application identity is not specific enough for contact discovery', contacts: [], emailConventions: [], emailHypotheses: [], emailVerification: [], candidateEmailVerification: [], candidateXVerification: [], sources: [], queries: [], errors: [] };
  }
  if (record.status === 'needs_application_identity') {
    record.status = 'awaiting_contacts';
    record.suppressionReason = null;
  }
  const attemptedAt = String(record.discovery?.attemptedAt || '');
  const attemptedAtMs = new Date(attemptedAt).getTime();
  const legacyExpiry = Number.isFinite(attemptedAtMs)
    ? attemptedAtMs + discoveryCacheTtlMs(String(record.discovery?.status || 'error'), Number(record.discovery?.candidateCount || 0))
    : 0;
  const cacheExpiresAtMs = new Date(record.discovery?.cacheExpiresAt || legacyExpiry || 0).getTime();
  if (Number.isFinite(cacheExpiresAtMs)
    && cacheExpiresAtMs > Date.now()
    && record.discovery?.pipelineVersion === OUTREACH_DISCOVERY_PIPELINE_VERSION
    && options.force !== true
    && Array.isArray(record.discoveredContacts)) {
    return {
      status: String(record.discovery?.status || 'cached'),
      reason: `cached until ${new Date(cacheExpiresAtMs).toISOString()}`,
      contacts: [
        ...record.discoveredContacts,
        ...(Array.isArray(record.discovery?.emailHypotheses)
          ? record.discovery.emailHypotheses.filter((hypothesis) => hypothesis.sendable === true)
          : []),
      ],
      emailConventions: Array.isArray(record.discovery?.emailConventions) ? record.discovery.emailConventions : [],
      emailHypotheses: Array.isArray(record.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [],
      emailVerification: Array.isArray(record.discovery?.emailVerification) ? record.discovery.emailVerification : [],
      candidateEmailVerification: Array.isArray(record.discovery?.candidateEmailVerification) ? record.discovery.candidateEmailVerification : [],
      candidateXVerification: Array.isArray(record.discovery?.candidateXVerification) ? record.discovery.candidateXVerification : [],
      sources: Array.isArray(record.discovery?.sources) ? record.discovery.sources : [],
      queries: Array.isArray(record.discovery?.queries) ? record.discovery.queries : [],
      errors: Array.isArray(record.discovery?.errors) ? record.discovery.errors : [],
      warnings: Array.isArray(record.discovery?.warnings) ? record.discovery.warnings : [],
    };
  }
  const publicResult = await discoverContactsForApplication(item, {
    dryRun,
    sourceState: options.sourceState,
    allowMissingPostingUrl,
  });
  const warmResult = await discoverWarmContactsForApplication(item, loadProfile(ROOT), {
    dryRun,
    gmailClient: options.gmailClient || null,
    sourceState: options.sourceState,
  });
  const candidateEmailResult = warmResult.contacts?.length && !options.sourceState?.publicSearchUnavailableReason
    ? await verifyPublicCandidateEmails(
      warmResult.contacts.filter((contact) => !String(contact.email || '').trim()),
      item,
    )
    : { contacts: [], queries: [], sources: [], verifications: [], errors: [] };
  const candidateXResult = warmResult.contacts?.length && !options.sourceState?.publicSearchUnavailableReason
    ? await verifyPublicCandidateXProfiles(
      warmResult.contacts.filter((contact) => !String(contact.xProfileUrl || '').trim()),
      item,
    )
    : { contacts: [], queries: [], sources: [], verifications: [], errors: [] };
  const previousContacts = Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [];
  const preservePreviousDiscoveryEvidence = publicResult.status === 'unavailable'
    || publicResult.status === 'error'
    || publicResult.errors.length > 0;
  const emailConventions = mergeDiscoveryEvidence(
    preservePreviousDiscoveryEvidence ? record.discovery?.emailConventions : [],
    publicResult.emailConventions,
    'domain',
  );
  const emailHypotheses = mergeDiscoveryEvidence(
    preservePreviousDiscoveryEvidence ? record.discovery?.emailHypotheses : [],
    publicResult.emailHypotheses,
    'email',
  );
  const sendableHypotheses = emailHypotheses.filter((hypothesis) => hypothesis.sendable === true);
  const contacts = [...publicResult.contacts, ...warmResult.contacts, ...candidateEmailResult.contacts, ...candidateXResult.contacts, ...sendableHypotheses];
  const status = contacts.length
    ? 'found'
    : publicResult.status === 'error' || warmResult.status === 'error'
      ? 'error'
      : publicResult.status === 'unavailable' || warmResult.status === 'unavailable'
        ? 'unavailable'
        : 'no_contacts';
  const emailVerification = mergeDiscoveryEvidence(
    preservePreviousDiscoveryEvidence ? record.discovery?.emailVerification : [],
    publicResult.emailVerification,
    'email',
  );
  const candidateEmailVerification = mergeDiscoveryEvidence(
    preservePreviousDiscoveryEvidence ? record.discovery?.candidateEmailVerification : [],
    [
      ...(Array.isArray(publicResult.candidateEmailVerification) ? publicResult.candidateEmailVerification : []),
      ...candidateEmailResult.verifications,
    ],
    'name',
  );
  const candidateXVerification = mergeDiscoveryEvidence(
    preservePreviousDiscoveryEvidence ? record.discovery?.candidateXVerification : [],
    [
      ...(Array.isArray(publicResult.candidateXVerification) ? publicResult.candidateXVerification : []),
      ...candidateXResult.verifications,
    ],
    'name',
  );
  const result = {
    status,
    reason: [publicResult.reason, warmResult.reason].filter(Boolean).join('; '),
    contacts,
    emailConventions,
    emailHypotheses,
    emailVerification,
    candidateEmailVerification,
    candidateXVerification,
    queries: [...publicResult.queries, ...warmResult.gmailQueries, ...warmResult.webQueries, ...candidateEmailResult.queries, ...candidateXResult.queries],
    sources: [...new Set([...publicResult.sources, ...warmResult.sources, ...candidateEmailResult.sources, ...candidateXResult.sources])],
    errors: [...new Set([...publicResult.errors, ...warmResult.errors, ...candidateEmailResult.errors, ...candidateXResult.errors])],
    warnings: [...new Set([...(warmResult.warnings || [])])],
    phases: {
      public: publicResult,
      warmNetwork: warmResult,
      candidateEmailVerification: candidateEmailResult,
      candidateXVerification: candidateXResult,
    },
  };
  if (!dryRun) {
    const attemptedAtValue = new Date().toISOString();
    const cacheExpiresAt = new Date(Date.now() + discoveryCacheTtlMs(result.status, result.contacts.length)).toISOString();
    const preservePreviousContacts = result.status === 'error'
      || result.status === 'unavailable'
      || result.errors.length > 0;
    const persistedContacts = retainDiscoveryContacts(previousContacts, result.contacts, preservePreviousContacts);
    record.discoveredContacts = persistedContacts;
    record.discovery = {
      pipelineVersion: OUTREACH_DISCOVERY_PIPELINE_VERSION,
      status: result.status,
      attemptedAt: attemptedAtValue,
      cacheExpiresAt,
      nextAttemptAt: cacheExpiresAt,
      candidateCount: persistedContacts.length,
      freshCandidateCount: result.contacts.length,
      sourceCount: result.sources.length,
      reason: result.reason,
      queries: result.queries,
      sources: result.sources,
      errors: result.errors,
      warnings: result.warnings,
      emailConventions,
      emailHypotheses,
      emailVerification,
      candidateEmailVerification,
      candidateXVerification,
      phases: result.phases,
    };
  }
  return result;
}

/** @param {Record<string, unknown>} item @param {boolean} force */
function queueDiscoveryDue(item, force) {
  if (force) return true;
  const discovery = item.outreach?.discovery;
  if (!discovery || typeof discovery !== 'object') return true;
  if (discovery.pipelineVersion !== OUTREACH_DISCOVERY_PIPELINE_VERSION) return true;
  const expiresAt = new Date(String(discovery.cacheExpiresAt || '')).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

/** @param {Record<string, unknown>} record @param {string} [mode] */
function queueDiscoverySnapshot(record, mode = 'queue-import') {
  const discovery = record.discovery && typeof record.discovery === 'object' ? record.discovery : {};
  return {
    pipelineVersion: OUTREACH_DISCOVERY_PIPELINE_VERSION,
    mode,
    status: discovery.status || 'error',
    attemptedAt: discovery.attemptedAt || new Date().toISOString(),
    cacheExpiresAt: discovery.cacheExpiresAt || null,
    nextAttemptAt: discovery.nextAttemptAt || discovery.cacheExpiresAt || null,
    candidateCount: Number(discovery.candidateCount || 0),
    freshCandidateCount: Number(discovery.freshCandidateCount || 0),
    sourceCount: Number(discovery.sourceCount || 0),
    reason: discovery.reason || '',
    queries: Array.isArray(discovery.queries) ? discovery.queries : [],
    sources: Array.isArray(discovery.sources) ? discovery.sources : [],
    errors: Array.isArray(discovery.errors) ? discovery.errors : [],
    warnings: Array.isArray(discovery.warnings) ? discovery.warnings : [],
    contacts: Array.isArray(record.discoveredContacts) ? record.discoveredContacts.slice(0, 25) : [],
    emailConventions: Array.isArray(discovery.emailConventions) ? discovery.emailConventions : [],
    emailHypotheses: Array.isArray(discovery.emailHypotheses) ? discovery.emailHypotheses : [],
    emailVerification: Array.isArray(discovery.emailVerification) ? discovery.emailVerification : [],
    candidateEmailVerification: Array.isArray(discovery.candidateEmailVerification) ? discovery.candidateEmailVerification : [],
    candidateXVerification: Array.isArray(discovery.candidateXVerification) ? discovery.candidateXVerification : [],
  };
}

/**
 * Run contact discovery as packet-preparation research without creating outreach
 * records, drafts, outbox entries, or send authorization.
 *
 * @param {Record<string, unknown>} item
 * @param {{ dryRun?: boolean }} [options]
 */
export async function discoverContactEvidenceForPacket(item, options = {}) {
  await loadDotenvOnce();
  const dryRun = options.dryRun === true;
  const imported = item.outreach?.discovery && typeof item.outreach.discovery === 'object'
    ? item.outreach.discovery
    : null;
  const record = {
    status: 'awaiting_submission_confirmation',
    discoveredContacts: Array.isArray(imported?.contacts) ? imported.contacts : [],
    discovery: imported ? { ...imported } : null,
  };
  const importedExpiry = new Date(String(imported?.cacheExpiresAt || '')).getTime();
  const importedCacheValid = Boolean(
    imported
    && imported.pipelineVersion === OUTREACH_DISCOVERY_PIPELINE_VERSION
    && Number.isFinite(importedExpiry)
    && importedExpiry > Date.now(),
  );
  const relationshipClient = importedCacheValid ? null : await createRelationshipClient(dryRun);
  const result = await discoverForRecord(record, item, dryRun, {
    gmailClient: relationshipClient,
    force: false,
    sourceState: {},
  });
  const snapshot = queueDiscoverySnapshot(record, 'packet-prep');

  if (!dryRun) {
    const queue = readQueueState(QUEUE_PATH);
    const targetKey = applicationKey(item);
    const queued = (queue.items || []).find((candidate) => String(candidate.id || '') === String(item.id || '')
      || applicationKey(candidate) === targetKey);
    if (queued) {
      queued.outreach = {
        ...(queued.outreach && typeof queued.outreach === 'object' ? queued.outreach : {}),
        discovery: snapshot,
      };
      queue.generatedAt = new Date().toISOString();
      writeQueueState(QUEUE_PATH, queue);
      writeFileSync(QUEUE_MARKDOWN_PATH, renderQueueMarkdown(queue), 'utf8');
    }
  }

  return {
    ...snapshot,
    status: result.status,
    reason: result.reason || snapshot.reason,
    contacts: Array.isArray(result.contacts) ? result.contacts : snapshot.contacts,
    sources: Array.isArray(result.sources) ? result.sources : snapshot.sources,
    queries: Array.isArray(result.queries) ? result.queries : snapshot.queries,
    errors: Array.isArray(result.errors) ? result.errors : snapshot.errors,
    warnings: Array.isArray(result.warnings) ? result.warnings : snapshot.warnings,
    emailConventions: Array.isArray(result.emailConventions) ? result.emailConventions : snapshot.emailConventions,
    emailHypotheses: Array.isArray(result.emailHypotheses) ? result.emailHypotheses : snapshot.emailHypotheses,
    emailVerification: Array.isArray(result.emailVerification) ? result.emailVerification : snapshot.emailVerification,
    candidateEmailVerification: Array.isArray(result.candidateEmailVerification)
      ? result.candidateEmailVerification
      : snapshot.candidateEmailVerification,
    cacheReused: importedCacheValid || /^cached until\b/.test(String(result.reason || '')),
  };
}

/** @param {boolean} dryRun @param {number} requestedLimit @param {boolean} force */
async function discoverQueue(dryRun, requestedLimit, force) {
  await loadDotenvOnce();
  const queue = readQueueState(QUEUE_PATH);
  const items = Array.isArray(queue.items) ? queue.items : [];
  const parsedLimit = Number(requestedLimit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(DEFAULT_CONTACT_DISCOVERY_LIMIT, Math.max(1, parsedLimit))
    : DEFAULT_CONTACT_DISCOVERY_LIMIT;
  const due = items
    .filter((item) => ['ready', 'in_review'].includes(String(item.status || '')))
    .filter((item) => isDiscoverableApplication(item) && queueDiscoveryDue(item, force))
    .sort((left, right) => {
      const selected = Number(right.selectedForToday === true) - Number(left.selectedForToday === true);
      if (selected) return selected;
      const withoutSnapshot = Number(Boolean(left.outreach?.discovery)) - Number(Boolean(right.outreach?.discovery));
      if (withoutSnapshot) return withoutSnapshot;
      return Number(left.queueRank || 999) - Number(right.queueRank || 999)
        || String(left.firstSeenAt || '').localeCompare(String(right.firstSeenAt || ''));
    });
  const batch = due.slice(0, limit);
  const relationshipClient = batch.length ? await createRelationshipClient(dryRun) : null;
  const sourceState = {};
  const results = [];
  const errors = [];
  const warnings = [];

  for (const item of batch) {
    const imported = item.outreach?.discovery;
    const record = {
      status: 'awaiting_submission_confirmation',
      discoveredContacts: Array.isArray(imported?.contacts) ? imported.contacts : [],
    };
    try {
      const result = await discoverForRecord(record, item, dryRun, {
        gmailClient: relationshipClient,
        force: true,
        sourceState,
      });
      const discoveryErrors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
      const discoveryWarnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
      if (result.status === 'error') {
        errors.push(`${item.company || 'Unknown'} / ${item.title || 'Job lead'}: ${discoveryErrors.join('; ') || result.reason || 'contact discovery returned an error'}`);
      } else if (result.status === 'unavailable') {
        warnings.push(result.reason || discoveryErrors.join('; ') || 'contact discovery sources are unavailable');
      } else if (discoveryErrors.length) {
        warnings.push(`${item.company || 'Unknown'} / ${item.title || 'Job lead'}: ${discoveryErrors.join('; ')}`);
      }
      warnings.push(...discoveryWarnings);
      if (!dryRun) {
        item.outreach = {
          ...(item.outreach && typeof item.outreach === 'object' ? item.outreach : {}),
          discovery: queueDiscoverySnapshot(record),
        };
      }
      results.push({
        id: item.id,
        company: item.company,
        title: item.title,
        status: result.status,
        contacts: Array.isArray(record.discoveredContacts) ? record.discoveredContacts.length : 0,
        emails: Array.isArray(record.discoveredContacts) ? record.discoveredContacts.filter((contact) => contact.email).length : 0,
        hypotheses: Array.isArray(result.emailHypotheses) ? result.emailHypotheses.length : 0,
        reason: result.reason || '',
        errors: discoveryErrors,
        warnings: discoveryWarnings,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${item.company || 'Unknown'} / ${item.title || 'Job lead'}: ${reason}`);
      if (!dryRun) {
        item.outreach = {
          ...(item.outreach && typeof item.outreach === 'object' ? item.outreach : {}),
          discovery: {
            pipelineVersion: OUTREACH_DISCOVERY_PIPELINE_VERSION,
            mode: 'queue-import',
            status: 'error',
            attemptedAt: new Date().toISOString(),
            cacheExpiresAt: new Date(Date.now() + discoveryCacheTtlMs('error')).toISOString(),
            nextAttemptAt: new Date(Date.now() + discoveryCacheTtlMs('error')).toISOString(),
            candidateCount: 0,
            freshCandidateCount: 0,
            sourceCount: 0,
            reason,
            queries: [],
            sources: [],
            errors: [reason],
            warnings: [],
            contacts: [],
            emailConventions: [],
            emailHypotheses: [],
            emailVerification: [],
            candidateEmailVerification: [],
          },
        };
      }
    }
  }

  if (!dryRun && batch.length) {
    queue.generatedAt = new Date().toISOString();
    writeQueueState(QUEUE_PATH, queue);
    writeFileSync(QUEUE_MARKDOWN_PATH, renderQueueMarkdown(queue), 'utf8');
  }
  const summary = {
    ok: errors.length === 0,
    dryRun,
    attempted: batch.length,
    deferred: Math.max(0, due.length - batch.length),
    results,
    errors,
    warnings: [...new Set(warnings)],
  };
  console.log(`Queue contact discovery${dryRun ? ' (dry run)' : ''}: ${batch.length} role(s) attempted, ${summary.deferred} deferred.`);
  for (const result of results) {
    console.log(`  ${result.company || 'Unknown'} / ${result.title || 'Job lead'} — ${result.status}; ${result.emails} email(s), ${result.hypotheses} unverified convention hypothesis/hypotheses`);
  }
  for (const error of errors) console.log(`  ⚠️ ${error}`);
  for (const warning of summary.warnings) console.log(`  ⚠️ ${warning}`);
  return summary;
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} record */
function printPrepared(item, record) {
  console.log(`${item.company || 'Unknown company'} | ${item.title || 'Job lead'} | ${record.status}`);
  console.log(`  Search: ${record.searchQuery || buildContactSearchQuery(item)}`);
  for (const contact of record.contacts || []) {
    console.log(`  ${contact.type}: ${contact.name} — ${contact.title}`);
    if (contact.relationshipLabel) console.log(`    Relationship: ${contact.relationshipLabel}`);
    const emailState = contact.emailVerified
      ? 'verified public professional'
      : contact.emailEligible
        ? 'unverified convention hypothesis'
        : 'not eligible';
    console.log(`    Email: ${contact.email || 'not eligible'} (${emailState})`);
    if (contact.initial?.subject) console.log(`    Email subject: ${contact.initial.subject}`);
    if (contact.linkedinDraft) console.log(`    LinkedIn draft: ${contact.linkedinDraft}`);
    if (contact.xProfileUrl) console.log(`    X/Twitter: ${contact.xHandle || contact.xProfileUrl} — ${contact.xProfileUrl}`);
    if (contact.xDraft) console.log(`    X/Twitter copy-ready message: ${contact.xDraft}`);
  }
  const hypotheses = Array.isArray(record.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [];
  if (hypotheses.length) {
    console.log(`  Unverified convention email hypotheses (${hypotheses.length}; explicit send action still required):`);
    for (const hypothesis of hypotheses) {
      const verification = hypothesis.emailVerificationState === 'verified-exact-public-source'
        ? '; exact public evidence found; verified contact created'
        : '; address is unverified';
      console.log(`    ${hypothesis.name} — ${hypothesis.email} (${hypothesis.convention}, ${hypothesis.conventionConfidence}${verification})`);
    }
  }
}

/** @param {Record<string, unknown>} headers @param {string} key */
function header(headers, key) {
  const list = Array.isArray(headers) ? headers : [];
  return String(list.find((item) => String(item?.name || '').toLowerCase() === key.toLowerCase())?.value || '');
}

/** @param {Record<string, unknown>} message */
function messageHeaders(message) {
  return message.payload && typeof message.payload === 'object' && Array.isArray(message.payload.headers)
    ? message.payload.headers
    : [];
}

/** @param {Record<string, unknown>} state @param {Array<Record<string, unknown>>} items @param {boolean} dryRun */
function scanBrowserApplicationRuns(state, items, dryRun) {
  const parsed = readJson(APPLICATION_RUNS_PATH);
  const runs = parsed && typeof parsed === 'object' && Array.isArray(parsed.runs) ? parsed.runs : [];
  let matched = 0;
  for (const run of runs) {
    if (!run || typeof run !== 'object' || run.state !== 'submitted') continue;
    const result = run.result && typeof run.result === 'object' ? run.result : {};
    const company = String(result.company || run.company || '');
    const title = String(result.title || run.title || '');
    if (!company || !title) continue;
    const item = items.find((candidate) => applicationKey(candidate) === applicationKey({ company, title })
      || (String(candidate.company || '').toLowerCase() === company.toLowerCase()
        && String(candidate.title || '').toLowerCase() === title.toLowerCase()));
    if (!item) continue;
    matched += 1;
    if (!dryRun) {
      const submissionEvidence = result.submissionEvidence && typeof result.submissionEvidence === 'object'
        ? result.submissionEvidence
        : {};
      const submissionId = String(submissionEvidence.submissionId || submissionEvidence.confirmationId || result.applicationId || run.id || run.key || '').trim() || null;
      upsertSubmissionSignal(state, item, {
        source: 'browser_confirmation',
        at: String(run.finishedAt || result.finishedAt || new Date().toISOString()),
        confirmed: true,
        submissionId,
        evidence: {
          adapter: String(result.adapter || run.adapter || '').trim() || null,
          url: String(result.url || run.url || item.applyUrl || '').trim() || null,
          resultState: String(result.state || run.state || '').trim() || 'submitted',
        },
      });
    }
  }
  return {
    scanned: runs.length > 0,
    matched,
    reason: runs.length ? `checked ${runs.length} application run(s)` : 'application run store is empty or not configured',
  };
}

/** @param {Record<string, unknown>} state @param {Array<Record<string, unknown>>} items @param {boolean} dryRun */
async function scanConfirmationEmails(state, items, dryRun) {
  await loadDotenvOnce();
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    return { scanned: false, matched: 0, reason: 'Gmail OAuth credentials are not configured' };
  }
  const client = await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
  await client.verifyAccount();
  const messages = await client.listMessages(CONFIRMATION_QUERY, { limit: 100 });
  let matched = 0;
  const appliedItems = items.filter((candidate) => candidate.status === 'applied'
    || candidate.applicationState === 'submitted'
    || candidate.applicationResult?.state === 'submitted');
  for (const summary of messages) {
    const message = await client.getMessage(summary.id, 'full');
    const headers = messageHeaders(message);
    const subject = header(headers, 'subject');
    const from = header(headers, 'from');
    const body = getMessageBody(message.payload);
    if (!isAuthenticEmail(headers)) continue;
    const item = appliedItems.find((candidate) => matchesApplicationConfirmation(subject, from, body, candidate, {
      applicationUrl: candidate.applyUrl || candidate.canonicalUrl,
      submissionId: candidate.applicationResult?.submissionEvidence?.submissionId,
    }));
    if (!item) continue;
    matched += 1;
    if (!dryRun) upsertSubmissionSignal(state, item, {
      source: 'gmail_confirmation',
      at: new Date(Number(message.internalDate || Date.now())).toISOString(),
      messageId: summary.id,
      subject,
      confirmed: true,
      submissionId: summary.id,
      evidence: { from, subject, messageId: summary.id },
    });
  }
  state.scan = { ...(state.scan || {}), confirmationAt: new Date().toISOString(), confirmationCount: matched };
  return { scanned: true, matched, reason: `checked ${messages.length} confirmation message(s)` };
}

/** @param {boolean} dryRun */
async function createRelationshipClient(dryRun) {
  if (dryRun || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) return null;
  try {
    const client = await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
    await client.verifyAccount();
    return client;
  } catch (error) {
    console.log(`  Warm-network Gmail search unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** @param {Record<string, unknown>} record @param {Record<string, unknown>} item */
function seedImportedDiscovery(record, item) {
  const imported = item.outreach?.discovery;
  if (!imported || typeof imported !== 'object' || !Array.isArray(imported.contacts)) return;
  const existing = Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [];
  record.discoveredContacts = retainDiscoveryContacts(existing, imported.contacts, true);
}

/** @param {Record<string, unknown>} state @param {Array<Record<string, unknown>>} items @param {boolean} dryRun */
function ensureAppliedRecords(state, items, dryRun) {
  for (const item of items.filter((candidate) => candidate.status === 'applied')) {
    const existing = findOutreachRecord(state, applicationKey(item));
    const record = existing || upsertSubmissionSignal(state, item, {
        source: 'queue_applied',
        at: item.appliedAt || new Date().toISOString(),
        confirmed: false,
    });
    for (const signal of Array.isArray(item.submissionSignals) ? item.submissionSignals : []) {
      upsertSubmissionSignal(state, item, {
        ...signal,
        at: signal.at || item.appliedAt || new Date().toISOString().slice(0, 10),
      });
    }
    seedImportedDiscovery(record, item);
  }
  if (!dryRun) saveOutreachState(STATE_PATH, state);
}

/** @param {Record<string, unknown>} record @param {Record<string, unknown>} contact @param {Record<string, unknown>} message */
function isRelevantResponse(record, contact, message) {
  const sentAt = new Date(contact.initial?.sentAt || 0).getTime();
  const receivedAt = Number(message.internalDate || 0);
  if (!sentAt || !receivedAt || receivedAt <= sentAt) return false;
  const headers = messageHeaders(message);
  const subject = header(headers, 'subject');
  const from = header(headers, 'from').toLowerCase();
  if (!from.includes(String(contact.email || '').toLowerCase())) return false;
  const body = getMessageBody(message.payload);
  const text = `${subject} ${body}`.toLowerCase();
  const tokens = String(record.company || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  return tokens.length === 0 || tokens.some((token) => text.includes(token));
}

/** @param {Record<string, unknown>} record @param {Record<string, unknown>} contact @param {Record<string, unknown>} message */
function responseAction(record, contact, message) {
  if (!isRelevantResponse(record, contact, message)) return null;
  const headers = messageHeaders(message);
  const text = `${header(headers, 'subject')} ${getMessageBody(message.payload)}`.toLowerCase();
  if (/unsubscribe|opt[- ]?out|do not contact|remove me from|stop (?:emailing|contacting)/i.test(text)) return 'opted_out';
  if (/not moving forward|move forward with other|position has been filled|role (?:is )?(?:closed|filled)|no longer (?:considering|accepting)|regret to inform|application (?:was )?rejected|rejected for/i.test(text)) return 'rejected';
  return 'replied';
}

/** @param {Record<string, unknown>} state @param {boolean} dryRun */
async function refreshResponses(state, dryRun) {
  await loadDotenvOnce();
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) return { checked: false, replies: 0, bounces: 0, reason: 'Gmail OAuth credentials are not configured' };
  const client = await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
  await client.verifyAccount();
  let replies = 0;
  let bounces = 0;
  let rejected = 0;
  const bounceMessages = await client.listMessages('in:anywhere from:(mailer-daemon OR postmaster) newer_than:30d', { limit: 100 });
  const bounceBodies = [];
  for (const summary of bounceMessages) {
    const message = await client.getMessage(summary.id, 'full');
    bounceBodies.push(`${header(messageHeaders(message), 'subject')} ${getMessageBody(message.payload)}`.toLowerCase());
  }
  for (const record of state.records || []) {
    for (const contact of record.contacts || []) {
      if (!contact.email || contact.initial?.status !== 'sent') continue;
      if (!contact.bounced) {
        const bounced = bounceBodies.some((body) => body.includes(String(contact.email).toLowerCase()) && /delivery status notification|undeliverable|address not found|delivery incomplete|returned mail/i.test(body));
        if (bounced) {
          bounces += 1;
          if (!dryRun) contact.bounced = true;
        }
      }
      if (contact.replied || contact.bounced) continue;
      const messages = await client.listMessages(`in:anywhere from:${contact.email} newer_than:30d`, { limit: 20 });
      for (const summary of messages) {
        if (summary.id === contact.initial.gmailMessageId || summary.id === contact.followUp?.gmailMessageId) continue;
        const message = await client.getMessage(summary.id, 'full');
        const action = responseAction(record, contact, message);
        if (!action) continue;
        replies += 1;
        if (!dryRun) {
          if (action === 'opted_out') contact.optedOut = true;
          else if (action === 'rejected') {
            contact.rejected = true;
            record.roleClosed = true;
            record.status = 'suppressed';
            record.suppressionReason = 'application rejected or role closed';
            rejected += 1;
          } else contact.replied = true;
          contact.responseMessageId = summary.id;
        }
        break;
      }
    }
  }
  return { checked: true, replies, bounces, rejected, reason: `checked ${state.records.length} outreach record(s)` };
}

/** @param {string} value */
function normalizedRecipient(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return String(match?.[1] || value || '').trim().toLowerCase();
}

/** @param {string} to @param {string} subject */
function draftMatchKey(to, subject) {
  return `${normalizedRecipient(to)}|${String(subject || '').trim()}`;
}

/** @param {RelationshipClient} client */
async function loadGmailDraftIndex(client) {
  const byOutreachId = new Map();
  const byRecipientSubject = new Map();
  const drafts = await client.listDrafts({ limit: 500 });
  for (const summary of drafts) {
    const draft = await client.getDraft(summary.id, 'metadata');
    const message = draft.message && typeof draft.message === 'object' ? draft.message : {};
    const headers = messageHeaders(/** @type {Record<string, unknown>} */ (message));
    const info = {
      draftId: summary.id,
      id: typeof message.id === 'string' ? message.id : summary.message?.id || null,
      threadId: typeof message.threadId === 'string' ? message.threadId : summary.message?.threadId || null,
    };
    const outreachId = header(headers, 'x-career-ops-outreach-id');
    if (outreachId) byOutreachId.set(outreachId, info);
    const to = header(headers, 'to');
    const subject = header(headers, 'subject');
    if (to && subject) byRecipientSubject.set(draftMatchKey(to, subject), info);
  }
  return { byOutreachId, byRecipientSubject };
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} entry */
function outboxTarget(state, entry) {
  const record = (state.records || []).find((candidate) => candidate.key === entry.recordKey);
  const contact = record?.contacts?.find((candidate) => candidate.id === entry.contactId);
  return { record, contact };
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {Record<string, unknown>} record @param {Record<string, unknown>} entry @param {Record<string, unknown>} providerResult @param {Record<string, unknown>} policy */
function markOutboxAccepted(state, item, record, entry, providerResult, policy) {
  const now = new Date().toISOString();
  const gmailMessageId = typeof providerResult.id === 'string' ? providerResult.id : (entry.gmailMessageId || null);
  const threadId = typeof providerResult.threadId === 'string' ? providerResult.threadId : (entry.threadId || null);
  entry.status = 'accepted';
  entry.updatedAt = now;
  entry.nextAttemptAt = null;
  entry.lastError = null;
  entry.gmailMessageId = gmailMessageId;
  entry.threadId = threadId;
  entry.providerStatus = 'accepted_by_gmail';
  const contact = record.contacts?.find((candidate) => candidate.id === entry.contactId);
  if (!contact) return;
  const eventKey = entry.kind === 'initial' ? 'initial' : 'followUp';
  const event = contact[eventKey] || {};
  const sentAt = event.sentAt || now;
  contact[eventKey] = {
    ...event,
    status: 'sent',
    deliveryStatus: 'provider_accepted',
    sentAt,
    gmailMessageId,
    threadId,
    outboxId: entry.id,
  };
  if (entry.kind === 'initial' && contact.followUp?.status !== 'sent' && !contact.followUp?.dueAt) {
    const rawFollowUp = buildEmailMessage(loadProfile(ROOT), item, contact, 'followup', {
      variant: Number(contact.outreachVariant || 0),
    });
    const quality = prepareOutreachDraft({
      channel: 'email',
      subject: rawFollowUp.subject,
      body: rawFollowUp.body,
      contactName: String(contact.name || ''),
      company: String(item.company || ''),
    });
    if (!quality.receipt.passed) {
      contact.followUp = {
        ...contact.followUp,
        status: 'blocked_content_review',
        validationError: `Humanizer/quality gate failed: ${quality.receipt.quality.errors.join('; ') || quality.receipt.humanizer.errors.join('; ')}`,
        draftQuality: quality.receipt,
      };
      return;
    }
    const followUpMessage = {
      ...rawFollowUp,
      subject: quality.subject,
      body: quality.body,
      hash: messageFingerprint(quality.subject, quality.body),
      rdwRequest: {
        ...recordObject(rawFollowUp.rdwRequest),
        content: {
          ...recordObject(recordObject(rawFollowUp.rdwRequest).content),
          subject: quality.subject,
          body: quality.body,
        },
      },
      draftQuality: quality.receipt,
    };
    const rdwReceipt = runRdwArtifactCheck(recordObject(followUpMessage.rdwRequest));
    contact.followUp = {
      ...contact.followUp,
      status: 'scheduled',
      dueAt: addBusinessDays(sentAt, policy.followUpBusinessDays),
      threadId,
      outboxId: null,
      ...followUpMessage,
      rdwReceipt,
    };
  }
  record.updatedAt = now;
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {Record<string, unknown>} record @param {Record<string, unknown>} entry @param {Record<string, unknown>} providerResult */
function markOutboxDraftCreated(state, item, record, entry, providerResult) {
  const now = new Date().toISOString();
  const gmailDraftId = typeof providerResult.draftId === 'string'
    ? providerResult.draftId
    : typeof providerResult.id === 'string' ? providerResult.id : (entry.gmailDraftId || null);
  const gmailMessageId = typeof providerResult.gmailMessageId === 'string'
    ? providerResult.gmailMessageId
    : typeof providerResult.id === 'string' && providerResult.draftId ? providerResult.id : (entry.gmailMessageId || null);
  const threadId = typeof providerResult.threadId === 'string' ? providerResult.threadId : (entry.threadId || null);
  entry.status = 'draft_created';
  entry.updatedAt = now;
  entry.draftedAt = entry.draftedAt || now;
  entry.nextAttemptAt = null;
  entry.lastError = null;
  entry.gmailDraftId = gmailDraftId;
  entry.gmailMessageId = gmailMessageId;
  entry.threadId = threadId;
  entry.providerStatus = 'draft_created_in_gmail';
  const contact = record.contacts?.find((candidate) => candidate.id === entry.contactId);
  if (!contact) return;
  const eventKey = entry.kind === 'initial' ? 'initial' : 'followUp';
  const event = contact[eventKey] || {};
  contact[eventKey] = {
    ...event,
    status: 'draft_created',
    deliveryStatus: 'gmail_draft_created',
    draftedAt: event.draftedAt || now,
    gmailDraftId,
    gmailMessageId,
    threadId,
    outboxId: entry.id,
  };
  record.updatedAt = now;
}

/** @param {Record<string, unknown>} state @param {Array<Record<string, unknown>>} items @param {RelationshipClient} client @param {Map<string, Record<string, unknown>>} sentIndex @param {{ byOutreachId: Map<string, Record<string, unknown>>, byRecipientSubject: Map<string, Record<string, unknown>> }} [draftIndex] */
function reconcileOutbox(state, items, client, sentIndex, draftIndex = { byOutreachId: new Map(), byRecipientSubject: new Map() }) {
  const now = Date.now();
  for (const entry of state.outbox || []) {
    const item = items.find((candidate) => applicationKey(candidate) === entry.recordKey);
    const target = outboxTarget(state, entry);
    if (!item || !target.record) continue;
    const existingMessage = sentIndex.get(entry.id);
    if (existingMessage) {
      markOutboxAccepted(state, item, target.record, entry, existingMessage, loadOutreachPolicy(loadProfile(ROOT)));
      continue;
    }
    if (entry.status === 'draft_update_pending') continue;
    const existingDraft = draftIndex.byOutreachId.get(entry.id)
      || draftIndex.byRecipientSubject.get(draftMatchKey(entry.to, entry.subject));
    if (existingDraft) {
      markOutboxDraftCreated(state, item, target.record, entry, existingDraft);
      continue;
    }
    if (entry.status === 'draft_created') {
      entry.status = 'pending';
      entry.nextAttemptAt = new Date().toISOString();
      entry.gmailDraftId = null;
      entry.gmailMessageId = null;
      entry.providerStatus = 'draft_missing_from_gmail';
      const missingContact = target.contact;
      const missingEventKey = entry.kind === 'initial' ? 'initial' : 'followUp';
      if (missingContact?.[missingEventKey]) {
        missingContact[missingEventKey] = {
          ...missingContact[missingEventKey],
          status: 'pending',
          deliveryStatus: null,
          draftedAt: null,
          gmailDraftId: null,
          gmailMessageId: null,
        };
      }
    }
    if (['sending', 'drafting'].includes(entry.status)) {
      const updatedAt = new Date(entry.updatedAt || entry.createdAt || 0).getTime();
      if (Number.isFinite(updatedAt) && now - updatedAt < OUTREACH_SEND_STALE_MS) continue;
      entry.status = Number(entry.attempts || 0) >= OUTREACH_MAX_SEND_ATTEMPTS ? 'failed' : 'unknown';
      entry.nextAttemptAt = entry.status === 'failed' ? null : outboxNextAttemptAt(new Date().toISOString(), Number(entry.attempts || 0));
      entry.updatedAt = new Date().toISOString();
      entry.lastError = entry.lastError || 'previous send attempt did not reach a recorded completion';
    }
    if (entry.status === 'unknown' && Number(entry.attempts || 0) >= OUTREACH_MAX_SEND_ATTEMPTS) {
      entry.status = 'failed';
      entry.nextAttemptAt = null;
      entry.updatedAt = new Date().toISOString();
    }
    if (entry.status === 'unknown' && outboxEntryDue(entry)) entry.status = 'pending';
  }
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {Record<string, unknown>} record @param {Record<string, unknown>} policy */
function enqueueOutboxEntries(state, item, record, policy) {
  if (!hasConfirmedSubmission(record)) return;
  differentiateRecipientDrafts(record, item, loadProfile(ROOT));
  for (const contact of record.contacts || []) {
    if (isVerifiedContactForExplicitSend(contact) && ['pending', 'unknown', 'sending', 'failed', 'draft_update_pending'].includes(contact.initial?.status)) {
      const initial = messageForSend(item, {
        to: contact.email,
        subject: contact.initial.subject,
        body: contact.initial.body,
        hash: contact.initial.hash,
        messageVersion: contact.initial.messageVersion,
        rdwRequest: contact.initial.rdwRequest,
        rdwReceipt: contact.initial.rdwReceipt,
        draftQuality: contact.initial.draftQuality,
      });
      const existingEntry = contact.initial.status === 'draft_update_pending'
        ? (state.outbox || []).find((candidate) => candidate.id === contact.initial.outboxId)
        : null;
      const entry = existingEntry || ensureOutboxEntry(state, {
          recordKey: record.key,
          contactId: contact.id,
          kind: 'initial',
          ...initial,
        });
      if (contact.initial.status === 'draft_update_pending') {
        Object.assign(entry, initial, {
          status: 'draft_update_pending',
          gmailDraftId: contact.initial.gmailDraftId || entry.gmailDraftId || null,
          updatedAt: new Date().toISOString(),
          nextAttemptAt: new Date().toISOString(),
          lastError: null,
        });
      }
      contact.initial.outboxId = entry.id;
    }
    if (isVerifiedContactForExplicitSend(contact) && contact.followUp?.status === 'scheduled') {
      const followUp = messageForSend(item, {
        to: contact.email,
        subject: contact.followUp.subject,
        body: contact.followUp.body,
        hash: contact.followUp.hash,
        messageVersion: contact.followUp.messageVersion,
        rdwRequest: contact.followUp.rdwRequest,
        rdwReceipt: contact.followUp.rdwReceipt,
        draftQuality: contact.followUp.draftQuality,
      });
      const entry = ensureOutboxEntry(state, {
        recordKey: record.key,
        contactId: contact.id,
        kind: 'followup',
        ...followUp,
        now: contact.followUp.dueAt && new Date(contact.followUp.dueAt) > new Date() ? contact.followUp.dueAt : undefined,
      });
      if (contact.followUp.dueAt && new Date(contact.followUp.dueAt) > new Date() && entry.status === 'pending') entry.nextAttemptAt = contact.followUp.dueAt;
      contact.followUp.outboxId = entry.id;
    }
  }
}

/**
 * Create Gmail drafts without sending. The Gmail draft ID is persisted in the
 * outbox and contact record so retries reconcile existing drafts instead of
 * creating duplicates. The browser receives status only; message bodies stay
 * in the local state needed for provider reconciliation and in Gmail.
 *
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>} record
 * @param {Record<string, unknown>} policy
 * @param {boolean} dryRun
 * @param {RelationshipClient|null} [relationshipClient]
 */
async function createDraftsPending(state, item, record, policy, dryRun, relationshipClient = null) {
  const base = { drafted: 0, sent: 0, attempted: 0, skipped: 0, retrying: 0, failed: 0, rateLimited: 0, reasons: [] };
  if (!hasConfirmedSubmission(record)) return { ...base, skipped: 1, reason: 'waiting for explicit submission confirmation; no Gmail draft was created' };
  if (state.settings?.emailEnabled !== true) return { ...base, skipped: 1, reason: 'email outreach is disabled' };
  if (dryRun) return { ...base, skipped: 1, reason: 'dry-run mode is active' };
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) return { ...base, skipped: 1, reason: 'Gmail OAuth credentials are not configured' };
  const client = relationshipClient || await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
  const account = await client.verifyAccount();
  const draftIndex = await loadGmailDraftIndex(client);
  reconcileOutbox(state, [item], client, new Map(), draftIndex);
  enqueueOutboxEntries(state, item, record, policy);
  reconcileOutbox(state, [item], client, new Map(), draftIndex);
  saveOutreachState(STATE_PATH, state);
  const entries = (state.outbox || [])
    .filter((entry) => entry.recordKey === record.key)
    .filter((entry) => ['pending', 'unknown', 'drafting', 'draft_update_pending'].includes(entry.status))
    .sort((left, right) => (left.kind === 'initial' ? -1 : 1) - (right.kind === 'initial' ? -1 : 1) || String(left.createdAt).localeCompare(String(right.createdAt)));
  for (const entry of entries) {
    if (!outboxEntryDue(entry)) continue;
    const target = outboxTarget(state, entry);
    const contact = target.contact;
    if (!contact) {
      entry.status = 'failed';
      entry.lastError = 'outbox contact no longer exists';
      entry.updatedAt = new Date().toISOString();
      base.failed += 1;
      continue;
    }
    if (!isVerifiedContactForExplicitSend(contact)) {
      entry.status = 'blocked';
      entry.nextAttemptAt = null;
      entry.lastError = 'recipient is not a verified professional email; provider addresses are blocked';
      entry.updatedAt = new Date().toISOString();
      base.failed += 1;
      base.reasons.push(entry.lastError);
      continue;
    }
    if (entry.kind === 'initial' && contact.initial?.status === 'sent') {
      entry.status = 'accepted';
      entry.providerStatus = 'legacy_record';
      entry.updatedAt = new Date().toISOString();
      continue;
    }
    if (entry.kind === 'followup' && followUpSuppressed(record, contact)) {
      entry.status = 'blocked';
      entry.nextAttemptAt = null;
      entry.lastError = 'follow-up suppressed by reply, bounce, opt-out, rejection, or closed role';
      entry.updatedAt = new Date().toISOString();
      continue;
    }
    const updatingExistingDraft = entry.status === 'draft_update_pending';
    let message;
    try {
      message = messageForSend(item, entry);
    } catch (error) {
      entry.status = 'failed';
      entry.nextAttemptAt = null;
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.updatedAt = new Date().toISOString();
      base.failed += 1;
      base.reasons.push(entry.lastError);
      continue;
    }
    if (updatingExistingDraft && (!entry.gmailDraftId || typeof client.updateDraft !== 'function')) {
      entry.status = 'failed';
      entry.nextAttemptAt = null;
      entry.lastError = 'existing Gmail draft needs a quality update, but no durable draft ID or update capability is available';
      entry.updatedAt = new Date().toISOString();
      base.failed += 1;
      base.reasons.push(entry.lastError);
      continue;
    }
    entry.status = 'drafting';
    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.updatedAt = new Date().toISOString();
    saveOutreachState(STATE_PATH, state);
    base.attempted += 1;
    try {
      const providerMessage = {
        ...message,
        threadId: entry.threadId || undefined,
        headers: {
          'X-Career-Ops-Outreach-ID': entry.id,
          'X-Career-Ops-Outreach-Mode': 'gmail-draft',
        },
      };
      const result = updatingExistingDraft
        ? await client.updateDraft(entry.gmailDraftId, providerMessage)
        : await client.createDraft(providerMessage);
      const draft = result.message && typeof result.message === 'object' ? result.message : {};
      markOutboxDraftCreated(state, item, record, entry, {
        draftId: typeof result.id === 'string' ? result.id : null,
        gmailMessageId: typeof draft.id === 'string' ? draft.id : null,
        threadId: typeof draft.threadId === 'string' ? draft.threadId : null,
      });
      saveOutreachState(STATE_PATH, state);
      base.drafted += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      entry.status = Number(entry.attempts || 0) >= OUTREACH_MAX_SEND_ATTEMPTS ? 'failed' : 'unknown';
      entry.nextAttemptAt = entry.status === 'failed' ? null : outboxNextAttemptAt(new Date().toISOString(), Number(entry.attempts || 0));
      entry.lastError = reason;
      entry.providerStatus = 'unknown';
      entry.updatedAt = new Date().toISOString();
      contact[entry.kind === 'initial' ? 'initial' : 'followUp'] = {
        ...contact[entry.kind === 'initial' ? 'initial' : 'followUp'],
        status: entry.status,
        deliveryStatus: 'unknown',
        outboxId: entry.id,
      };
      record.lastError = reason;
      base[entry.status === 'failed' ? 'failed' : 'retrying'] += 1;
      base.reasons.push(`${entry.kind} ${contact.email}: ${reason}`);
      saveOutreachState(STATE_PATH, state);
    }
  }
  return { ...base, account, outbox: summarizeOutbox(state) };
}

/** @param {Record<string, unknown>} state @param {Array<Record<string, unknown>>} items */
function updateStatuses(state, items) {
  const itemByKey = new Map(items.map((item) => [applicationKey(item), item]));
  for (const record of state.records || []) {
    if (record.status === 'paused' || record.status === 'suppressed' || record.status === 'needs_application_identity') continue;
    const item = itemByKey.get(record.key);
    if (item && ['skipped', 'rejected', 'closed', 'withdrawn', 'not_selected'].includes(item.status)) {
      record.status = 'suppressed';
      record.roleClosed = true;
      record.suppressionReason = `application status is ${item.status}`;
      continue;
    }
    if (!hasConfirmedSubmission(record)) {
      record.status = 'awaiting_submission_confirmation';
      record.updatedAt = new Date().toISOString();
      continue;
    }
    const contacts = record.contacts || [];
    if (!contacts.length) { record.status = 'awaiting_contacts'; continue; }
    const initialSent = contacts.filter((contact) => contact.initial?.status === 'sent').length;
    const gmailDrafted = contacts.some((contact) => contact.initial?.status === 'draft_created' && contact.initial?.deliveryStatus === 'gmail_draft_created');
    const pendingFollowUp = contacts.some((contact) => contact.followUp?.status === 'scheduled');
    const pendingInitial = contacts.some((contact) => contact.initial?.status === 'pending' && contact.emailEligible);
    const retrying = contacts.some((contact) => ['unknown', 'sending', 'drafting'].includes(contact.initial?.status) || ['unknown', 'sending', 'drafting'].includes(contact.followUp?.status));
    const failed = contacts.some((contact) => ['failed'].includes(contact.initial?.status) || ['failed'].includes(contact.followUp?.status));
    record.status = failed ? 'error' : retrying ? 'retrying' : pendingInitial ? 'drafted' : pendingFollowUp ? 'followup_scheduled' : initialSent ? 'complete' : gmailDrafted ? 'gmail_drafts_created' : 'linkedin_ready';
    record.updatedAt = new Date().toISOString();
  }
}

/** @param {string} applicationId @param {boolean} dryRun */
function prepare(applicationId, dryRun) {
  const { items } = loadApplicationUniverse();
  const item = items.find((candidate) => candidate.id === applicationId || applicationKey(candidate) === applicationId);
  if (!item) throw new Error(`application not found: ${applicationId}`);
  if (item.status !== 'applied') throw new Error('outreach preparation requires the role to be recorded as applied');
  const state = loadOutreachState(STATE_PATH);
  const record = findOutreachRecord(state, applicationKey(item));
  const prepared = prepareRecord(
    state,
    item,
    dryRun,
    Array.isArray(record?.discoveredContacts) ? record.discoveredContacts : [],
    Array.isArray(record?.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [],
  );
  printPrepared(item, prepared);
  return prepared;
}

function repairInvalidRelationshipContacts() {
  const state = loadOutreachState(STATE_PATH);
  const removedContactIds = new Set();
  let removedSelected = 0;
  let removedDiscovered = 0;
  let affectedRecords = 0;
  for (const record of state.records || []) {
    const beforeSelected = Array.isArray(record.contacts) ? record.contacts.length : 0;
    const beforeDiscovered = Array.isArray(record.discoveredContacts) ? record.discoveredContacts.length : 0;
    for (const contact of record.contacts || []) {
      if (!hasTargetCompanyContactEvidence(recordObject(contact)) && contact.id) removedContactIds.add(String(contact.id));
    }
    record.contacts = (record.contacts || []).filter((contact) => hasTargetCompanyContactEvidence(recordObject(contact)));
    record.discoveredContacts = (record.discoveredContacts || []).filter((contact) => hasTargetCompanyContactEvidence(recordObject(contact)));
    const selectedDelta = beforeSelected - record.contacts.length;
    const discoveredDelta = beforeDiscovered - record.discoveredContacts.length;
    if (!selectedDelta && !discoveredDelta) continue;
    removedSelected += selectedDelta;
    removedDiscovered += discoveredDelta;
    affectedRecords += 1;
    if (record.discovery && typeof record.discovery === 'object') {
      record.discovery.pipelineVersion = 0;
      record.discovery.cacheExpiresAt = null;
      record.discovery.nextAttemptAt = new Date().toISOString();
    }
    if (!['paused', 'suppressed', 'needs_application_identity'].includes(String(record.status || ''))) {
      record.status = hasConfirmedSubmission(record) ? (record.contacts.length ? 'drafted' : 'awaiting_contacts') : 'awaiting_submission_confirmation';
    }
    record.updatedAt = new Date().toISOString();
  }
  let blockedOutbox = 0;
  for (const entry of state.outbox || []) {
    if (!removedContactIds.has(String(entry.contactId || '')) || ['accepted', 'draft_created', 'blocked'].includes(String(entry.status || ''))) continue;
    entry.status = 'blocked';
    entry.nextAttemptAt = null;
    entry.lastError = 'recipient lacked verified target-company evidence';
    entry.updatedAt = new Date().toISOString();
    blockedOutbox += 1;
  }
  saveOutreachState(STATE_PATH, state);
  console.log(`Repaired outreach state: ${removedSelected} selected contact(s) and ${removedDiscovered} cached contact(s) removed across ${affectedRecords} record(s); ${blockedOutbox} outbox entr${blockedOutbox === 1 ? 'y' : 'ies'} blocked.`);
}

/** @param {boolean} dryRun */
async function processOutreach(dryRun) {
  await loadDotenvOnce();
  const { items, evidenceAudit } = loadApplicationUniverse();
  const state = loadOutreachState(STATE_PATH);
  const profile = loadProfile(ROOT);
  const policy = loadOutreachPolicy(profile);
  ensureAppliedRecords(state, items, dryRun);
  const browser = scanBrowserApplicationRuns(state, items, dryRun);
  let confirmation = { scanned: false, matched: 0, reason: 'dry-run without Gmail scan' };
  if (!dryRun) {
    try {
      confirmation = await scanConfirmationEmails(state, items, false);
    } catch (error) {
      confirmation = { scanned: false, matched: 0, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const relationshipClient = await createRelationshipClient(dryRun);
  const discoveries = [];
  for (const record of state.records || []) {
    const item = items.find((candidate) => applicationKey(candidate) === record.key);
    if (!item) continue;
    try {
      const result = await discoverForRecord(record, item, dryRun, { gmailClient: relationshipClient });
      discoveries.push({ company: item.company, title: item.title, ...result });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record.discovery = {
        status: 'error',
        attemptedAt: new Date().toISOString(),
        cacheExpiresAt: new Date(Date.now() + discoveryCacheTtlMs('error')).toISOString(),
        nextAttemptAt: new Date(Date.now() + discoveryCacheTtlMs('error')).toISOString(),
        candidateCount: 0,
        sourceCount: 0,
        reason,
        queries: [],
        sources: [],
        errors: [reason],
      };
      discoveries.push({ company: item.company, title: item.title, status: 'error', reason, contacts: [], sources: [], queries: [], errors: [reason] });
    }
  }
  for (const record of state.records || []) {
    const item = items.find((candidate) => applicationKey(candidate) === record.key);
    if (item) prepareRecord(
      state,
      item,
      dryRun,
      Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [],
      Array.isArray(record.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [],
    );
  }
  let responses = { checked: false, replies: 0, bounces: 0, reason: 'response scan unavailable' };
  if (!dryRun) {
    try {
      responses = await refreshResponses(state, false);
    } catch (error) {
      responses = { checked: false, replies: 0, bounces: 0, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  updateStatuses(state, items);
  let drafted = 0;
  let sent = 0;
  let attempted = 0;
  let skipped = 0;
  let retrying = 0;
  let failed = 0;
  let rateLimited = 0;
  const errors = [];
  const warnings = [];
  for (const record of state.records || []) {
    const item = items.find((candidate) => applicationKey(candidate) === record.key);
    if (!item) continue;
    try {
      const result = await createDraftsPending(state, item, record, policy, dryRun, relationshipClient);
      drafted += Number(result.drafted || 0);
      sent += Number(result.sent || 0);
      attempted += Number(result.attempted || 0);
      skipped += Number(result.skipped || 0);
      retrying += Number(result.retrying || 0);
      failed += Number(result.failed || 0);
      rateLimited += Number(result.rateLimited || 0);
      if (Array.isArray(result.reasons)) warnings.push(...result.reasons.map((reason) => `${item.company || 'Unknown'} / ${item.title}: ${reason}`));
      if (!dryRun && (result.drafted || result.sent || result.failed || result.retrying)) updateStatuses(state, items);
    } catch (error) {
      record.status = 'error';
      record.lastError = error instanceof Error ? error.message : String(error);
      errors.push(`${item.company || 'Unknown'} / ${item.title}: ${record.lastError}`);
    }
  }
  updateStatuses(state, items);
  const summary = {
    ok: errors.length === 0 && failed === 0,
    at: new Date().toISOString(),
    dryRun,
    records: state.records.length,
    drafted,
    sent,
    attempted,
    skipped,
    retrying,
    failed,
    rateLimited,
    evidenceAudit,
    browser,
    confirmation,
    discoveries: discoveries.map((discovery) => ({
      company: discovery.company,
      title: discovery.title,
      status: discovery.status,
      reason: discovery.reason,
      contacts: Array.isArray(discovery.contacts) ? discovery.contacts.length : 0,
      emailHypotheses: Array.isArray(discovery.emailHypotheses) ? discovery.emailHypotheses.length : 0,
    })),
    responses,
    authorization: null,
    warnings,
    errors,
    outbox: summarizeOutbox(state),
  };
  if (!dryRun) {
    state.lastProcess = summary;
    state.updatedAt = summary.at;
    saveOutreachState(STATE_PATH, state);
  }
  console.log(`Outreach process${dryRun ? ' (dry run)' : ''}: ${state.records.length} record(s), ${drafted} Gmail draft(s) created.`);
  console.log(`  Outbox: ${summary.outbox.pending} pending, ${summary.outbox.draft_created} Gmail drafts, ${summary.outbox.unknown} uncertain, ${summary.outbox.failed} failed.`);
  if (rateLimited) console.log(`  Rate limit: ${rateLimited} message(s) held until the next UTC day.`);
  console.log(`  Browser application scan: ${browser.reason}`);
  console.log(`  Confirmation scan: ${confirmation.reason}`);
  for (const discovery of discoveries) {
    console.log(`  Contact discovery: ${discovery.company || 'Unknown'} / ${discovery.title || 'Unknown'} — ${discovery.reason || discovery.status}`);
  }
  console.log(`  Response scan: ${responses.reason}`);
  for (const record of state.records) printPrepared({ company: record.company, title: record.title }, record);
  for (const error of errors) console.log(`  ⚠️ ${error}`);
  for (const warning of warnings) console.log(`  ⚠️ ${warning}`);
  return { state, confirmation, sent, errors, summary, ok: summary.ok };
}

/** @param {string} applicationId @param {boolean} dryRun @param {boolean} force */
async function discover(applicationId, dryRun, force) {
  await loadDotenvOnce();
  const { items } = loadApplicationUniverse();
  const item = items.find((candidate) => candidate.id === applicationId || applicationKey(candidate) === applicationId);
  if (!item) throw new Error(`application not found: ${applicationId}`);
  const state = loadOutreachState(STATE_PATH);
  const record = findOutreachRecord(state, applicationKey(item)) || upsertSubmissionSignal(state, item, {
    source: 'manual_discovery',
    at: new Date().toISOString(),
  });
  const relationshipClient = await createRelationshipClient(dryRun);
  const result = await discoverForRecord(record, item, dryRun, { gmailClient: relationshipClient, force });
  if (!dryRun) {
    prepareRecord(
      state,
      item,
      true,
      Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [],
      Array.isArray(record.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [],
    );
    saveOutreachState(STATE_PATH, state);
  }
  console.log(JSON.stringify({ application: applicationKey(item), ...result }, null, 2));
}

/**
 * Reconcile every applied source and refresh contact evidence without creating
 * a Gmail draft. This is the safe entry point for broad outreach discovery.
 *
 * @param {boolean} dryRun
 * @param {boolean} force
 */
async function discoverApplied(dryRun, force) {
  await loadDotenvOnce();
  const { items, evidenceAudit } = loadApplicationUniverse();
  const state = loadOutreachState(STATE_PATH);
  ensureAppliedRecords(state, items, dryRun);
  const relationshipClient = await createRelationshipClient(dryRun);
  const sourceState = {};
  const results = [];
  for (const item of items.filter((candidate) => candidate.status === 'applied')) {
    const record = findOutreachRecord(state, applicationKey(item));
    if (!record || !hasConfirmedSubmission(record)) {
      results.push({ company: item.company, title: item.title, status: 'blocked', reason: 'submission is not confirmed by an evidence source' });
      continue;
    }
    const fitScore = item.fitScore == null || item.fitScore === '' ? null : Number(item.fitScore);
    const belowFitFloor = fitScore !== null && Number.isFinite(fitScore) && fitScore < 4;
    if (!isDiscoverableApplication(item, { allowMissingPostingUrl: true })) {
      results.push({ company: item.company, title: item.title, status: 'blocked', reason: 'exact company and role are required' });
      continue;
    }
    try {
      const result = await discoverForRecord(record, item, dryRun, {
        gmailClient: relationshipClient,
        force,
        sourceState,
        allowMissingPostingUrl: true,
      });
      if (!dryRun && !belowFitFloor) {
        prepareRecord(
          state,
          item,
          true,
          Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [],
          Array.isArray(record.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [],
        );
      }
      results.push({
        company: item.company,
        title: item.title,
        status: result.status,
        reason: belowFitFloor
          ? `contact research completed; outreach held because fit score ${fitScore.toFixed(1)}/5 is below the 4.0 floor`
          : result.reason || '',
        outreachEligible: !belowFitFloor,
        contacts: Array.isArray(record.discoveredContacts) ? record.discoveredContacts.length : 0,
        exactVerifiedEmails: (record.discoveredContacts || []).filter((contact) => contact.emailVerificationType === 'exact-public-source' && contact.emailVerified === true).length,
        linkedinProfiles: (record.discoveredContacts || []).filter((contact) => contact.profileUrl).length,
        xProfiles: (record.discoveredContacts || []).filter((contact) => contact.xProfileUrl).length,
      });
    } catch (error) {
      results.push({ company: item.company, title: item.title, status: 'error', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!dryRun) saveOutreachState(STATE_PATH, state);
  const summary = {
    ok: results.every((result) => result.status !== 'error'),
    dryRun,
    createsGmailDrafts: false,
    evidenceAudit,
    activeApplied: results.length,
    confirmedApplied: results.filter((result) => result.reason !== 'submission is not confirmed by an evidence source').length,
    unconfirmedApplied: results.filter((result) => result.reason === 'submission is not confirmed by an evidence source').length,
    searched: results.filter((result) => !['blocked', 'error'].includes(result.status)).length,
    outreachEligible: results.filter((result) => result.outreachEligible === true).length,
    researchOnly: results.filter((result) => result.outreachEligible === false).length,
    blocked: results.filter((result) => result.status === 'blocked').length,
    errors: results.filter((result) => result.status === 'error').length,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** @param {string} applicationId */
function pause(applicationId) {
  const state = loadOutreachState(STATE_PATH);
  const record = findOutreachRecord(state, applicationId);
  if (!record) throw new Error(`outreach record not found: ${applicationId}`);
  record.status = 'paused';
  record.updatedAt = new Date().toISOString();
  saveOutreachState(STATE_PATH, state);
  console.log(`Outreach paused for ${record.company} / ${record.title}.`);
}

async function enableEmail() {
  await loadDotenvOnce();
  const client = await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
  const account = await client.verifyAccount();
  const state = loadOutreachState(STATE_PATH);
  state.settings = { ...(state.settings || {}), emailEnabled: true, rampComplete: false, enabledAt: new Date().toISOString(), account };
  saveOutreachState(STATE_PATH, state);
  console.log(`Email outreach enabled for ${account}. Initial ramp limit is 2 email(s) per day.`);
}

/** @param {string[]} args */
async function authorizeSend(args) {
  throw new Error('direct outreach sending is disabled; process creates Gmail drafts for manual review and sending');
}

/** @param {boolean} complete */
function setRamp(complete) {
  const state = loadOutreachState(STATE_PATH);
  state.settings = { ...(state.settings || {}), rampComplete: complete };
  saveOutreachState(STATE_PATH, state);
  console.log(complete ? 'Outreach ramp completed; configured daily limit is active.' : 'Outreach ramp restored; daily limit is 2 initial emails.');
}

function status() {
  const state = loadOutreachState(STATE_PATH);
  const summary = (state.records || []).map((record) => ({
    key: record.key,
    company: record.company,
    title: record.title,
    status: record.status,
    submission: {
      confirmed: hasConfirmedSubmission(record),
      confirmedAt: record.submission?.confirmedAt || null,
      confirmedSource: record.submission?.confirmedSource || null,
      signalCount: Array.isArray(record.submission?.signals) ? record.submission.signals.length : 0,
    },
    discovery: record.discovery ? {
      status: record.discovery.status || 'unknown',
      attemptedAt: record.discovery.attemptedAt || null,
      cacheExpiresAt: record.discovery.cacheExpiresAt || null,
      nextAttemptAt: record.discovery.nextAttemptAt || null,
      candidateCount: record.discovery.candidateCount || 0,
      sourceCount: record.discovery.sourceCount || 0,
      conventionCount: Array.isArray(record.discovery.emailConventions) ? record.discovery.emailConventions.length : 0,
      hypothesisCount: Array.isArray(record.discovery.emailHypotheses) ? record.discovery.emailHypotheses.length : 0,
      exactVerifiedEmailCount: (record.contacts || []).filter((contact) => contact.emailVerificationType === 'exact-public-source' && contact.emailVerified === true).length,
      candidateEmailVerificationCount: Array.isArray(record.discovery.candidateEmailVerification) ? record.discovery.candidateEmailVerification.length : 0,
      reason: record.discovery.reason || '',
    } : null,
    contacts: (record.contacts || []).map((contact) => ({
      name: contact.name,
      type: contact.type,
      email: contact.email,
      emailEligible: contact.emailEligible,
      emailVerified: contact.emailVerified,
      emailVerificationType: contact.emailVerificationType,
      emailVerificationState: contact.emailVerificationState,
      guessed: contact.guessed,
      initial: contact.initial?.status || 'none',
      initialDelivery: contact.initial?.deliveryStatus || null,
      followUp: contact.followUp?.status || 'none',
      followUpDelivery: contact.followUp?.deliveryStatus || null,
      lastError: contact.initial?.lastError || contact.followUp?.lastError || null,
      linkedinDraft: contact.linkedinDraft || '',
      xProfileUrl: contact.xProfileUrl || '',
      xHandle: contact.xHandle || '',
      xDraft: contact.xDraft || '',
    })),
    nextActionAt: record.contacts?.map((contact) => contact.followUp?.dueAt).filter(Boolean).sort()[0] || null,
  }));
  console.log(JSON.stringify({ settings: state.settings || {}, lastProcess: state.lastProcess || null, outbox: summarizeOutbox(state), records: summary }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  if (command === 'prepare') { prepare(readFlag(args, '--application'), hasFlag(args, '--dry-run')); return; }
  if (command === 'repair-invalid-contacts') { repairInvalidRelationshipContacts(); return; }
  if (command === 'discover') { await discover(readFlag(args, '--application'), hasFlag(args, '--dry-run'), hasFlag(args, '--force')); return; }
  if (command === 'discover-applied') {
    const result = await discoverApplied(hasFlag(args, '--dry-run'), hasFlag(args, '--force'));
    if (!result.ok && !result.dryRun) process.exitCode = 2;
    return;
  }
  if (command === 'discover-queue') {
    const result = await discoverQueue(hasFlag(args, '--dry-run'), Number(readFlag(args, '--limit', String(DEFAULT_CONTACT_DISCOVERY_LIMIT))), hasFlag(args, '--force'));
    if (!result.ok && !result.dryRun) process.exitCode = 2;
    return;
  }
  if (command === 'process') {
    const result = await processOutreach(hasFlag(args, '--dry-run'));
    if (!result.ok && !result.summary.dryRun) process.exitCode = 2;
    return;
  }
  if (command === 'status') { status(); return; }
  if (command === 'pause') { pause(readFlag(args, '--application')); return; }
  if (command === 'authorize-send') { await authorizeSend(args); return; }
  if (command === 'enable-email') { await enableEmail(); return; }
  if (command === 'disable-email') {
    const state = loadOutreachState(STATE_PATH);
    state.settings = { ...(state.settings || {}), emailEnabled: false, disabledAt: new Date().toISOString() };
    saveOutreachState(STATE_PATH, state);
    console.log('Email outreach disabled.');
    return;
  }
  if (command === 'ramp-complete') { setRamp(true); return; }
  if (command === 'ramp-reset') { setRamp(false); return; }
  throw new Error('Usage: node outreach.mjs prepare|repair-invalid-contacts|discover [--force]|discover-applied [--force]|discover-queue [--limit N]|process|status|pause|enable-email|disable-email|ramp-complete|ramp-reset');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof GmailClientError) console.error(`outreach: ${error.message}`);
    else console.error(`outreach: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
