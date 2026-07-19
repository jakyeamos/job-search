import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerQuestion,
  answerTable,
  isSensitiveQuestion,
  loadLedger,
  lookupAnswer,
  recordQuestion,
} from '../apply/question-ledger.mjs';

test('ledger records an unresolved form question and reuses an explicit global answer', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const entry = recordQuestion(file, 'Are you excited to work in person in New York City 5 days a week?', { company: 'Blossom' });
    assert.equal(entry.status, 'unanswered');
    const answered = answerQuestion(file, entry.id, 'Yes', { scope: 'global' });
    assert.equal(answered.status, 'answered');
    assert.equal(lookupAnswer('Are you excited to work in person in New York City 5 days a week?', loadLedger(file)), 'Yes');
    assert.equal(answerTable(loadLedger(file)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sensitive answers need explicit confirmation for global reuse', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-sensitive-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const entry = recordQuestion(file, 'Will you now or in the future require visa sponsorship?', {});
    assert.equal(isSensitiveQuestion(entry.question), true);
    assert.throws(() => answerQuestion(file, entry.id, 'No', { scope: 'global' }), /sensitive answers/);
    assert.equal(answerQuestion(file, entry.id, 'No', { scope: 'global', confirmSensitive: true }).answer, 'No');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scoped answers do not leak across companies', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-scope-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const entry = recordQuestion(file, 'What is your preferred start date?', {});
    answerQuestion(file, entry.id, 'Immediately', { scope: 'company', company: 'Acme' });
    assert.equal(lookupAnswer(entry.question, loadLedger(file), { company: 'Other' }), null);
    assert.equal(lookupAnswer(entry.question, loadLedger(file), { company: 'Acme' }), 'Immediately');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
