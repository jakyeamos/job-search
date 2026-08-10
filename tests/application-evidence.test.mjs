import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadReconciledApplications, trackerSubmissionSignals } from '../application-evidence.mjs';

test('tracker evidence distinguishes confirmation provenance from a bare Applied label', () => {
  assert.equal(trackerSubmissionSignals('Queue applied: greenhouse-api').length, 0);
  assert.deepEqual(
    trackerSubmissionSignals('Imported evidence: Jack & Jill board: Applied (2026-07-27).').map((signal) => signal.source),
    ['jackandjill_applied'],
  );
  assert.deepEqual(
    trackerSubmissionSignals('Confirmed Gmail acknowledgement 2026-07-29; Gmail https://mail.google.com/mail/#all/abc123.').map((signal) => [signal.source, signal.messageId]),
    [['gmail_application_confirmation', 'abc123']],
  );
  assert.deepEqual(
    trackerSubmissionSignals('Already applied via LinkedIn queue.').map((signal) => signal.evidence.provenance),
    ['provider-submission'],
  );
});

test('reconciliation imports exact Sheet stages but ignores Applied AI text outside the stage field', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-evidence-'));
  try {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'applications.md'), [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | 2026-08-01 | Bare Co | Software Engineer | 4.5/5 | Applied | ❌ | — | Queue applied: greenhouse-api |',
    ].join('\n'));
    writeFileSync(path.join(root, 'data', 'application-source-evidence.json'), JSON.stringify({
      records: [
        { source: 'google_sheets', company: 'Exact Co', title: 'Backend Engineer', stage: 'Applied', dateApplied: '2026-08-01', jobUrl: 'https://example.com/exact' },
        { source: 'google_sheets', company: 'Lane Co', title: 'Applied AI Engineer', stage: '', observedAt: '2026-08-01' },
      ],
    }));
    const { items, audit } = loadReconciledApplications(root, []);
    assert.equal(items.find((item) => item.company === 'Bare Co').submissionSignals.length, 0);
    assert.equal(items.find((item) => item.company === 'Exact Co').submissionSignals[0].confirmed, true);
    assert.equal(items.some((item) => item.company === 'Lane Co'), false);
    assert.equal(audit.confirmed, 1);
    assert.equal(audit.unconfirmedApplied, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal tracker status suppresses older confirmation evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-terminal-evidence-'));
  try {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'applications.md'), [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | 2026-08-01 | Closed Co | Software Engineer | 4.5/5 | Rejected | ❌ | — | Confirmed Gmail acknowledgement 2026-07-29; Gmail https://mail.google.com/mail/#all/deadbeef. |',
    ].join('\n'));
    const { items } = loadReconciledApplications(root, []);
    assert.equal(items[0].status, 'rejected');
    assert.equal(items[0].submissionSignals[0].confirmed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact provider evidence promotes a non-terminal tracker role and ignores superseded malformed parsing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-provider-evidence-'));
  try {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'applications.md'), [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | 2026-08-01 | Blossom | Software Engineer (All Levels) | 4.3/5 | Evaluated | ❌ | — | Discovery card |',
    ].join('\n'));
    writeFileSync(path.join(root, 'data', 'application-import-review.json'), JSON.stringify({
      items: [
        { evidenceType: 'provider-submission', status: 'Applied', company: 'Backend', role: 'Software Engineer', subject: 'Jakye, your application was sent to Blossom', messageId: 'same-message' },
        { evidenceType: 'provider-submission', status: 'Applied', company: 'Blossom', role: 'Software Engineer', subject: 'Jakye, your application was sent to Blossom', messageId: 'same-message' },
      ],
    }));
    const { items } = loadReconciledApplications(root, []);
    const blossom = items.find((item) => item.company === 'Blossom');
    assert.equal(blossom.status, 'applied');
    assert.equal(blossom.fitScore, 4.3);
    assert.deepEqual(blossom.submissionSignals.map((signal) => signal.source), ['linkedin_provider_submission']);
    assert.equal(items.some((item) => item.company === 'Backend'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persisted explicit outreach confirmation survives a stale queue projection', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-outreach-evidence-'));
  try {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'applications.md'), [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | 2026-07-30 | Confirmed Co | Software Engineer | 4.6/5 | SKIP | ❌ | — | Initially skipped before submission was confirmed. |',
    ].join('\n'));
    writeFileSync(path.join(root, 'data', 'outreach-state.json'), JSON.stringify({
      records: [{
        key: 'confirmedco::softwareengineer',
        company: 'Confirmed Co',
        title: 'Software Engineer',
        submission: {
          confirmed: true,
          confirmedAt: '2026-08-01T12:00:00.000Z',
          signals: [{ source: 'user_confirmed_submission', confirmed: true, at: '2026-08-01T12:00:00.000Z' }],
        },
      }],
    }));
    const queueItems = [{
      id: 'queue-confirmed',
      company: 'Confirmed Co',
      title: 'Software Engineer',
      status: 'skipped',
      fitScore: 4.6,
      applyUrl: 'https://example.com/job',
    }];
    const { items, audit } = loadReconciledApplications(root, queueItems);
    assert.equal(items[0].status, 'applied');
    assert.equal(items[0].fitScore, 4.6);
    assert.equal(items[0].submissionSignals[0].source, 'user_confirmed_submission');
    assert.equal(audit.confirmedApplied, 1);
    assert.deepEqual(audit.sources, ['outreach-state', 'tracker']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a later exact provider rejection supersedes an earlier provider submission', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-provider-terminal-'));
  try {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'applications.md'), [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | 2026-07-30 | Initialize | Backend Python Developer (AI) | 5.0/5 | SKIP | ❌ | — | Provider evidence. |',
    ].join('\n'));
    writeFileSync(path.join(root, 'data', 'application-import-review.json'), JSON.stringify({
      items: [
        { evidenceType: 'provider-submission', status: 'Applied', company: 'Initialize', role: 'Backend Python Developer (AI)', subject: 'Jakye, your application was sent to Initialize', date: '2026-07-30' },
        { evidenceType: 'provider-submission', status: 'Rejected', company: 'Initialize', role: 'Backend Python Developer (AI)', subject: 'Your application to Backend Python Developer (AI) at Initialize', date: '2026-08-02' },
      ],
    }));
    const { items, audit } = loadReconciledApplications(root, []);
    assert.equal(items[0].status, 'rejected');
    assert.equal(items[0].trackerStatus, 'Rejected');
    assert.equal(audit.confirmedApplied, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregate notification identities are excluded even when legacy notes look confirmed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-aggregate-evidence-'));
  try {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'applications.md'), [
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | 2026-07-30 | Jobs for You: Example + 2 More | Job lead | 1.0/5 | SKIP | ❌ | — | Confirmed Gmail acknowledgement 2026-07-30. |',
    ].join('\n'));
    const { items } = loadReconciledApplications(root, []);
    assert.equal(items.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
