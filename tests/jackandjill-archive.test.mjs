import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendLedgerEvents,
  buildArchivePlan,
  decideArchive,
  recordArchiveOutcome,
  readLedger,
} from '../jackandjill-archive.mjs';

function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-jack-archive-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  mkdirSync(path.join(root, 'reports'), { recursive: true });
  return root;
}

function writeTracker(root, row) {
  writeFileSync(path.join(root, 'data', 'applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    `| ${row.num} | 2026-08-01 | ${row.company} | ${row.role} | ${row.score} | ${row.status} | ❌ | ${row.report || '—'} | ${row.notes || ''} |`,
    '',
  ].join('\n'));
}

function writeBoard(root, card) {
  writeFileSync(path.join(root, 'data', 'jackandjill-board.json'), JSON.stringify({
    schemaVersion: 1,
    observedAt: '2026-08-01T12:00:00Z',
    cards: [card],
  }));
}

test('below-threshold SKIP with verified report becomes an archive candidate', () => {
  const root = fixtureRoot();
  writeTracker(root, {
    num: 1,
    company: 'Acme',
    role: 'Software Engineer, Infrastructure',
    score: '3.6/5',
    status: 'SKIP',
    report: '[1](../reports/001-acme.md)',
  });
  writeFileSync(path.join(root, 'reports', '001-acme.md'), '**Verification:** confirmed live by Playwright\n');
  writeBoard(root, { status: 'Saved', company: 'Acme', role: 'Software Engineer, Infrastructure', ageText: 'Today' });

  const plan = buildArchivePlan({ root, observedAt: '2026-08-01T12:01:00Z' });
  assert.equal(plan.counts.eligible, 1);
  assert.equal(plan.pendingArchive[0].action, 'archive');
  assert.match(plan.pendingArchive[0].reasoning, /3\.6\/5.*4\.0\/5/);
});

test('applied cards and undisposed tracker rows are fail-closed', () => {
  const applied = decideArchive({
    card: { status: 'Applied', company: 'Acme', role: 'Software Engineer' },
    trackerRow: { num: 1, score: '3.0/5', status: 'SKIP', notes: 'official posting live' },
  });
  assert.equal(applied.decision, 'blocked');
  assert.deepEqual(applied.reasonCodes, ['application-stage']);

  const undisposed = decideArchive({
    card: { status: 'Saved', company: 'Acme', role: 'Software Engineer' },
    trackerRow: { num: 2, score: '3.0/5', status: 'Evaluated', notes: 'official posting live' },
  });
  assert.equal(undisposed.decision, 'blocked');
  assert.deepEqual(undisposed.reasonCodes, ['tracker-not-disposed']);
});

test('ledger is append-only and archived outcome can only follow a pending plan', () => {
  const root = fixtureRoot();
  const file = path.join(root, 'data', 'ledger.jsonl');
  const event = { schemaVersion: 1, sourceKey: 'jackandjill:card:acme:softwareengineer', eventType: 'decision', externalAction: 'pending', decision: 'eligible' };
  appendLedgerEvents(file, [event]);
  const before = readFileSync(file, 'utf8');
  const outcome = recordArchiveOutcome({ ledgerFile: file, sourceKey: event.sourceKey, outcome: 'archived', note: 'Archived in Jack & Jill board.' });
  assert.equal(outcome.externalAction, 'archived');
  assert.equal(readLedger(file).length, 2);
  assert.match(readFileSync(file, 'utf8'), new RegExp(before.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('plan write records a decision once and remains stable on rerun', () => {
  const root = fixtureRoot();
  writeTracker(root, { num: 1, company: 'Acme', role: 'Software Engineer', score: '3.0/5', status: 'SKIP', notes: 'Official posting is live; level mismatch.' });
  writeBoard(root, { status: 'Saved', company: 'Acme', role: 'Software Engineer', ageText: 'Today' });
  const first = buildArchivePlan({ root, write: true, observedAt: '2026-08-01T12:00:00Z' });
  const second = buildArchivePlan({ root, write: true, observedAt: '2026-08-01T12:05:00Z' });
  assert.equal(first.ledgerAppended, 1);
  assert.equal(second.ledgerAppended, 0);
  assert.equal(readLedger(path.join(root, 'data', 'jackandjill-archive-ledger.jsonl')).length, 1);
});

test('recorded blocked outcome closes a pending archive without losing its reasoning', () => {
  const root = fixtureRoot();
  writeTracker(root, { num: 1, company: 'Acme', role: 'Software Engineer', score: '3.0/5', status: 'SKIP', notes: 'Official posting is live; level mismatch.' });
  writeBoard(root, { status: 'Saved', company: 'Acme', role: 'Software Engineer', ageText: 'Today' });
  const ledgerFile = path.join(root, 'data', 'jackandjill-archive-ledger.jsonl');
  const first = buildArchivePlan({ root, ledgerFile, write: true, observedAt: '2026-08-01T12:00:00Z' });
  recordArchiveOutcome({ ledgerFile, sourceKey: first.pendingArchive[0].sourceKey, outcome: 'blocked', note: 'not present in live board' });
  const second = buildArchivePlan({ root, ledgerFile, observedAt: '2026-08-01T12:00:00Z' });
  assert.equal(second.pendingArchive.length, 0);
  assert.match(second.decisions[0].reasoning, /below/);
});

test('stale board snapshots produce no archive candidates', () => {
  const root = fixtureRoot();
  writeTracker(root, { num: 1, company: 'Acme', role: 'Software Engineer', score: '3.0/5', status: 'SKIP', notes: 'Official posting is live.' });
  writeBoard(root, { status: 'Saved', company: 'Acme', role: 'Software Engineer', ageText: '5d ago' });
  const plan = buildArchivePlan({ root, observedAt: '2026-08-10T12:00:00Z' });
  assert.equal(plan.boardFresh, false);
  assert.equal(plan.pendingArchive.length, 0);
  assert.deepEqual(plan.decisions[0].reasonCodes, ['stale-board-snapshot']);
});
