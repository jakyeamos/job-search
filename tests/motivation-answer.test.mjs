import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { motivationAnswerForItem } from '../apply/motivation-answer.mjs';

const profile = {
  application_answers: {
    llm_evaluation: {
      answer: 'I built LLM evaluation, observability, and guardrail workflows using benchmarks and human review.',
      source: 'career-ops-evidence:llm-evaluation',
      evidenceBacked: true,
      evidenceRefs: ['cv.md', 'article-digest.md'],
    },
  },
};

test('motivation answers use the job description and verified corpus intersection', () => {
  const answer = motivationAnswerForItem({
    company: 'Acme AI',
    title: 'Safety Engineer',
    applyUrl: 'https://jobs.example/acme/1',
    question: 'Why Acme AI?',
    description: 'Our mission is to build reliable and interpretable AI. This role develops classifiers to detect misuse, evaluates agentic risks, and deploys mitigations for prompt injection attacks.',
  }, profile, { ledger: { entries: [] } });

  assert.equal(answer?.source, 'job-aware-motivation');
  assert.equal(answer?.answerScope, 'posting');
  assert.match(answer?.answer || '', /Acme AI/);
  assert.match(answer?.answer || '', /misuse|agentic|evaluation/i);
  assert.match(answer?.answer || '', /LLM evaluation/);
});
test('motivation stays unresolved when the posting has no meaningful corpus intersection', () => {
  const answer = motivationAnswerForItem({
    company: 'Acme Payroll',
    title: 'Office Coordinator',
    question: 'Why Acme Payroll?',
    description: 'We support a friendly office and value organization, punctuality, and clear communication. The coordinator keeps calendars current, welcomes visitors, and helps the team stay organized each day.',
  }, profile, { ledger: { entries: [] } });

  assert.equal(answer, null);
});

test('motivation stays unresolved when the job description is missing', () => {
  assert.equal(motivationAnswerForItem({
    company: 'Acme AI',
    title: 'Safety Engineer',
    question: 'Why Acme AI?',
    description: '',
  }, profile, { ledger: { entries: [] } }), null);
});

test('an existing job-aware cover-letter opening is reusable for a bare company question', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-motivation-'));
  try {
    const file = path.join(dir, 'cover-letter.txt');
    writeFileSync(file, [
      'Dear Hiring Team,',
      '',
      'What caught my attention about the Safety Engineer role at Acme AI is the combination of AI safety and evaluation. That is the intersection I have been moving toward.',
      '',
      'Best,',
      'Jakye Amos',
    ].join('\n'), 'utf8');
    const answer = motivationAnswerForItem({
      company: 'Acme AI',
      title: 'Safety Engineer',
      question: 'Why Acme AI?',
      description: '',
    }, profile, { coverLetterText: file, ledger: { entries: [] } });
    assert.equal(answer?.source, 'job-aware-cover-letter');
    assert.match(answer?.answer || '', /AI safety and evaluation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
