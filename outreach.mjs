#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GmailClientError,
  TARGET_GMAIL_ACCOUNT,
  createGmailClient,
} from './gmail-client.mjs';
import {
  discoverContactsForApplication,
  isDiscoverableApplication,
  verifyPublicCandidateEmails,
} from './contact-discovery.mjs';
import { discoverWarmContactsForApplication } from './relationship-discovery.mjs';
import { getMessageBody, isAuthenticEmail } from './plugins/gmail/_helpers.mjs';
import { loadDotenvOnce } from './plugins/_engine.mjs';
import {
  applicationKey,
  loadProfile,
  readQueueState,
  renderQueueMarkdown,
  writeQueueState,
} from './queue-lib.mjs';
import {
  OUTREACH_CONTACTS_PATH,
  OUTREACH_STATE_PATH,
  OUTREACH_MAX_SEND_ATTEMPTS,
  OUTREACH_SEND_STALE_MS,
  addBusinessDays,
  buildContactSearchQuery,
  buildEmailMessage,
  buildLinkedInDraft,
  countSentForDay,
  discoveryCacheTtlMs,
  ensureOutboxEntry,
  findOutreachRecord,
  followUpSuppressed,
  hasConfirmedSubmission,
  loadOutreachPolicy,
  loadOutreachState,
  matchesApplicationConfirmation,
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
const DISCOVERY_PIPELINE_VERSION = 10;

/** @typedef {{
 *  verifyAccount: () => Promise<string>,
 *  listMessages: (query: string, options?: { limit?: number }) => Promise<Array<{ id: string, threadId?: string }>>,
 *  getMessage: (id: string, format?: string) => Promise<Record<string, unknown>>,
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

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {boolean} dryRun @param {Array<Record<string, unknown>>} [discoveredContacts] */
function prepareRecord(state, item, dryRun, discoveredContacts = []) {
  const record = upsertSubmissionSignal(state, item, {
    source: 'queue_applied',
    at: item.appliedAt || new Date().toISOString(),
  });
  if (record.status === 'needs_application_identity') return record;
  const profile = loadProfile(ROOT);
  const policy = loadOutreachPolicy(profile);
  const persistedContacts = Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [];
  const importedContacts = Array.isArray(item.outreach?.discovery?.contacts) ? item.outreach.discovery.contacts : [];
  const contacts = selectContacts(rankContacts([
    ...contactsForItem(item, loadContactManifest()),
    ...persistedContacts,
    ...discoveredContacts,
    ...importedContacts,
  ], item), policy.maxContactsPerApplication);
  const existing = new Map((record.contacts || []).map((contact) => [contact.id, contact]));
  record.contacts = contacts.map((contact) => {
    const old = existing.get(contact.id);
    const generatedInitial = contact.emailEligible
      ? { ...buildEmailMessage(profile, item, contact, 'initial'), status: 'pending', sentAt: null, gmailMessageId: null, threadId: null, outboxId: null }
      : { status: 'no_verified_email', subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null, threadId: null, outboxId: null };
    const existingInitialStatus = String(old?.initial?.status || '');
    const initial = old?.initial && ['sent', 'pending', 'sending', 'unknown', 'failed'].includes(existingInitialStatus)
      ? { ...generatedInitial, ...old.initial }
      : generatedInitial;
    const followUp = old?.followUp
      ? { status: 'not_scheduled', dueAt: null, subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null, threadId: null, outboxId: null, ...old.followUp }
      : { status: 'not_scheduled', dueAt: null, subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null, threadId: null, outboxId: null };
    return {
      ...contact,
      profileUrl: contact.profileUrl,
      linkedinDraft: buildLinkedInDraft(loadProfile(ROOT), item, contact),
      initial,
      followUp,
      replied: old?.replied === true,
      bounced: old?.bounced === true,
      optedOut: old?.optedOut === true,
      responseMessageId: old?.responseMessageId || null,
    };
  });
  record.searchQuery = buildContactSearchQuery(item);
  if (!hasConfirmedSubmission(record)) record.status = 'awaiting_submission_confirmation';
  else if (record.contacts.length) record.status = 'drafted';
  else record.status = 'awaiting_contacts';
  record.updatedAt = new Date().toISOString();
  if (!dryRun) saveOutreachState(STATE_PATH, state);
  return record;
}

/** @param {Record<string, unknown>} record @param {Record<string, unknown>} item @param {boolean} dryRun @param {{ gmailClient?: RelationshipClient | null, force?: boolean }} [options] */
async function discoverForRecord(record, item, dryRun, options = {}) {
  if (record.status === 'paused' || record.status === 'suppressed' || record.status === 'needs_application_identity') {
    return { status: 'skipped', reason: `record status is ${record.status}`, contacts: [], emailConventions: [], emailHypotheses: [], emailVerification: [], candidateEmailVerification: [], sources: [], queries: [], errors: [] };
  }
  if (!isDiscoverableApplication(item)) {
    record.status = 'needs_application_identity';
    record.suppressionReason = 'application evidence does not identify a specific employer';
    record.discovery = {
      status: 'blocked',
      attemptedAt: new Date().toISOString(),
      candidateCount: 0,
      sourceCount: 0,
      reason: 'application identity is not specific enough for contact discovery',
    };
    return { status: 'blocked', reason: 'application identity is not specific enough for contact discovery', contacts: [], emailConventions: [], emailHypotheses: [], emailVerification: [], candidateEmailVerification: [], sources: [], queries: [], errors: [] };
  }
  const attemptedAt = String(record.discovery?.attemptedAt || '');
  const attemptedAtMs = new Date(attemptedAt).getTime();
  const legacyExpiry = Number.isFinite(attemptedAtMs)
    ? attemptedAtMs + discoveryCacheTtlMs(String(record.discovery?.status || 'error'), Number(record.discovery?.candidateCount || 0))
    : 0;
  const cacheExpiresAtMs = new Date(record.discovery?.cacheExpiresAt || legacyExpiry || 0).getTime();
  if (Number.isFinite(cacheExpiresAtMs)
    && cacheExpiresAtMs > Date.now()
    && record.discovery?.pipelineVersion === DISCOVERY_PIPELINE_VERSION
    && options.force !== true
    && Array.isArray(record.discoveredContacts)) {
    return {
      status: String(record.discovery?.status || 'cached'),
      reason: `cached until ${new Date(cacheExpiresAtMs).toISOString()}`,
      contacts: record.discoveredContacts,
      emailConventions: Array.isArray(record.discovery?.emailConventions) ? record.discovery.emailConventions : [],
      emailHypotheses: Array.isArray(record.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [],
      emailVerification: Array.isArray(record.discovery?.emailVerification) ? record.discovery.emailVerification : [],
      candidateEmailVerification: Array.isArray(record.discovery?.candidateEmailVerification) ? record.discovery.candidateEmailVerification : [],
      sources: Array.isArray(record.discovery?.sources) ? record.discovery.sources : [],
      queries: Array.isArray(record.discovery?.queries) ? record.discovery.queries : [],
      errors: Array.isArray(record.discovery?.errors) ? record.discovery.errors : [],
    };
  }
  const publicResult = await discoverContactsForApplication(item, { dryRun });
  const warmResult = await discoverWarmContactsForApplication(item, loadProfile(ROOT), {
    dryRun,
    gmailClient: options.gmailClient || null,
  });
  const candidateEmailResult = warmResult.contacts?.length
    ? await verifyPublicCandidateEmails(
      warmResult.contacts.filter((contact) => !String(contact.email || '').trim()),
      item,
    )
    : { contacts: [], queries: [], sources: [], verifications: [], errors: [] };
  const previousContacts = Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [];
  const contacts = [...publicResult.contacts, ...warmResult.contacts, ...candidateEmailResult.contacts];
  const status = contacts.length
    ? 'found'
    : publicResult.status === 'unavailable' || warmResult.status === 'unavailable'
      ? 'unavailable'
      : publicResult.status === 'error' || warmResult.status === 'error' || publicResult.errors.length || warmResult.errors.length
        ? 'error'
      : 'no_contacts';
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
  const result = {
    status,
    reason: [publicResult.reason, warmResult.reason].filter(Boolean).join('; '),
    contacts,
    emailConventions,
    emailHypotheses,
    emailVerification,
    candidateEmailVerification,
    queries: [...publicResult.queries, ...warmResult.gmailQueries, ...warmResult.webQueries, ...candidateEmailResult.queries],
    sources: [...new Set([...publicResult.sources, ...warmResult.sources, ...candidateEmailResult.sources])],
    errors: [...new Set([...publicResult.errors, ...warmResult.errors, ...candidateEmailResult.errors])],
    phases: {
      public: publicResult,
      warmNetwork: warmResult,
      candidateEmailVerification: candidateEmailResult,
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
      pipelineVersion: DISCOVERY_PIPELINE_VERSION,
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
      emailConventions,
      emailHypotheses,
      emailVerification,
      candidateEmailVerification,
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
  if (discovery.pipelineVersion !== DISCOVERY_PIPELINE_VERSION) return true;
  const expiresAt = new Date(String(discovery.cacheExpiresAt || '')).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

/** @param {Record<string, unknown>} record */
function queueDiscoverySnapshot(record) {
  const discovery = record.discovery && typeof record.discovery === 'object' ? record.discovery : {};
  return {
    pipelineVersion: DISCOVERY_PIPELINE_VERSION,
    mode: 'queue-import',
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
    contacts: Array.isArray(record.discoveredContacts) ? record.discoveredContacts.slice(0, 25) : [],
    emailConventions: Array.isArray(discovery.emailConventions) ? discovery.emailConventions : [],
    emailHypotheses: Array.isArray(discovery.emailHypotheses) ? discovery.emailHypotheses : [],
    emailVerification: Array.isArray(discovery.emailVerification) ? discovery.emailVerification : [],
    candidateEmailVerification: Array.isArray(discovery.candidateEmailVerification) ? discovery.candidateEmailVerification : [],
  };
}

/** @param {boolean} dryRun @param {number} requestedLimit @param {boolean} force */
async function discoverQueue(dryRun, requestedLimit, force) {
  await loadDotenvOnce();
  const queue = readQueueState(QUEUE_PATH);
  const items = Array.isArray(queue.items) ? queue.items : [];
  const limit = Math.min(20, Math.max(1, Number(requestedLimit || 10)));
  const due = items
    .filter((item) => ['ready', 'in_review'].includes(String(item.status || '')))
    .filter((item) => isDiscoverableApplication(item) && queueDiscoveryDue(item, force))
    .sort((left, right) => {
      const selected = Number(right.selectedForToday === true) - Number(left.selectedForToday === true);
      if (selected) return selected;
      return Number(left.queueRank || 999) - Number(right.queueRank || 999)
        || String(left.firstSeenAt || '').localeCompare(String(right.firstSeenAt || ''));
    });
  const batch = due.slice(0, limit);
  const relationshipClient = batch.length ? await createRelationshipClient(dryRun) : null;
  const results = [];
  const errors = [];

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
      });
      const discoveryErrors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
      if (result.status === 'error' || discoveryErrors.length) {
        errors.push(`${item.company || 'Unknown'} / ${item.title || 'Job lead'}: ${discoveryErrors.join('; ') || result.reason || 'contact discovery returned an error'}`);
      }
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
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${item.company || 'Unknown'} / ${item.title || 'Job lead'}: ${reason}`);
      if (!dryRun) {
        item.outreach = {
          ...(item.outreach && typeof item.outreach === 'object' ? item.outreach : {}),
          discovery: {
            pipelineVersion: DISCOVERY_PIPELINE_VERSION,
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
  };
  console.log(`Queue contact discovery${dryRun ? ' (dry run)' : ''}: ${batch.length} role(s) attempted, ${summary.deferred} deferred.`);
  for (const result of results) {
    console.log(`  ${result.company || 'Unknown'} / ${result.title || 'Job lead'} — ${result.status}; ${result.emails} email(s), ${result.hypotheses} review-only hypothesis/hypotheses`);
  }
  for (const error of errors) console.log(`  ⚠️ ${error}`);
  return summary;
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} record */
function printPrepared(item, record) {
  console.log(`${item.company || 'Unknown company'} | ${item.title || 'Job lead'} | ${record.status}`);
  console.log(`  Search: ${record.searchQuery || buildContactSearchQuery(item)}`);
  for (const contact of record.contacts || []) {
    console.log(`  ${contact.type}: ${contact.name} — ${contact.title}`);
    if (contact.relationshipLabel) console.log(`    Relationship: ${contact.relationshipLabel}`);
    console.log(`    Email: ${contact.email || 'not eligible'}${contact.emailVerified ? ' (verified public professional)' : ''}`);
    if (contact.initial?.subject) console.log(`    Email subject: ${contact.initial.subject}`);
    if (contact.linkedinDraft) console.log(`    LinkedIn draft: ${contact.linkedinDraft}`);
  }
  const hypotheses = Array.isArray(record.discovery?.emailHypotheses) ? record.discovery.emailHypotheses : [];
  if (hypotheses.length) {
    console.log(`  Review-only email hypotheses (${hypotheses.length}; exact verification required before any send):`);
    for (const hypothesis of hypotheses) {
      const verification = hypothesis.emailVerificationState === 'verified-exact-public-source'
        ? '; exact public evidence found; verified contact created'
        : '';
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

/** @param {RelationshipClient} client */
async function loadSentOutreachIndex(client) {
  const messages = await client.listMessages('in:sent newer_than:30d', { limit: 200 });
  const index = new Map();
  for (const summary of messages) {
    const message = await client.getMessage(summary.id, 'metadata');
    const outreachId = header(messageHeaders(message), 'x-career-ops-outreach-id');
    if (outreachId) index.set(outreachId, { id: summary.id, threadId: summary.threadId || message.threadId || null });
  }
  return index;
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
    const followUpMessage = buildEmailMessage(loadProfile(ROOT), item, contact, 'followup');
    contact.followUp = {
      ...contact.followUp,
      status: 'scheduled',
      dueAt: addBusinessDays(sentAt, policy.followUpBusinessDays),
      threadId,
      outboxId: null,
      ...followUpMessage,
    };
  }
  record.updatedAt = now;
}

/** @param {Record<string, unknown>} state @param {Array<Record<string, unknown>>} items @param {RelationshipClient} client */
function reconcileOutbox(state, items, client, sentIndex) {
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
    if (entry.status === 'sending') {
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
  for (const contact of record.contacts || []) {
    if (contact.emailVerified && contact.email && ['pending', 'unknown', 'sending', 'failed'].includes(contact.initial?.status)) {
      const initial = messageForSend(item, {
        to: contact.email,
        subject: contact.initial.subject,
        body: contact.initial.body,
        hash: contact.initial.hash,
      });
      const entry = ensureOutboxEntry(state, {
        recordKey: record.key,
        contactId: contact.id,
        kind: 'initial',
        ...initial,
      });
      contact.initial.outboxId = entry.id;
    }
    if (contact.emailVerified && contact.email && contact.followUp?.status === 'scheduled') {
      const followUp = messageForSend(item, {
        to: contact.email,
        subject: contact.followUp.subject,
        body: contact.followUp.body,
        hash: contact.followUp.hash,
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

/** @param {Date} [date] */
function nextUtcDay(date = new Date()) {
  const next = new Date(date);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {Record<string, unknown>} record @param {Record<string, unknown>} policy @param {boolean} dryRun */
async function sendPending(state, item, record, policy, dryRun) {
  const base = { sent: 0, attempted: 0, skipped: 0, retrying: 0, failed: 0, rateLimited: 0, reasons: [] };
  if (!hasConfirmedSubmission(record)) return { ...base, skipped: 1, reason: 'waiting for explicit submission confirmation; no email was attempted' };
  const settings = state.settings || {};
  if (dryRun || settings.emailEnabled !== true || policy.enabled !== true) return { ...base, skipped: 1, reason: 'email sending is disabled or dry-run mode is active' };
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) return { ...base, skipped: 1, reason: 'Gmail OAuth credentials are not configured' };
  const initialLimit = settings.rampComplete === true ? policy.dailyInitialEmailLimit : policy.rampInitialEmailLimit;
  const followUpLimit = policy.dailyFollowUpLimit;
  let initialSent = countSentForDay(state, 'initial');
  let followUpSent = countSentForDay(state, 'followup');
  const client = await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
  await client.verifyAccount();
  const sentIndex = await loadSentOutreachIndex(client);
  reconcileOutbox(state, [item], client, sentIndex);
  enqueueOutboxEntries(state, item, record, policy);
  saveOutreachState(STATE_PATH, state);
  const entries = (state.outbox || [])
    .filter((entry) => entry.recordKey === record.key)
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
    if (entry.kind === 'initial' && initialSent >= initialLimit) {
      entry.nextAttemptAt = nextUtcDay();
      entry.updatedAt = new Date().toISOString();
      base.skipped += 1;
      base.rateLimited += 1;
      continue;
    }
    if (entry.kind === 'followup' && followUpSent >= followUpLimit) {
      entry.nextAttemptAt = nextUtcDay();
      entry.updatedAt = new Date().toISOString();
      base.skipped += 1;
      base.rateLimited += 1;
      continue;
    }
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
    entry.status = 'sending';
    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.updatedAt = new Date().toISOString();
    saveOutreachState(STATE_PATH, state);
    base.attempted += 1;
    try {
      const result = await client.sendMessage({
        ...message,
        threadId: entry.threadId || undefined,
        headers: { 'X-Career-Ops-Outreach-ID': entry.id },
      });
      markOutboxAccepted(state, item, record, entry, result, policy);
      saveOutreachState(STATE_PATH, state);
      base.sent += 1;
      if (entry.kind === 'initial') initialSent += 1;
      else followUpSent += 1;
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
  return { ...base, initialSent, followUpSent, outbox: summarizeOutbox(state) };
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
    const pendingFollowUp = contacts.some((contact) => contact.followUp?.status === 'scheduled');
    const pendingInitial = contacts.some((contact) => contact.initial?.status === 'pending' && contact.emailVerified);
    const retrying = contacts.some((contact) => ['unknown', 'sending'].includes(contact.initial?.status) || ['unknown', 'sending'].includes(contact.followUp?.status));
    const failed = contacts.some((contact) => ['failed'].includes(contact.initial?.status) || ['failed'].includes(contact.followUp?.status));
    record.status = failed ? 'error' : retrying ? 'retrying' : pendingInitial ? 'drafted' : pendingFollowUp ? 'followup_scheduled' : initialSent ? 'complete' : 'linkedin_ready';
    record.updatedAt = new Date().toISOString();
  }
}

/** @param {string} applicationId @param {boolean} dryRun */
function prepare(applicationId, dryRun) {
  const queue = readQueueState(QUEUE_PATH);
  const items = Array.isArray(queue.items) ? queue.items : [];
  const item = items.find((candidate) => candidate.id === applicationId || applicationKey(candidate) === applicationId);
  if (!item) throw new Error(`application not found: ${applicationId}`);
  if (item.status !== 'applied') throw new Error('outreach preparation requires the role to be recorded as applied');
  const state = loadOutreachState(STATE_PATH);
  const record = prepareRecord(state, item, dryRun);
  printPrepared(item, record);
  return record;
}

/** @param {boolean} dryRun */
async function processOutreach(dryRun) {
  await loadDotenvOnce();
  const queue = readQueueState(QUEUE_PATH);
  const items = Array.isArray(queue.items) ? queue.items : [];
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
    if (item) prepareRecord(state, item, true, Array.isArray(record.discoveredContacts) ? record.discoveredContacts : []);
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
      const result = await sendPending(state, item, record, policy, dryRun);
      sent += Number(result.sent || 0);
      attempted += Number(result.attempted || 0);
      skipped += Number(result.skipped || 0);
      retrying += Number(result.retrying || 0);
      failed += Number(result.failed || 0);
      rateLimited += Number(result.rateLimited || 0);
      if (Array.isArray(result.reasons)) warnings.push(...result.reasons.map((reason) => `${item.company || 'Unknown'} / ${item.title}: ${reason}`));
      if (!dryRun && (result.sent || result.failed || result.retrying)) updateStatuses(state, items);
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
    sent,
    attempted,
    skipped,
    retrying,
    failed,
    rateLimited,
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
    warnings,
    errors,
    outbox: summarizeOutbox(state),
  };
  if (!dryRun) {
    state.lastProcess = summary;
    state.updatedAt = summary.at;
    saveOutreachState(STATE_PATH, state);
  }
  console.log(`Outreach process${dryRun ? ' (dry run)' : ''}: ${state.records.length} record(s), ${sent} email(s) accepted by Gmail.`);
  console.log(`  Outbox: ${summary.outbox.pending} pending, ${summary.outbox.unknown} uncertain, ${summary.outbox.failed} failed, ${summary.outbox.accepted} accepted.`);
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
  const queue = readQueueState(QUEUE_PATH);
  const items = Array.isArray(queue.items) ? queue.items : [];
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
    prepareRecord(state, item, true, Array.isArray(record.discoveredContacts) ? record.discoveredContacts : []);
    saveOutreachState(STATE_PATH, state);
  }
  console.log(JSON.stringify({ application: applicationKey(item), ...result }, null, 2));
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
      emailVerified: contact.emailVerified,
      initial: contact.initial?.status || 'none',
      initialDelivery: contact.initial?.deliveryStatus || null,
      followUp: contact.followUp?.status || 'none',
      followUpDelivery: contact.followUp?.deliveryStatus || null,
      lastError: contact.initial?.lastError || contact.followUp?.lastError || null,
      linkedinDraft: contact.linkedinDraft || '',
    })),
    nextActionAt: record.contacts?.map((contact) => contact.followUp?.dueAt).filter(Boolean).sort()[0] || null,
  }));
  console.log(JSON.stringify({ settings: state.settings || {}, lastProcess: state.lastProcess || null, outbox: summarizeOutbox(state), records: summary }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  if (command === 'prepare') { prepare(readFlag(args, '--application'), hasFlag(args, '--dry-run')); return; }
  if (command === 'discover') { await discover(readFlag(args, '--application'), hasFlag(args, '--dry-run'), hasFlag(args, '--force')); return; }
  if (command === 'discover-queue') {
    const result = await discoverQueue(hasFlag(args, '--dry-run'), Number(readFlag(args, '--limit', '10')), hasFlag(args, '--force'));
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
  throw new Error('Usage: node outreach.mjs prepare|discover [--force]|discover-queue [--limit N]|process|status|pause|enable-email|disable-email|ramp-complete|ramp-reset');
}

main().catch((error) => {
  if (error instanceof GmailClientError) console.error(`outreach: ${error.message}`);
  else console.error(`outreach: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
