// @ts-check

/**
 * Reconcile application identity and submission provenance for outreach.
 *
 * The queue, tracker, Gmail ingest, Jack & Jill, and connector-maintained
 * source snapshots are projections of the same real-world event. A status
 * label alone is not proof that an application was submitted, so this module
 * keeps identity, lifecycle status, and confirmation signals separate.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { applicationKey } from './queue-lib.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';

const TRACKER_FILE = 'data/applications.md';
const REVIEW_FILE = 'data/application-import-review.json';
const EXTERNAL_EVIDENCE_FILE = 'data/application-source-evidence.json';
const OUTREACH_STATE_FILE = 'data/outreach-state.json';
const ACTIVE_TRACKER_STATUSES = new Set(['Applied', 'Responded', 'Interview', 'Offer']);
// Rejected and Discarded are lifecycle outcomes. SKIP is a pre-application
// decision and must yield when a stronger source later proves submission.
const TERMINAL_TRACKER_STATUSES = new Set(['Rejected', 'Discarded']);
const INVALID_COMPANY_RE = /\band\s+\d+\s+more\b|\bjobs?\s+for\s+you\b/i;

/** @param {unknown} value */
function text(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }

/** @param {unknown} value */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {string} value */
function companyIdentity(value) { return text(value).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** @param {string} value */
function roleBase(value) {
  return text(value).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @param {string} file */
function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** @param {unknown} value */
function score(value) {
  const match = text(value).match(/(?:^|\s)(\d(?:\.\d+)?)\s*\/\s*5(?:\s|$)/);
  return match ? Number(match[1]) : null;
}

/** @param {string} reportCell @param {string} root */
function reportUrl(reportCell, root) {
  const href = text(reportCell).match(/\]\(([^)]+\.md)\)/i)?.[1];
  if (!href) return '';
  const reportPath = path.resolve(root, 'data', href);
  if (!existsSync(reportPath)) return '';
  const content = readFileSync(reportPath, 'utf8');
  const line = content.match(/^\*\*URL:\*\*\s*(.+)$/mi)?.[1] || '';
  const raw = line.match(/https?:\/\/[^\s)]+/i)?.[0]
    || line.match(/\blocal:[^\s)]+/i)?.[0]
    || '';
  return raw.replace(/[.,;:]+$/, '');
}

/** @param {string} notes */
export function trackerSubmissionSignals(notes) {
  const value = text(notes);
  const signals = [];
  const gmailIds = [...value.matchAll(/mail\.google\.com\/mail\/#all\/([a-z0-9]+)/gi)].map((match) => match[1]);
  const hasGmail = /(?:confirmed gmail acknowledgement|gmail application confirmation)/i.test(value);
  if (hasGmail) {
    signals.push({
      source: 'gmail_application_confirmation',
      confirmed: true,
      at: value.match(/(?:acknowledgement|confirmation)\s+(20\d{2}-\d{2}-\d{2})/i)?.[1] || '',
      messageId: gmailIds[0] || '',
      evidence: { provenance: 'employer-or-ats', trackerNote: value },
    });
  }
  const jackDate = value.match(/Jack\s*&\s*Jill board:\s*Applied\s*\((20\d{2}-\d{2}-\d{2})\)/i)?.[1] || '';
  if (/Jack\s*&\s*Jill board:\s*Applied/i.test(value)) {
    signals.push({
      source: 'jackandjill_applied',
      confirmed: true,
      at: jackDate,
      evidence: { provenance: 'authenticated-board', trackerNote: value },
    });
  }
  if (/(?:already applied via linkedin|queue applied:\s*gmail:linkedin)/i.test(value)) {
    signals.push({
      source: 'linkedin_provider_submission',
      confirmed: true,
      at: '',
      evidence: { provenance: 'provider-submission', trackerNote: value },
    });
  }
  const manualDate = value.match(/(?:^|[.;]\s*)Applied\s+(20\d{2}-\d{2}-\d{2})(?:[.;]|$)/i)?.[1] || '';
  if (manualDate) {
    signals.push({
      source: 'tracker_manual_confirmation',
      confirmed: true,
      at: manualDate,
      evidence: { provenance: 'manual-tracker-note', trackerNote: value },
    });
  }
  return signals;
}

/** @param {string} root */
function trackerItems(root) {
  const file = path.join(root, TRACKER_FILE);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean).map((row) => {
    const tracker = /** @type {Record<string, unknown>} */ (row);
    const status = text(tracker.status);
    return {
      id: `tracker-${tracker.num}`,
      trackerNum: Number(tracker.num),
      company: text(tracker.company),
      title: text(tracker.role),
      fitScore: score(tracker.score),
      status: ACTIVE_TRACKER_STATUSES.has(status)
        ? 'applied'
        : status === 'Rejected' ? 'rejected'
          : status === 'Discarded' || status === 'SKIP' ? 'skipped'
            : 'evaluated',
      trackerStatus: status,
      appliedAt: text(tracker.date),
      applyUrl: reportUrl(text(tracker.report), root),
      submissionSignals: trackerSubmissionSignals(text(tracker.notes)),
      evidenceSources: ['tracker'],
    };
  }).filter((item) => item.company && item.title);
}

/** @param {Record<string, unknown>} source @param {Record<string, unknown>} fallback */
function reviewSignal(source, fallback) {
  const record = object(source);
  const evidenceType = text(record.evidenceType || fallback.evidenceType);
  const from = text(record.from || fallback.from);
  const provider = evidenceType === 'provider-submission' || /@linkedin\.com\b/i.test(from);
  return {
    source: provider ? 'linkedin_provider_submission' : 'gmail_application_confirmation',
    confirmed: true,
    at: text(record.date || fallback.date || fallback.observedAt),
    messageId: text(record.messageId || fallback.messageId),
    subject: text(record.subject || fallback.subject),
    evidence: {
      provenance: provider ? 'provider-submission' : 'employer-or-ats',
      reviewReason: text(fallback.reason),
    },
  };
}

/** @param {Record<string, unknown>} value */
function providerIdentityMatchesSubject(value) {
  const subject = text(value.subject);
  const company = companyIdentity(text(value.company));
  const sentTo = subject.match(/application was sent to\s+(.+)$/i)?.[1] || '';
  if (sentTo) return company === companyIdentity(sentTo);
  const applicationTo = subject.match(/application to\s+(.+?)\s+at\s+(.+)$/i);
  if (applicationTo) {
    return company === companyIdentity(applicationTo[2])
      && roleBase(text(value.role)) === roleBase(applicationTo[1]);
  }
  return true;
}

/** @param {string} root @param {Array<Record<string, unknown>>} items */
function attachReviewEvidence(root, items) {
  const parsed = object(readJson(path.join(root, REVIEW_FILE)));
  const reviews = Array.isArray(parsed.items) ? parsed.items.map(object) : [];
  for (const review of reviews) {
    if (text(review.status) !== 'Applied') continue;
    const sources = Array.isArray(review.sources) ? review.sources.map(object) : [review];
    const exact = sources.find((source) => text(source.status || review.status) === 'Applied'
      && text(source.company || review.company)
      && text(source.role || review.role)
      && providerIdentityMatchesSubject({ ...review, ...source }));
    if (!exact) continue;
    const trackerNum = Number(review.trackerNum || 0);
    const company = text(exact.company || review.company);
    const title = text(exact.role || review.role);
    let item = trackerNum ? items.find((candidate) => Number(candidate.trackerNum) === trackerNum) : null;
    if (!item) item = items.find((candidate) => applicationKey(candidate) === applicationKey({ company, title }));
    if (!item) {
      const sameCompany = items.filter((candidate) => companyIdentity(text(candidate.company)) === companyIdentity(company));
      const baseMatches = sameCompany.filter((candidate) => roleBase(text(candidate.title)) === roleBase(title));
      if (baseMatches.length === 1) item = baseMatches[0];
    }
    if (!item) {
      item = {
        id: `review-${text(exact.messageId || review.messageId) || applicationKey({ company, title })}`,
        company,
        title,
        fitScore: null,
        status: 'applied',
        trackerStatus: '',
        appliedAt: text(exact.date || review.date),
        applyUrl: text(exact.url || review.url),
        submissionSignals: [],
        evidenceSources: ['application-import-review'],
      };
      items.push(item);
    }
    item.submissionSignals = [...(Array.isArray(item.submissionSignals) ? item.submissionSignals : []), reviewSignal(exact, review)];
    item.evidenceSources = [...new Set([...(Array.isArray(item.evidenceSources) ? item.evidenceSources : []), 'application-import-review'])];
    if (!item.applyUrl) item.applyUrl = text(exact.url || review.url);
    if (!['rejected', 'skipped', 'closed', 'withdrawn', 'not_selected'].includes(text(item.status))) item.status = 'applied';
  }
}

/** @param {string} root @param {Array<Record<string, unknown>>} items */
function attachReviewTerminalEvidence(root, items) {
  const parsed = object(readJson(path.join(root, REVIEW_FILE)));
  const reviews = Array.isArray(parsed.items) ? parsed.items.map(object) : [];
  for (const review of reviews) {
    if (text(review.status) !== 'Rejected') continue;
    const sources = Array.isArray(review.sources) ? review.sources.map(object) : [review];
    const exact = sources.find((source) => text(source.status || review.status) === 'Rejected'
      && text(source.company || review.company)
      && text(source.role || review.role)
      && providerIdentityMatchesSubject({ ...review, ...source }));
    if (!exact) continue;
    const trackerNum = Number(review.trackerNum || 0);
    const company = text(exact.company || review.company);
    const title = text(exact.role || review.role);
    let item = trackerNum ? items.find((candidate) => Number(candidate.trackerNum) === trackerNum) : null;
    if (!item) item = items.find((candidate) => applicationKey(candidate) === applicationKey({ company, title }));
    if (!item) {
      const sameCompany = items.filter((candidate) => companyIdentity(text(candidate.company)) === companyIdentity(company));
      const baseMatches = sameCompany.filter((candidate) => roleBase(text(candidate.title)) === roleBase(title));
      if (baseMatches.length === 1) item = baseMatches[0];
    }
    if (!item) continue;
    item.status = 'rejected';
    item.trackerStatus = 'Rejected';
    item.evidenceSources = [...new Set([...(Array.isArray(item.evidenceSources) ? item.evidenceSources : []), 'application-import-review'])];
  }
}

/** @param {string} root @param {Array<Record<string, unknown>>} items */
function attachExternalEvidence(root, items) {
  const parsed = object(readJson(path.join(root, EXTERNAL_EVIDENCE_FILE)));
  const records = Array.isArray(parsed.records) ? parsed.records.map(object) : [];
  for (const record of records) {
    const company = text(record.company);
    const title = text(record.title || record.role);
    const stage = text(record.stage || record.status);
    if (!company || !title || !ACTIVE_TRACKER_STATUSES.has(stage)) continue;
    let item = items.find((candidate) => applicationKey(candidate) === applicationKey({ company, title }));
    if (!item) {
      item = {
        id: `external-${applicationKey({ company, title })}`,
        company,
        title,
        fitScore: score(record.fitScore),
        status: 'applied',
        trackerStatus: stage,
        appliedAt: text(record.dateApplied || record.observedAt),
        applyUrl: text(record.applyUrl || record.jobUrl),
        submissionSignals: [],
        evidenceSources: [],
      };
      items.push(item);
    }
    item.submissionSignals = [...(Array.isArray(item.submissionSignals) ? item.submissionSignals : []), {
      source: text(record.source) || 'external_application_source',
      confirmed: true,
      at: text(record.dateApplied || record.observedAt),
      submissionId: text(record.submissionId),
      evidence: { provenance: text(record.provenance) || 'explicit-stage', stage },
    }];
    item.evidenceSources = [...new Set([...(Array.isArray(item.evidenceSources) ? item.evidenceSources : []), text(record.source) || 'external'])];
    if (!item.applyUrl) item.applyUrl = text(record.applyUrl || record.jobUrl);
  }
}

/** @param {string} root @param {Array<Record<string, unknown>>} items */
function attachOutreachEvidence(root, items) {
  const parsed = object(readJson(path.join(root, OUTREACH_STATE_FILE)));
  const records = Array.isArray(parsed.records) ? parsed.records.map(object) : [];
  for (const record of records) {
    const submission = object(record.submission);
    const signals = Array.isArray(submission.signals)
      ? submission.signals.map(object).filter((signal) => signal.confirmed === true)
      : [];
    if (!signals.length) continue;
    const company = text(record.company);
    const title = text(record.title);
    if (!company || !title) continue;
    const key = text(record.key) || applicationKey({ company, title });
    let item = items.find((candidate) => applicationKey(candidate) === key);
    if (!item) {
      item = {
        id: `outreach-${key}`,
        company,
        title,
        fitScore: null,
        status: 'applied',
        trackerStatus: '',
        appliedAt: text(submission.confirmedAt),
        applyUrl: '',
        submissionSignals: [],
        evidenceSources: [],
      };
      items.push(item);
    }
    item.submissionSignals = [...(Array.isArray(item.submissionSignals) ? item.submissionSignals : []), ...signals];
    item.evidenceSources = [...new Set([...(Array.isArray(item.evidenceSources) ? item.evidenceSources : []), 'outreach-state'])];
  }
}

/** @param {Array<Record<string, unknown>>} queueItems @param {Array<Record<string, unknown>>} sourceItems */
function mergeItems(queueItems, sourceItems) {
  const merged = new Map();
  for (const item of [...queueItems, ...sourceItems]) {
    const key = applicationKey(item);
    if (!key) continue;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        ...item,
        submissionSignals: Array.isArray(item.submissionSignals) ? item.submissionSignals : [],
        evidenceSources: Array.isArray(item.evidenceSources) ? item.evidenceSources : [],
      });
      continue;
    }
    const sourceStatus = text(item.status);
    merged.set(key, {
      ...item,
      ...current,
      id: text(current.id) || text(item.id),
      applyUrl: text(current.applyUrl || current.canonicalUrl) || text(item.applyUrl || item.canonicalUrl),
      fitScore: Number.isFinite(Number(current.fitScore)) ? Number(current.fitScore) : item.fitScore,
      status: ['rejected', 'skipped', 'closed', 'withdrawn', 'not_selected'].includes(sourceStatus) ? sourceStatus : current.status,
      trackerStatus: text(item.trackerStatus) || text(current.trackerStatus),
      trackerNum: item.trackerNum || current.trackerNum,
      submissionSignals: [...(current.submissionSignals || []), ...(item.submissionSignals || [])],
      evidenceSources: [...new Set([...(current.evidenceSources || []), ...(item.evidenceSources || [])])],
    });
  }
  return [...merged.values()];
}

/**
 * @param {string} root
 * @param {Array<Record<string, unknown>>} queueItems
 */
export function loadReconciledApplications(root, queueItems = []) {
  const localItems = trackerItems(root);
  attachReviewEvidence(root, localItems);
  attachReviewTerminalEvidence(root, localItems);
  attachExternalEvidence(root, localItems);
  attachOutreachEvidence(root, localItems);
  const items = mergeItems(queueItems, localItems).filter((item) => !INVALID_COMPANY_RE.test(text(item.company)));
  for (const item of items) {
    const confirmed = Array.isArray(item.submissionSignals)
      && item.submissionSignals.some((signal) => signal.confirmed === true);
    if (confirmed && !TERMINAL_TRACKER_STATUSES.has(text(item.trackerStatus))) item.status = 'applied';
  }
  const audit = {
    total: items.length,
    applied: items.filter((item) => item.status === 'applied').length,
    confirmed: items.filter((item) => Array.isArray(item.submissionSignals) && item.submissionSignals.some((signal) => signal.confirmed === true)).length,
    confirmedApplied: items.filter((item) => item.status === 'applied'
      && Array.isArray(item.submissionSignals)
      && item.submissionSignals.some((signal) => signal.confirmed === true)).length,
    unconfirmedApplied: items.filter((item) => item.status === 'applied'
      && !(Array.isArray(item.submissionSignals) && item.submissionSignals.some((signal) => signal.confirmed === true))).length,
    sources: [...new Set(items.flatMap((item) => item.evidenceSources || []))].sort(),
  };
  return { items, audit };
}
