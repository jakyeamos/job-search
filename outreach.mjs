#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from 'node:fs';
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
} from './contact-discovery.mjs';
import { discoverWarmContactsForApplication } from './relationship-discovery.mjs';
import { getMessageBody, isAuthenticEmail } from './plugins/gmail/_helpers.mjs';
import { loadDotenvOnce } from './plugins/_engine.mjs';
import {
  applicationKey,
  loadProfile,
  readQueueState,
} from './queue-lib.mjs';
import {
  OUTREACH_CONTACTS_PATH,
  OUTREACH_STATE_PATH,
  addBusinessDays,
  buildContactSearchQuery,
  buildEmailMessage,
  buildLinkedInDraft,
  countSentForDay,
  findOutreachRecord,
  followUpSuppressed,
  loadOutreachPolicy,
  loadOutreachState,
  matchesApplicationConfirmation,
  messageForSend,
  rankContacts,
  saveOutreachState,
  selectContacts,
  upsertSubmissionSignal,
} from './outreach-lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');
const APPLICATION_RUNS_PATH = path.join(ROOT, 'data', 'application-runs.json');
const STATE_PATH = path.join(ROOT, OUTREACH_STATE_PATH);
const CONTACTS_PATH = path.join(ROOT, OUTREACH_CONTACTS_PATH);
const CONFIRMATION_QUERY = 'in:anywhere {subject:"application received" subject:"thank you for applying" subject:"thanks for applying" subject:"application submitted" subject:"we received your application"} newer_than:30d';
const DISCOVERY_PIPELINE_VERSION = 6;

/** @typedef {{
 *  listMessages: (query: string, options?: { limit?: number }) => Promise<Array<{ id: string, threadId?: string }>>,
 *  getMessage: (id: string, format?: string) => Promise<Record<string, unknown>>,
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

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {boolean} dryRun @param {Array<Record<string, unknown>>} [discoveredContacts] */
function prepareRecord(state, item, dryRun, discoveredContacts = []) {
  const record = upsertSubmissionSignal(state, item, {
    source: 'queue_applied',
    at: item.appliedAt || new Date().toISOString(),
  });
  if (record.status === 'needs_application_identity') return record;
  const policy = loadOutreachPolicy(loadProfile(ROOT));
  const persistedContacts = Array.isArray(record.discoveredContacts) ? record.discoveredContacts : [];
  const contacts = selectContacts(rankContacts([
    ...contactsForItem(item, loadContactManifest()),
    ...persistedContacts,
    ...discoveredContacts,
  ], item), policy.maxContactsPerApplication);
  const existing = new Map((record.contacts || []).map((contact) => [contact.id, contact]));
  record.contacts = contacts.map((contact) => {
    const old = existing.get(contact.id);
    const initial = old?.initial?.status === 'sent'
      ? old.initial
      : contact.emailEligible
        ? { ...buildEmailMessage(loadProfile(ROOT), item, contact, 'initial'), status: 'pending', sentAt: null, gmailMessageId: null }
        : { status: 'no_verified_email', subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null };
    const followUp = old?.followUp || { status: 'not_scheduled', dueAt: null, subject: null, body: null, hash: null, sentAt: null, gmailMessageId: null };
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
  record.status = record.contacts.length ? 'drafted' : 'awaiting_contacts';
  record.updatedAt = new Date().toISOString();
  if (!dryRun) saveOutreachState(STATE_PATH, state);
  return record;
}

/** @param {Record<string, unknown>} record @param {Record<string, unknown>} item @param {boolean} dryRun @param {{ gmailClient?: RelationshipClient | null }} [options] */
async function discoverForRecord(record, item, dryRun, options = {}) {
  if (record.status === 'paused' || record.status === 'suppressed' || record.status === 'needs_application_identity') {
    return { status: 'skipped', reason: `record status is ${record.status}`, contacts: [], sources: [], queries: [], errors: [] };
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
    return { status: 'blocked', reason: 'application identity is not specific enough for contact discovery', contacts: [], sources: [], queries: [], errors: [] };
  }
  const attemptedAt = String(record.discovery?.attemptedAt || '');
  const age = attemptedAt ? Date.now() - new Date(attemptedAt).getTime() : Number.POSITIVE_INFINITY;
  if (Number.isFinite(age)
    && age < 7 * 24 * 60 * 60 * 1000
    && record.discovery?.pipelineVersion === DISCOVERY_PIPELINE_VERSION
    && Array.isArray(record.discoveredContacts)) {
    return {
      status: String(record.discovery?.status || 'cached'),
      reason: 'recent discovery result reused',
      contacts: record.discoveredContacts,
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
  const result = {
    status: publicResult.contacts.length || warmResult.contacts.length
      ? 'found'
      : publicResult.status === 'unavailable' && warmResult.status === 'no_contacts'
        ? 'unavailable'
        : publicResult.status,
    reason: [publicResult.reason, warmResult.reason].filter(Boolean).join('; '),
    contacts: [...publicResult.contacts, ...warmResult.contacts],
    queries: [...publicResult.queries, ...warmResult.gmailQueries, ...warmResult.webQueries],
    sources: [...new Set([...publicResult.sources, ...warmResult.sources])],
    errors: [...new Set([...publicResult.errors, ...warmResult.errors])],
    phases: {
      public: publicResult,
      warmNetwork: warmResult,
    },
  };
  if (!dryRun) {
    record.discoveredContacts = result.contacts;
    record.discovery = {
      pipelineVersion: DISCOVERY_PIPELINE_VERSION,
      status: result.status,
      attemptedAt: new Date().toISOString(),
      candidateCount: result.contacts.length,
      sourceCount: result.sources.length,
      reason: result.reason,
      queries: result.queries,
      sources: result.sources,
      errors: result.errors,
      phases: result.phases,
    };
  }
  return result;
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
    if (!dryRun) upsertSubmissionSignal(state, item, {
      source: 'browser_confirmation',
      at: String(run.finishedAt || result.finishedAt || new Date().toISOString()),
    });
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
  for (const summary of messages) {
    const message = await client.getMessage(summary.id, 'full');
    const headers = messageHeaders(message);
    const subject = header(headers, 'subject');
    const from = header(headers, 'from');
    const body = getMessageBody(message.payload);
    if (!isAuthenticEmail(headers)) continue;
    const item = items.find((candidate) => matchesApplicationConfirmation(subject, from, body, candidate));
    if (!item) continue;
    matched += 1;
    if (!dryRun) upsertSubmissionSignal(state, item, {
      source: 'gmail_confirmation',
      at: new Date(Number(message.internalDate || Date.now())).toISOString(),
      messageId: summary.id,
      subject,
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

/** @param {Record<string, unknown>} state @param {Array<Record<string, unknown>>} items @param {boolean} dryRun */
function ensureAppliedRecords(state, items, dryRun) {
  for (const item of items.filter((candidate) => candidate.status === 'applied')) {
    if (!findOutreachRecord(state, applicationKey(item))) {
      upsertSubmissionSignal(state, item, { source: 'queue_applied', at: item.appliedAt || new Date().toISOString() });
    }
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

/** @param {Record<string, unknown>} state @param {Record<string, unknown>} item @param {Record<string, unknown>} record @param {Record<string, unknown>} policy @param {boolean} dryRun */
async function sendPending(state, item, record, policy, dryRun) {
  const settings = state.settings || {};
  if (dryRun || settings.emailEnabled !== true || policy.enabled !== true) return { sent: 0, skipped: 'email sending is disabled or dry-run mode is active' };
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) return { sent: 0, skipped: 'Gmail OAuth credentials are not configured' };
  const initialLimit = settings.rampComplete === true ? policy.dailyInitialEmailLimit : policy.rampInitialEmailLimit;
  const followUpLimit = policy.dailyFollowUpLimit;
  let initialSent = countSentForDay(state, 'initial');
  let followUpSent = countSentForDay(state, 'followup');
  const client = await createGmailClient({ expectedAccount: TARGET_GMAIL_ACCOUNT });
  await client.verifyAccount();
  let sent = 0;
  for (const contact of record.contacts || []) {
    if (contact.initial?.status === 'pending' && contact.emailVerified && initialSent < initialLimit) {
      const message = messageForSend(item, { to: contact.email, subject: contact.initial.subject, body: contact.initial.body, hash: contact.initial.hash });
      const result = await client.sendMessage(message);
      contact.initial = {
        ...contact.initial,
        status: 'sent',
        sentAt: new Date().toISOString(),
        gmailMessageId: result.id || null,
        threadId: result.threadId || null,
      };
      contact.followUp = {
        ...contact.followUp,
        status: 'scheduled',
        dueAt: addBusinessDays(contact.initial.sentAt, policy.followUpBusinessDays),
        ...buildEmailMessage(loadProfile(ROOT), item, contact, 'followup'),
      };
      initialSent += 1;
      sent += 1;
    }
  }
  const now = new Date();
  for (const contact of record.contacts || []) {
    if (followUpSent >= followUpLimit || followUpSuppressed(record, contact)) continue;
    if (contact.followUp?.status !== 'scheduled' || !contact.followUp.dueAt || new Date(contact.followUp.dueAt) > now) continue;
    const message = messageForSend(item, { to: contact.email, subject: contact.followUp.subject, body: contact.followUp.body, hash: contact.followUp.hash });
    const result = await client.sendMessage(message);
    contact.followUp = {
      ...contact.followUp,
      status: 'sent',
      sentAt: new Date().toISOString(),
      gmailMessageId: result.id || null,
      threadId: result.threadId || null,
    };
    followUpSent += 1;
    sent += 1;
  }
  return { sent, initialSent, followUpSent };
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
    const contacts = record.contacts || [];
    if (!contacts.length) { record.status = 'awaiting_contacts'; continue; }
    const initialSent = contacts.filter((contact) => contact.initial?.status === 'sent').length;
    const pendingFollowUp = contacts.some((contact) => contact.followUp?.status === 'scheduled');
    const pendingInitial = contacts.some((contact) => contact.initial?.status === 'pending' && contact.emailVerified);
    record.status = pendingInitial ? 'drafted' : pendingFollowUp ? 'followup_scheduled' : initialSent ? 'complete' : 'linkedin_ready';
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
  const errors = [];
  for (const record of state.records || []) {
    const item = items.find((candidate) => applicationKey(candidate) === record.key);
    if (!item) continue;
    try {
      const result = await sendPending(state, item, record, policy, dryRun);
      sent += Number(result.sent || 0);
      if (!dryRun && result.sent) updateStatuses(state, items);
    } catch (error) {
      record.status = 'error';
      record.lastError = error instanceof Error ? error.message : String(error);
      errors.push(`${item.company || 'Unknown'} / ${item.title}: ${record.lastError}`);
    }
  }
  updateStatuses(state, items);
  if (!dryRun) {
    state.updatedAt = new Date().toISOString();
    saveOutreachState(STATE_PATH, state);
  }
  console.log(`Outreach process${dryRun ? ' (dry run)' : ''}: ${state.records.length} record(s), ${sent} email(s) sent.`);
  console.log(`  Browser application scan: ${browser.reason}`);
  console.log(`  Confirmation scan: ${confirmation.reason}`);
  for (const discovery of discoveries) {
    console.log(`  Contact discovery: ${discovery.company || 'Unknown'} / ${discovery.title || 'Unknown'} — ${discovery.reason || discovery.status}`);
  }
  console.log(`  Response scan: ${responses.reason}`);
  for (const record of state.records) printPrepared({ company: record.company, title: record.title }, record);
  for (const error of errors) console.log(`  ⚠️ ${error}`);
  return { state, confirmation, sent, errors };
}

/** @param {string} applicationId @param {boolean} dryRun */
async function discover(applicationId, dryRun) {
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
  const result = await discoverForRecord(record, item, dryRun, { gmailClient: relationshipClient });
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
    discovery: record.discovery ? {
      status: record.discovery.status || 'unknown',
      attemptedAt: record.discovery.attemptedAt || null,
      candidateCount: record.discovery.candidateCount || 0,
      sourceCount: record.discovery.sourceCount || 0,
      reason: record.discovery.reason || '',
    } : null,
    contacts: (record.contacts || []).map((contact) => ({
      name: contact.name,
      type: contact.type,
      email: contact.email,
      emailVerified: contact.emailVerified,
      initial: contact.initial?.status || 'none',
      followUp: contact.followUp?.status || 'none',
      linkedinDraft: contact.linkedinDraft || '',
    })),
    nextActionAt: record.contacts?.map((contact) => contact.followUp?.dueAt).filter(Boolean).sort()[0] || null,
  }));
  console.log(JSON.stringify({ settings: state.settings || {}, records: summary }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  if (command === 'prepare') { prepare(readFlag(args, '--application'), hasFlag(args, '--dry-run')); return; }
  if (command === 'discover') { await discover(readFlag(args, '--application'), hasFlag(args, '--dry-run')); return; }
  if (command === 'process') { await processOutreach(hasFlag(args, '--dry-run')); return; }
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
  throw new Error('Usage: node outreach.mjs prepare|discover|process|status|pause|enable-email|disable-email|ramp-complete|ramp-reset');
}

main().catch((error) => {
  if (error instanceof GmailClientError) console.error(`outreach: ${error.message}`);
  else console.error(`outreach: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
