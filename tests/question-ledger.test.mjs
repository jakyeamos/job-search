import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerQuestion,
  answerTable,
  answerReference,
  findReusableAnswer,
  isSensitiveQuestion,
  loadLedger,
  lookupAnswer,
  recordEvidenceBackedAnswerInLedger,
  pendingQuestions,
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

test('question context retains options and supports role-scoped reuse', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-context-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const first = recordQuestion(file, 'Which accomplishment are you most proud of?', {
      company: 'Acme',
      role: 'Backend Engineer',
      url: 'https://jobs.example/acme/1',
      queueId: 'q1',
      options: ['Pre-CR Suite', 'Tenure'],
    });
    recordQuestion(file, first.question, {
      company: 'Beta',
      role: 'Applied AI Engineer',
      url: 'https://jobs.example/beta/1',
      queueId: 'q2',
      options: ['Tenure'],
    });
    const entry = loadLedger(file).entries[0];
    assert.equal(entry.contexts.length, 2);
    assert.deepEqual(entry.options, ['Tenure']);
    answerQuestion(file, first.id, 'Pre-CR Suite', { scope: 'role', company: 'Acme', role: 'Backend Engineer' });
    assert.equal(lookupAnswer(first.question, loadLedger(file), { company: 'Acme', role: 'Backend Engineer' }), 'Pre-CR Suite');
    assert.equal(lookupAnswer(first.question, loadLedger(file), { company: 'Beta', role: 'Applied AI Engineer' }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('semantically equivalent location questions reuse one canonical entry', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-semantic-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const first = recordQuestion(file, 'Where do you plan to work from?', { fieldKind: 'text' });
    const secondQuestion = 'From where do you intend to work? Please note: employees must be based in the United States or Canada';
    const second = recordQuestion(file, secondQuestion, { fieldKind: 'text' });
    assert.equal(second.id, first.id);
    assert.equal(loadLedger(file).entries.length, 1);
    assert.deepEqual(loadLedger(file).entries[0].aliases, [secondQuestion]);
  answerQuestion(file, first.id, 'Buffalo, NY', { scope: 'question' });
  assert.equal(lookupAnswer(secondQuestion, loadLedger(file), { fieldKind: 'text' }), 'Buffalo, NY');
  assert.equal(findReusableAnswer(secondQuestion, loadLedger(file), { fieldKind: 'text' }).matchType, 'alias');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('different semantic questions do not collapse into one ledger entry', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-distinct-'));
  try {
    const file = path.join(dir, 'ledger.json');
    recordQuestion(file, 'Where do you plan to work from?', { fieldKind: 'text' });
    recordQuestion(file, 'What is your expected salary?', { fieldKind: 'text' });
    assert.equal(loadLedger(file).entries.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter-observed answers are not reusable until the user confirms them', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-unconfirmed-'));
  try {
    const file = path.join(dir, 'ledger.json');
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        id: 'q_adapter',
        question: 'Do you require sponsorship?',
        status: 'answered',
        answer: 'No',
        source: 'adapter:greenhouse',
      }],
    }));
    const ledger = loadLedger(file);
    assert.equal(ledger.entries[0].answerStatus, 'unconfirmed');
    assert.equal(lookupAnswer('Do you require sponsorship?', ledger), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence-backed answers are reusable, scoped, and excluded from pending normal questions', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-evidence-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const entry = recordQuestion(file, 'Which accomplishment are you most proud of?', {
      company: 'Acme', role: 'Backend Engineer', url: 'https://jobs.example/acme/1', fieldKind: 'textarea',
    });
    const ledger = loadLedger(file);
    const promoted = recordEvidenceBackedAnswerInLedger(ledger, entry.id, 'I built a reliable platform.', {
      scope: 'role',
      company: 'Acme',
      role: 'Backend Engineer',
      url: 'https://jobs.example/acme/1',
      evidenceRefs: ['cv.md', '/Users/jakyeamos/projects/acme/README.md'],
    });
    assert.ok(promoted);
    assert.equal(promoted.answer.answerStatus, 'evidence-backed');
    assert.equal(findReusableAnswer(entry.question, ledger, { company: 'Acme', role: 'Backend Engineer', fieldKind: 'textarea' }).answer, 'I built a reliable platform.');
    assert.equal(findReusableAnswer(entry.question, ledger, { company: 'Other', role: 'Backend Engineer', fieldKind: 'textarea' }), null);
    assert.equal(pendingQuestions(ledger).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence-backed answers never auto-confirm sensitive questions', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-evidence-sensitive-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const entry = recordQuestion(file, 'Will you now or in the future require visa sponsorship?', { fieldKind: 'radio' });
    const ledger = loadLedger(file);
    assert.equal(recordEvidenceBackedAnswerInLedger(ledger, entry.id, 'No', { scope: 'question', evidenceRefs: ['config/application-profile.json'] }), null);
    assert.equal(lookupAnswer(entry.question, ledger), null);
    assert.equal(pendingQuestions(ledger).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmed answers receive stable versioned references and pending questions group contexts', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-refs-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const first = recordQuestion(file, 'What is your preferred start date?', {
      company: 'Acme', role: 'Backend Engineer', url: 'https://jobs.example/acme/1', queueId: 'q1',
    });
    recordQuestion(file, first.question, {
      company: 'Beta', role: 'Platform Engineer', url: 'https://jobs.example/beta/2', queueId: 'q2',
    });
    assert.equal(pendingQuestions(loadLedger(file)).length, 1);
    assert.equal(pendingQuestions(loadLedger(file))[0].contexts.length, 2);

    const v1 = answerQuestion(file, first.id, 'Immediately', { scope: 'question' });
    assert.equal(v1.answerVersion, 1);
    assert.equal(answerReference(v1), `question-ledger:${first.id}@v1`);
    const v2 = answerQuestion(file, first.id, 'Two weeks', { scope: 'question' });
    assert.equal(v2.answerVersion, 2);
    assert.equal(answerReference(v2), `question-ledger:${first.id}@v2`);
    assert.equal(findReusableAnswer(first.question, loadLedger(file))?.answerRef, `question-ledger:${first.id}@v2`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conflicting company-scoped answers remain isolated behind one question id', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-ledger-conflicts-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const entry = recordQuestion(file, 'Which office would you work from?', {});
    answerQuestion(file, entry.id, 'Buffalo', { scope: 'company', company: 'Acme' });
    answerQuestion(file, entry.id, 'New York', { scope: 'company', company: 'Beta' });
    const ledger = loadLedger(file);
    assert.equal(lookupAnswer(entry.question, ledger, { company: 'Acme' }), 'Buffalo');
    assert.equal(lookupAnswer(entry.question, ledger, { company: 'Beta' }), 'New York');
    assert.equal(lookupAnswer(entry.question, ledger, { company: 'Other' }), null);
    assert.deepEqual(answerTable(ledger, { company: 'Acme' }).map((row) => row.value), ['Buffalo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
