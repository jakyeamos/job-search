#!/usr/bin/env node
// @ts-check

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { recordApplication, saveQueue } from './queue.mjs';
import { normalizeUrl, readQueueState, topUpSelection } from './queue-lib.mjs';
import { readBoard, setRowNotes, setRowStatus } from './tracker-board.mjs';
import {
  OUTREACH_STATE_PATH,
  loadOutreachState,
  isProviderGeneratedContactEmail,
  recordSubmissionSignal,
  summarizeOutbox,
} from './outreach-lib.mjs';
import {
  X_OUTREACH_OUTBOX_PATH,
  loadXOutreachOutbox,
  markXOutreachDraftSentAndArchived,
  validateXOutreachOutbox,
} from './x-outreach-outbox.mjs';
import { validateOutreachDraftReceipt } from './outreach-draft-quality.mjs';
import {
  loadLedger,
  answerQuestion,
  findQuestionMatch,
  findReusableAnswer,
  isCompanyMotivationQuestion,
  isSensitiveQuestion,
  questionId,
} from './apply/question-ledger.mjs';
import {
  classifyQuestionVisibility,
  hasVisibleQuestionReviews,
} from './apply/question-visibility.mjs';
import { loadClearState, DEFAULT_CLEAR_STATE_PATH } from './apply/application-run-state.mjs';
import { runClearQueue } from './application-queue.mjs';
import { loadHandoffSession, runHandoffBatch } from './application-handoff.mjs';
import { answerForControl, buildApplicationPacket } from './apply/application-packets.mjs';
import { artifactPathsForItem } from './apply/application-artifacts.mjs';
import { loadCivicDiscoveryReport } from './civic-discovery.mjs';
import {
  DEFAULT_CIVIC_STATE_PATH,
  applyCivicState,
  dismissCivicRecord,
  loadCivicState,
  restoreCivicRecord,
} from './civic-state.mjs';
import {
  choiceAllowsMultiple,
  inferChoiceFieldKind,
  normalizeChoiceFollowUpLabel,
  normalizeChoiceOptions,
  splitChoiceFollowUpLabel,
} from './apply/lib/choice-shape.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(ROOT, 'queue-ui');
const QUEUE_JSON = path.join(ROOT, 'data', 'job-queue.json');
const APPLICATION_PROFILE_PATH = path.join(ROOT, 'config', 'application-profile.json');
const PORT = 47831;
const HOST = '127.0.0.1';
const SERVER_STARTED_AT = new Date().toISOString();
const MAX_BODY_BYTES = 64 * 1024;
let clearPromise = null;
let handoffPromise = null;
let packetPromise = null;

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function queueUiHealthPayload(startedAt = SERVER_STARTED_AT) {
  return {
    ok: true,
    service: 'career-ops-queue-ui',
    startedAt,
  };
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} payload */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {string} message */
function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

/** Map a tracker-board error message onto an HTTP status. @param {string} message */
function boardErrorStatus(message) {
  if (/not found/i.test(message)) return 404;
  if (/is missing/i.test(message)) return 500;
  return 400;
}

/** @param {import('node:http').IncomingMessage} request */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

/** @returns {Record<string, unknown>} */
function loadState() {
  return readQueueState(QUEUE_JSON);
}

export function isCheckboxQuestion(kind, options = [], explicitMultiple = undefined) {
  return choiceAllowsMultiple(kind, options, explicitMultiple);
}

export function hasQuestionReviews(item) {
  return hasVisibleQuestionReviews(item);
}

let cachedApplicationProfile = null;

function loadApplicationProfileForQueue() {
  if (cachedApplicationProfile) return cachedApplicationProfile;
  try {
    const parsed = JSON.parse(readFileSync(APPLICATION_PROFILE_PATH, 'utf8'));
    cachedApplicationProfile = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cachedApplicationProfile = {};
  }
  return cachedApplicationProfile;
}

/** @param {string} question @param {Record<string, unknown>} item @param {Record<string, unknown>} review @param {{ entries: Array<Record<string, unknown>> }} ledger @param {Record<string, unknown>} profile */
function corpusAnswerForQuestion(question, item, review, ledger, profile) {
  const artifact = artifactPathsForItem(item);
  const answerItem = item.coverLetterText || !existsSync(artifact.coverLetterText)
    ? item
    : {
      ...item,
      coverLetterText: artifact.coverLetterText,
      applicationArtifactManifest: item.applicationArtifactManifest || artifact.manifest,
    };
  const resolved = answerForControl({
    label: question,
    kind: review.kind || review.fieldKind || review.type || 'text',
    type: review.type || review.kind || review.fieldKind || 'text',
    category: 'question',
    required: review.required === true,
    multiple: review.multiple === true,
    options: normalizeChoiceOptions(review.options),
  }, answerItem, profile, ledger);
  if (!resolved?.answer || String(resolved.answer).trim() === '') return null;
  if (resolved.sensitive === true || isSensitiveQuestion(question)) return null;
  return resolved;
}

export function questionPayload(items, ledger = loadLedger(), profile = loadApplicationProfileForQueue()) {
  const grouped = new Map();
  items
    .filter(hasQuestionReviews)
    .flatMap((item) => {
      const reviews = Array.isArray(item.applicationResult?.needsReview) ? item.applicationResult.needsReview : [];
      const suppressed = new Set();
      const followUps = new Map();
      for (let index = 0; index < reviews.length; index++) {
        const reviewLabel = String(reviews[index]?.label || '').trim();
        if (!classifyQuestionVisibility(reviewLabel).answerable) continue;
        const rawQuestion = reviewLabel.replace(/^EEO:\s*/i, '').trim();
        const split = splitChoiceFollowUpLabel(rawQuestion);
        if (!split) continue;
        const primaryIndex = reviews.findIndex((candidate, candidateIndex) => {
          if (candidateIndex === index) return false;
          const candidateQuestion = String(candidate?.label || '').replace(/^EEO:\s*/i, '').trim();
          return candidateQuestion.toLowerCase() === split.question.toLowerCase()
            && normalizeChoiceOptions(candidate?.options).length > 0
            && !choiceAllowsMultiple(candidate?.kind || candidate?.fieldKind, candidate?.options, candidate?.multiple);
        });
        if (primaryIndex < 0) continue;
        const primaryReview = reviews[primaryIndex];
        const primaryReusable = findReusableAnswer(split.question, ledger, {
          company: item.company,
          role: item.title,
          url: item.applyUrl || item.canonicalUrl,
          fieldKind: primaryReview.kind || primaryReview.fieldKind || '',
          options: normalizeChoiceOptions(primaryReview.options),
          sensitivity: isSensitiveQuestion(split.question) ? 'high' : 'normal',
        });
        const primaryCorpusAnswer = corpusAnswerForQuestion(split.question, item, primaryReview, ledger, profile);
        if (primaryReusable || primaryCorpusAnswer) {
          const primaryAnswer = primaryReusable?.answer || primaryCorpusAnswer?.answer;
          if (/^no\b/i.test(String(primaryAnswer || ''))) suppressed.add(index);
          continue;
        }
        suppressed.add(index);
        followUps.set(primaryIndex, {
          id: questionId(rawQuestion),
          question: split.followUp,
          trigger: split.trigger,
          required: reviews[index]?.required === true,
          queueId: item.id,
          queueIds: [item.id],
        });
      }
      return reviews.map((review, index) => {
        if (suppressed.has(index)) return null;
        const reviewLabel = String(review.label || '').trim();
        if (!classifyQuestionVisibility(reviewLabel).answerable) return null;
        const question = normalizeChoiceFollowUpLabel(
          reviewLabel.replace(/^EEO:\s*/i, ''),
        );
        if (!classifyQuestionVisibility(question).answerable) return null;
        const sensitivity = isSensitiveQuestion(question) ? 'high' : 'normal';
        const reviewOptions = normalizeChoiceOptions(review.options);
        const entry = ledger.entries.find((candidate) => candidate.id === questionId(question))
          || findQuestionMatch(question, ledger, {
            fieldKind: review.kind || review.fieldKind || '',
            options: reviewOptions,
            sensitivity,
          })?.entry;
        const reusable = findReusableAnswer(question, ledger, {
          company: item.company,
          role: item.title,
          url: item.applyUrl || item.canonicalUrl,
          fieldKind: review.kind || review.fieldKind || '',
          options: reviewOptions,
          sensitivity,
        });
        if (reusable) return null;
        if (corpusAnswerForQuestion(question, item, review, ledger, profile)) return null;
        const canonicalId = entry?.id || questionId(question);
        const options = reviewOptions.length ? reviewOptions : normalizeChoiceOptions(entry?.options);
        const kind = inferChoiceFieldKind(
          review.kind || review.fieldKind || entry?.fieldKind || '',
          question,
          options,
        );
        const multiple = isCheckboxQuestion(kind, options, review.multiple);
        const occurrence = { queueId: item.id, company: item.company, role: item.title, url: item.applyUrl || item.canonicalUrl };
        const existing = grouped.get(canonicalId);
        if (existing) {
          existing.queueIds = [...new Set([...existing.queueIds, item.id])];
          existing.occurrences.push(occurrence);
          existing.options = [...new Set([...existing.options, ...options])];
          if (!existing.kind && kind) existing.kind = kind;
          existing.multiple = existing.multiple || multiple;
          const currentFollowUp = followUps.get(index);
          if (currentFollowUp && existing.followUp?.id === currentFollowUp.id) {
            existing.followUp.queueIds = [...new Set([
              ...(existing.followUp.queueIds || []),
              ...(currentFollowUp.queueIds || []),
            ])];
          }
          return null;
        }
        const payload = {
          id: canonicalId,
          queueId: item.id,
          queueIds: [item.id],
          occurrences: [occurrence],
          occurrenceCount: 1,
          company: item.company,
          role: item.title,
          url: item.applyUrl || item.canonicalUrl,
          question: normalizeChoiceFollowUpLabel(entry?.question || question),
          reason: review.reason || entry?.blockerReason || 'required field needs an answer',
          options: [...new Set(options)],
          kind,
          multiple,
          sensitivity: entry?.sensitivity || 'normal',
          scope: isCompanyMotivationQuestion(question)
            ? 'posting'
            : ['question', 'company', 'role', 'posting'].includes(String(entry?.scope || '')) ? entry.scope : 'question',
          context: /^country(?:\/region)?\*?$/i.test(question)
            && /job-boards\.greenhouse\.io/i.test(String(item.applyUrl || item.canonicalUrl || ''))
            ? 'Phone-number country code — not nationality or country of origin.'
            : null,
          followUp: followUps.get(index) || null,
        };
        grouped.set(canonicalId, payload);
        return null;
      }).filter(Boolean);
    });
  return [...grouped.values()].map((question) => ({ ...question, occurrenceCount: question.occurrences.length }));
}

export function handoffSessionPayload(session = loadHandoffSession()) {
  return {
    schemaVersion: session.schemaVersion || 1,
    status: session.status || 'idle',
    error: session.error || null,
    startedAt: session.startedAt || null,
    completedAt: session.completedAt || null,
    updatedAt: session.updatedAt || null,
    preparation: (Array.isArray(session.preparation) ? session.preparation : []).map((entry) => ({
      id: entry.id,
      company: entry.company,
      title: entry.title,
      state: entry.state || null,
      ok: entry.ok === true,
      reason: entry.reason || null,
    })),
    pages: (Array.isArray(session.pages) ? session.pages : []).map((page) => ({
      id: page.id,
      company: page.company,
      title: page.title,
      url: page.url,
      status: page.status,
      finishedAt: page.finishedAt || null,
    })),
  };
}

function publicHandoffSession() {
  return handoffSessionPayload();
}

function publicApplicationRun() {
  const state = loadClearState(DEFAULT_CLEAR_STATE_PATH);
  const { path: _path, ...safeState } = state;
  return safeState;
}

/** @param {Array<Record<string, unknown>>} items */
function countUniqueLiveRoles(items) {
  const urls = new Set();
  let recordsWithoutUrl = 0;
  for (const item of items) {
    const url = normalizeUrl(String(item.applyUrl || item.canonicalUrl || ''));
    if (url) urls.add(url);
    else recordsWithoutUrl += 1;
  }
  return urls.size + recordsWithoutUrl;
}

/**
 * Return only the X outbox fields needed by the local review UI. Invalid or
 * missing outbox state degrades visibly instead of breaking the whole queue.
 * @param {string} [filePath]
 */
export function publicXOutreachOutbox(filePath = X_OUTREACH_OUTBOX_PATH) {
  try {
    const state = loadXOutreachOutbox(filePath);
    const validation = validateXOutreachOutbox(state);
    if (!validation.ok) {
      return {
        status: 'invalid',
        updatedAt: state.updatedAt || null,
        drafts: [],
        archivedCount: 0,
        warnings: validation.warnings,
        error: 'The local X outbox failed validation. Run the outbox verifier before using these messages.',
      };
    }
    const visibleDrafts = state.drafts.filter((draft) => draft.status !== 'archived');
    return {
      status: 'ready',
      updatedAt: state.updatedAt || null,
      warnings: validation.warnings,
      error: '',
      archivedCount: state.drafts.length - visibleDrafts.length,
      drafts: visibleDrafts.map((draft) => ({
        id: draft.id,
        company: draft.company,
        role: draft.role,
        contact: {
          name: draft.contact.name,
          handle: draft.contact.handle,
          profileUrl: draft.contact.profileUrl,
        },
        body: draft.body,
        qualityPassed: true,
        status: draft.status,
        deliveryStatus: draft.deliveryStatus,
        savedLocally: draft.savedLocally === true,
        nativeDraftStatus: draft.nativeDraftStatus,
        humanSendRequired: draft.humanSendRequired === true,
        pendingRevision: draft.pendingRevision && typeof draft.pendingRevision === 'object'
          ? {
            body: draft.pendingRevision.body,
            qualityPassed: true,
            generatedAt: draft.pendingRevision.generatedAt || null,
          }
          : null,
        updatedAt: draft.updatedAt || null,
      })),
    };
  } catch {
    return {
      status: 'unavailable',
      updatedAt: null,
      drafts: [],
      archivedCount: 0,
      warnings: [],
      error: 'The local X outbox is unavailable. Run the outbox verifier before using these messages.',
    };
  }
}

export function publicCivicDiscovery({ civicStatePath = DEFAULT_CIVIC_STATE_PATH } = {}) {
  try {
    const report = loadCivicDiscoveryReport();
    return {
      status: 'ready',
      ...applyCivicState(report, loadCivicState(civicStatePath)),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      schemaVersion: 1,
      generatedAt: null,
      rules: {
        applicationTracker: false,
        autoContact: false,
        autoSubmit: false,
        verifyBeforeAction: true,
      },
      counts: {
        currentRoles: 0,
        outreachTargets: 0,
        missionFirstTargets: 0,
        otherOutreachTargets: 0,
        staleLeads: 0,
        dismissed: 0,
        total: 0,
      },
      currentRoles: [],
      outreachTargets: [],
      missionFirstTargets: [],
      otherOutreachTargets: [],
      staleLeads: [],
      dismissed: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @param {Record<string, unknown>} state */
export function queuePayload(
  state,
  outreachState = loadOutreachState(path.join(ROOT, OUTREACH_STATE_PATH)),
  civic = publicCivicDiscovery(),
) {
  const { archivedIndex: rawArchivedIndex, ...rest } = state;
  const archivedIndex = Array.isArray(rawArchivedIndex) ? rawArchivedIndex : [];
  const items = Array.isArray(rest.items) ? rest.items : [];
  const questions = questionPayload(items);
  const liveItems = items.filter((item) => ['ready', 'in_review', 'snoozed'].includes(String(item.status || ''))
    && !['stale', 'archivable'].includes(String(item.freshness || '')));
  const selected = items
    .filter((item) => item.selectedForToday)
    .sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999));
  const outboxById = new Map((outreachState.outbox || []).map((entry) => [entry.id, entry]));
  const visibleOutreachRecords = (Array.isArray(outreachState.records) ? outreachState.records : [])
    .filter((record) => record?.submission?.confirmed === true);
  return {
    ...rest,
    selected,
    questions,
    handoffs: publicHandoffSession(),
    applicationRun: publicApplicationRun(),
    outreach: visibleOutreachRecords.map((record) => ({
      key: record.key,
      company: record.company,
      title: record.title,
      status: record.status,
      submissionConfirmed: record.submission?.confirmed === true,
      submissionConfirmedAt: record.submission?.confirmedAt || null,
      submissionConfirmedSource: record.submission?.confirmedSource || null,
      lastError: record.lastError || null,
      discovery: record.discovery ? {
        status: record.discovery.status || 'unknown',
        reason: record.discovery.reason || '',
        attemptedAt: record.discovery.attemptedAt || null,
        nextAttemptAt: record.discovery.nextAttemptAt || record.discovery.cacheExpiresAt || null,
      } : null,
      searchQuery: record.searchQuery || '',
      contacts: (record.contacts || []).map((contact) => {
        const socialEligible = record.submission?.confirmed === true
          && !['paused', 'suppressed'].includes(String(record.status || ''));
        const providerEmail = isProviderGeneratedContactEmail(contact.email);
        const email = providerEmail ? null : contact.email || null;
        const initial = contact.initial || {};
        const initialOutbox = outboxById.get(initial.outboxId);
        const initialQuality = validateOutreachDraftReceipt({
          channel: 'email',
          subject: String(initial.subject || ''),
          body: String(initial.body || ''),
          receipt: initial.draftQuality,
        });
        const linkedinQuality = validateOutreachDraftReceipt({
          channel: 'linkedin',
          body: String(contact.linkedinDraft || ''),
          receipt: contact.linkedinDraftQuality,
        });
        const xQuality = validateOutreachDraftReceipt({
          channel: 'x',
          body: String(contact.xDraft || ''),
          receipt: contact.xDraftQuality,
        });
        return {
          name: contact.name,
          title: contact.title,
          type: contact.type,
          email,
          emailEligible: !providerEmail && contact.emailEligible === true,
          emailVerified: !providerEmail && contact.emailVerified === true,
          primaryOutreachChannel: contact.primaryOutreachChannel
            || (contact.emailVerified === true ? 'email' : contact.xProfileUrl ? 'x' : contact.emailEligible === true ? 'email' : contact.profileUrl ? 'linkedin' : null),
          channelPriority: Number(contact.channelPriority)
            || (contact.emailVerified === true ? 4 : contact.xProfileUrl ? 3 : contact.emailEligible === true ? 2 : contact.profileUrl ? 1 : 0),
          emailVerificationType: providerEmail ? null : contact.emailVerificationType || null,
          emailVerificationState: providerEmail ? 'blocked-provider-address' : contact.emailVerificationState || null,
          guessed: contact.guessed === true,
          initialStatus: initial.status || 'none',
          initialDeliveryStatus: initial.deliveryStatus || null,
          initialOutboxStatus: initialOutbox?.status || null,
          initialOutboxId: initial.outboxId || null,
          initialEmailNotification: email && initial.subject && initialQuality.ok && !String(initial.status || '').startsWith('blocked_')
            ? {
              status: initial.deliveryStatus === 'gmail_draft_created' || initial.status === 'draft_created'
                ? 'gmail_draft_created'
                : 'gmail_draft_pending',
              recipient: email,
              subject: initial.subject,
              gmailDraftId: initial.gmailDraftId || initialOutbox?.gmailDraftId || null,
            }
            : null,
          initialLastError: initial.validationError || initialOutbox?.lastError
            || (initial.subject && !initialQuality.ok ? `Draft hidden until Humanizer/quality passes: ${initialQuality.reasons.join('; ')}` : null),
          followUpStatus: contact.followUp?.status || 'none',
          followUpDeliveryStatus: contact.followUp?.deliveryStatus || null,
          followUpOutboxStatus: outboxById.get(contact.followUp?.outboxId)?.status || null,
          followUpLastError: outboxById.get(contact.followUp?.outboxId)?.lastError || null,
          followUpDueAt: contact.followUp?.dueAt || null,
          linkedinDraft: socialEligible && linkedinQuality.ok ? contact.linkedinDraft : '',
          linkedinDraftQualityPassed: socialEligible && linkedinQuality.ok,
          linkedinDraftError: contact.linkedinDraftError
            || (contact.linkedinDraft && !linkedinQuality.ok ? linkedinQuality.reasons.join('; ') : null),
          xProfileUrl: contact.xProfileUrl || '',
          xHandle: contact.xHandle || '',
          xDraft: socialEligible && xQuality.ok ? contact.xDraft : '',
          xDraftQualityPassed: socialEligible && xQuality.ok,
          xDraftError: contact.xDraftError
            || (contact.xDraft && !xQuality.ok ? xQuality.reasons.join('; ') : null),
        };
      }),
    })),
    outreachRun: outreachState.lastProcess || null,
    outreachSettings: {
      emailEnabled: outreachState.settings?.emailEnabled === true,
      rampComplete: outreachState.settings?.rampComplete === true,
      account: outreachState.settings?.account || null,
      enabledAt: outreachState.settings?.enabledAt || null,
    },
    outreachOutbox: summarizeOutbox(outreachState),
    xOutreachOutbox: publicXOutreachOutbox(),
    civic,
    totals: {
      retained: items.length + archivedIndex.length,
      liveUnique: countUniqueLiveRoles(liveItems),
      excluded: archivedIndex.filter((stub) => stub.status === 'excluded').length,
      stale: items.filter((item) => item.status === 'stale').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      archived: archivedIndex.filter((stub) => stub.status === 'archived').length,
      filtered: archivedIndex.length
        + items.filter((item) => ['stale', 'skipped'].includes(String(item.status || ''))).length,
      selected: selected.length,
      ready: items.filter((item) => item.status === 'ready').length,
      inReview: items.filter((item) => item.status === 'in_review').length,
      applied: items.filter((item) => item.status === 'applied').length,
      questions: new Set(questions.flatMap((question) => question.queueIds || [])).size,
      handoffs: items.filter((item) => ['blocked_by_question', 'submission_unknown', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_human'].includes(String(item.applicationState || ''))).length,
    },
  };
}

/** @param {Record<string, unknown>} payload */
function stringValue(payload, key) {
  return typeof payload[key] === 'string' ? payload[key].trim() : '';
}

/** @param {Record<string, unknown>} payload */
function applyQueueAction(payload) {
  const id = stringValue(payload, 'id');
  const action = stringValue(payload, 'action');
  const state = loadState();
  const items = Array.isArray(state.items) ? state.items : [];
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error('queue item not found; refresh the page and try again');

  if (action === 'applied' || action === 'confirmed-submitted') {
    const appliedAt = new Date().toISOString();
    const recorded = recordApplication(ROOT, item);
    if (!recorded.recorded && !recorded.reason.includes('already exists')) {
      throw new Error(recorded.reason);
    }
    item.status = 'applied';
    item.appliedAt = appliedAt;
    item.selectedForToday = false;
    item.queueRank = null;
    item.actionNote = recorded.reason;
    recordSubmissionSignal(path.join(ROOT, OUTREACH_STATE_PATH), item, {
      source: action === 'confirmed-submitted' ? 'user_confirmed_submission' : 'queue_applied',
      at: appliedAt,
      confirmed: action === 'confirmed-submitted',
      submissionId: stringValue(payload, 'submissionId') || undefined,
      evidence: action === 'confirmed-submitted' ? { source: 'queue-ui', itemId: item.id } : undefined,
    });
  } else if (action === 'skipped') {
    item.status = 'skipped';
    item.selectedForToday = false;
    item.queueRank = null;
    item.skipReason = stringValue(payload, 'reason');
  } else if (action === 'snoozed') {
    const date = stringValue(payload, 'snoozeUntil');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('snooze date must use YYYY-MM-DD');
    item.status = 'snoozed';
    item.snoozeUntil = `${date}T00:00:00.000Z`;
    item.selectedForToday = false;
    item.queueRank = null;
  } else {
    throw new Error(`unsupported queue action: ${action || '(empty)'}`);
  }

  state.generatedAt = new Date().toISOString();
  const refilled = topUpSelection(state).state;
  saveQueue(ROOT, refilled);
  return { state: queuePayload(refilled), item, action };
}

/** @param {Record<string, unknown>} payload @param {{ civicStatePath?: string }} options */
export function applyCivicAction(payload, { civicStatePath = DEFAULT_CIVIC_STATE_PATH } = {}) {
  const action = stringValue(payload, 'action');
  const key = stringValue(payload, 'key');
  if (!['dismiss', 'restore'].includes(action)) throw new Error(`unsupported civic action: ${action || '(empty)'}`);
  if (!key) throw new Error('civic record key is required');
  const report = loadCivicDiscoveryReport();
  const result = action === 'dismiss'
    ? dismissCivicRecord(report, civicStatePath, key, stringValue(payload, 'reason'))
    : restoreCivicRecord(report, civicStatePath, key);
  const civic = publicCivicDiscovery({ civicStatePath });
  return {
    ok: true,
    action,
    key,
    changed: result.changed,
    civic,
  };
}

async function refreshQueue() {
  const result = await execFileAsync(process.execPath, [
    path.join(ROOT, 'queue.mjs'),
    'refresh',
    '--limit',
    '10',
  ], {
    cwd: ROOT,
    timeout: 1_800_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    state: queuePayload(loadState()),
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function startClearQueue(dryRun = false, humanTimeoutSeconds = 600) {
  if (clearPromise) return publicApplicationRun();
  clearPromise = runClearQueue({ limit: 6, dryRun, humanTimeoutSeconds })
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { clearPromise = null; });
  return publicApplicationRun();
}

async function runPacketQueue(limit = 6) {
  const state = loadState();
  const selected = (state.items || [])
    .filter((item) => item.selectedForToday && ['ready', 'in_review'].includes(String(item.status || '')))
    .sort((left, right) => Number(left.queueRank || 999) - Number(right.queueRank || 999))
    .slice(0, Math.max(1, Math.min(Number(limit || 6), 6)));
  const report = [];
  updateClearState(DEFAULT_CLEAR_STATE_PATH, {
    status: 'running',
    phase: 'preparing-packets',
    limit,
    report: [],
    questions: [],
    handoffs: [],
    error: null,
    startedAt: new Date().toISOString(),
  });
  for (const item of selected) {
    updateClearState(DEFAULT_CLEAR_STATE_PATH, {
      phase: 'preparing-packets',
      current: { id: item.id, company: item.company, title: item.title, status: 'started' },
    });
    try {
      const packet = await buildApplicationPacket(item);
      const answerPrep = packet.answerPrep || {};
      item.applicationPacket = packet.ok
        ? {
          status: packet.status,
          generatedAt: packet.generatedAt,
          markdownPath: packet.paths.markdown,
          jsonPath: packet.paths.json,
          prepQuestionCount: Number(answerPrep.questionCount ?? packet.questions.length),
          unresolvedCount: Number(answerPrep.unresolvedCount ?? packet.unresolved.length),
          simpleUnresolvedCount: Number(answerPrep.simpleUnresolvedCount || 0),
          requiredUnresolvedCount: Number(answerPrep.requiredUnresolvedCount || 0),
        }
        : { status: 'blocked', reason: packet.reason };
      const requiredUnresolved = Number(answerPrep.requiredUnresolvedCount || 0);
      const prepQuestionCount = Number(answerPrep.questionCount ?? packet.questions.length);
      const reason = requiredUnresolved
        ? `${requiredUnresolved} required field(s) need input; ${prepQuestionCount} nontrivial answer(s) prepared`
        : `${prepQuestionCount} nontrivial answer(s) prepared`;
      report.push({ id: item.id, company: item.company, title: item.title, action: packet.ok ? 'packet-ready' : 'blocked', status: packet.ok ? packet.status : null, reason: packet.ok ? reason : packet.reason });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      item.applicationPacket = { status: 'blocked', reason };
      report.push({ id: item.id, company: item.company, title: item.title, action: 'blocked', reason });
    }
    state.generatedAt = new Date().toISOString();
    saveQueue(ROOT, state);
    updateClearState(DEFAULT_CLEAR_STATE_PATH, { report: [...report] });
  }
  const result = { ok: report.every((entry) => entry.action === 'packet-ready'), limit, report, humanSubmissionRequired: true };
  updateClearState(DEFAULT_CLEAR_STATE_PATH, {
    status: result.ok ? 'completed' : 'failed',
    phase: 'complete',
    report,
    result,
    error: result.ok ? null : 'one or more packets could not be prepared',
  });
  return result;
}

function startPacketQueue(limit = 6) {
  if (packetPromise) return publicApplicationRun();
  packetPromise = runPacketQueue(limit)
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { packetPromise = null; });
  return publicApplicationRun();
}

function startHandoffs() {
  if (handoffPromise) return publicHandoffSession();
  const state = loadState();
  const ids = (state.items || [])
    .filter((item) => item.selectedForToday === true
      || ['prepared_for_review', 'blocked_by_question', 'submission_unknown', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_human'].includes(String(item.applicationState || '')))
    .map((item) => item.id);
  if (!ids.length) return publicHandoffSession();
  handoffPromise = runHandoffBatch(ids, { timeoutSeconds: 600, includeSelected: true })
    .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { handoffPromise = null; });
  return publicHandoffSession();
}

async function buildQueuePacket(payload) {
  const queueId = stringValue(payload, 'queueId');
  if (!queueId) throw new Error('queue id is required');
  const state = loadState();
  const item = (state.items || []).find((candidate) => candidate.id === queueId);
  if (!item) throw new Error('queue item not found; refresh the page and try again');
  const packet = await buildApplicationPacket(item);
  if (!packet.ok) throw new Error(packet.reason);
  const answerPrep = packet.answerPrep || {};
  item.applicationPacket = {
    status: packet.status,
    generatedAt: packet.generatedAt,
    markdownPath: packet.paths.markdown,
    jsonPath: packet.paths.json,
    prepQuestionCount: Number(answerPrep.questionCount ?? packet.questions.length),
    unresolvedCount: Number(answerPrep.unresolvedCount ?? packet.unresolved.length),
    simpleUnresolvedCount: Number(answerPrep.simpleUnresolvedCount || 0),
    requiredUnresolvedCount: Number(answerPrep.requiredUnresolvedCount || 0),
  };
  state.generatedAt = new Date().toISOString();
  saveQueue(ROOT, state);
  return { packet, state: queuePayload(state) };
}

async function saveQueueQuestionAnswer(payload) {
  const id = stringValue(payload, 'id');
  const answer = stringValue(payload, 'answer');
  const scope = stringValue(payload, 'scope') || 'question';
  const queueIds = Array.isArray(payload.queueIds)
    ? payload.queueIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [stringValue(payload, 'queueId')].filter(Boolean);
  if (!id || !answer || !queueIds.length) throw new Error('question id, queue id, and answer are required');
  const state = loadState();
  const ledgerPath = path.join(ROOT, 'data', 'application-question-ledger.json');
  const ledger = loadLedger(ledgerPath);
  const items = queueIds.map((queueId) => (state.items || []).find((candidate) => candidate.id === queueId));
  if (items.some((item) => !item)) throw new Error('queue item not found; refresh the page and try again');
  for (const item of items) {
    const reviews = Array.isArray(item.applicationResult?.needsReview) ? item.applicationResult.needsReview : [];
    let humanOnlyMatch = false;
    const belongsToItem = reviews.some((review) => {
      const reviewLabel = String(review.label || '').trim();
      const question = normalizeChoiceFollowUpLabel(
        reviewLabel.replace(/^EEO:\s*/i, ''),
      );
      if (!classifyQuestionVisibility(reviewLabel).answerable) {
        if (questionId(question) === id) humanOnlyMatch = true;
        return false;
      }
      return questionId(question) === id || findQuestionMatch(question, ledger, {
        fieldKind: review.kind || review.fieldKind || '',
        options: review.options || [],
        sensitivity: isSensitiveQuestion(question) ? 'high' : 'normal',
      })?.entry.id === id;
    });
    if (humanOnlyMatch) throw new Error('this question must be completed in the browser handoff');
    if (!belongsToItem) throw new Error('question is not recorded as a blocker for every application in this group');
  }
  const item = items[0];
  const entry = answerQuestion(path.join(ROOT, 'data', 'application-question-ledger.json'), id, answer, {
    scope: ['question', 'company', 'role', 'posting'].includes(scope) ? scope : 'question',
    company: item.company,
    role: item.title,
    url: item.applyUrl || item.canonicalUrl,
    queueId: item.id,
  });
  return {
    ok: true,
    entry,
    queueIds,
    state: queuePayload(state),
    humanSubmissionRequired: true,
  };
}

async function processOutreach() {
  let execution = { ok: true, stdout: '', stderr: '', error: '' };
  try {
    const result = await execFileAsync(process.execPath, [path.join(ROOT, 'outreach.mjs'), 'process'], {
      cwd: ROOT,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    execution = { ok: true, stdout: result.stdout || '', stderr: result.stderr || '', error: '' };
  } catch (error) {
    const typed = /** @type {Error & {stdout?: string, stderr?: string}} */ (error);
    execution = {
      ok: false,
      stdout: typed.stdout || '',
      stderr: typed.stderr || '',
      error: typed.message || String(error),
    };
  }
  const state = loadOutreachState(path.join(ROOT, OUTREACH_STATE_PATH));
  return {
    ok: execution.ok && state.lastProcess?.ok !== false,
    state: queuePayload(readQueueState(QUEUE_JSON)),
    outreach: state.records,
    summary: state.lastProcess || null,
    settings: {
      emailEnabled: state.settings?.emailEnabled === true,
      rampComplete: state.settings?.rampComplete === true,
      account: state.settings?.account || null,
    },
    output: `${execution.stdout || ''}${execution.stderr || ''}`.trim(),
    error: execution.ok ? '' : execution.error,
  };
}

/** @param {Record<string, unknown>} payload */
function markXOutreachDraftSent(payload) {
  const id = stringValue(payload, 'id');
  if (!id) throw new Error('id is required');
  const result = markXOutreachDraftSentAndArchived(id);
  return {
    ok: true,
    changed: result.changed,
    draft: {
      id: result.draft.id,
      status: result.draft.status,
      deliveryStatus: result.draft.deliveryStatus,
      humanConfirmedSentAt: result.draft.humanConfirmedSentAt,
      archivedAt: result.draft.archivedAt,
    },
    state: queuePayload(loadState()),
  };
}

/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, queueUiHealthPayload());
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/queue') {
    const refill = topUpSelection(loadState());
    if (refill.added > 0) saveQueue(ROOT, refill.state);
    sendJson(response, 200, queuePayload(refill.state));
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/board') {
    try {
      sendJson(response, 200, readBoard(ROOT));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, boardErrorStatus(message), message);
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/board/status') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, setRowStatus(ROOT, Number(payload.num), stringValue(payload, 'status')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, boardErrorStatus(message), message);
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/board/notes') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, setRowNotes(ROOT, Number(payload.num), stringValue(payload, 'notes')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, boardErrorStatus(message), message);
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/action') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, applyQueueAction(payload));
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/civic/action') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, applyCivicAction(payload));
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/refresh') {
    try {
      sendJson(response, 200, await refreshQueue());
    } catch (error) {
      sendError(response, 502, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/applications/clear') {
    try {
      const payload = await readJsonBody(request);
      const requestedTimeout = Number(payload.humanTimeoutSeconds || 600);
      const humanTimeoutSeconds = Math.max(30, Math.min(12 * 60 * 60, Number.isFinite(requestedTimeout) ? requestedTimeout : 600));
      sendJson(response, 202, { ok: true, run: startClearQueue(payload.dryRun === true, humanTimeoutSeconds) });
    } catch (error) {
      sendError(response, 409, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/applications/packets') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 202, { ok: true, run: startPacketQueue(Number(payload.limit || 6)) });
    } catch (error) {
      sendError(response, 409, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/applications/packet') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await buildQueuePacket(payload));
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/applications/status') {
    sendJson(response, 200, publicApplicationRun());
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/questions/answer') {
    try {
      const payload = await readJsonBody(request);
      const result = await saveQueueQuestionAnswer(payload);
      sendJson(response, 200, {
        ok: result.ok,
        entry: result.entry,
        queueIds: result.queueIds,
        state: result.state,
        humanSubmissionRequired: result.humanSubmissionRequired,
      });
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/handoffs') {
    sendJson(response, 200, publicHandoffSession());
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/handoffs/open') {
    try {
      sendJson(response, 202, { ok: true, handoffs: startHandoffs() });
    } catch (error) {
      sendError(response, 409, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/outreach/process') {
    try {
      sendJson(response, 200, await processOutreach());
    } catch (error) {
      sendError(response, 502, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/x-outreach/mark-sent') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, markXOutreachDraftSent(payload));
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (request.method !== 'GET') {
    sendError(response, 405, 'method not allowed');
    return;
  }

  const relative = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1);
  const filePath = path.resolve(UI_ROOT, relative);
  if (!filePath.startsWith(`${UI_ROOT}${path.sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendError(response, 404, 'not found');
    return;
  }
  const contentType = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

function startServer() {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) sendError(response, 500, 'internal queue UI error');
      console.error(`queue-ui: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  server.on('error', (error) => {
    console.error(`queue-ui: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`career-ops queue UI listening at http://${HOST}:${PORT}/`);
  });
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule && (process.argv.includes('--serve') || process.argv.length === 2)) startServer();
