import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerFor,
  commonQuestions,
  matchAnswerToOptions,
  matchAnswersToOptions,
  sponsorshipRequirement,
} from '../apply/lib/adapter-core.mjs';

const profile = {
  work_authorization: {
    authorized_us: true,
    requires_sponsorship: false,
    requires_sponsorship_outside_us: true,
  },
  application_answers: {
    referral_source: { answer: 'Job board' },
    full_time: { answer: 'Yes' },
    technology_most_experience: { answer: 'Other' },
    kubernetes_experience: { answer: 'Basic familiarity (read documentation or tutorials)' },
    on_call_rotation: { answer: 'Yes' },
    sentry_used: { answer: 'Yes' },
    professional_software_engineering_3_years: { answer: 'Yes' },
    travel_up_to_20_percent: { answer: 'Yes' },
    open_source_contribution: { answer: 'Yes' },
    open_source_contribution_example: { answer: 'I maintain Quality Runner and improve its documentation and tests.' },
  },
};

test('reusable application defaults cover recurring factual questions', () => {
  const table = commonQuestions(profile, { location: 'Remote, United States' });
  assert.equal(answerFor('How did you hear about us?', [table]), 'Job board');
  assert.equal(answerFor('Are you seeking a full-time position?', [table]), 'Yes');
  assert.equal(answerFor('Please select the technology you have the most experience with:', [table]), 'Other');
  assert.equal(answerFor('Kubernetes experience', [table]), 'Basic familiarity (read documentation or tutorials)');
  assert.equal(answerFor('Are you willing to participate in an on-call rotation for 7 days per month?', [table]), 'Yes');
  assert.equal(answerFor('Have you ever used Sentry before?', [table]), 'Yes');
  assert.equal(answerFor('Do you have at least 3 years of professional experience in software engineering?', [table]), 'Yes');
  assert.equal(answerFor('Can you travel if needed, to meet with customers and partners (less than 20% of the time)?', [table]), 'Yes');
  assert.equal(answerFor('Have you contributed to open-source projects before?', [table]), 'Yes');
  assert.match(answerFor('Share an example of an open-source contribution you participated in.', [table]), /Quality Runner/);
});

test('sponsorship follows the application location', () => {
  assert.equal(sponsorshipRequirement(profile, { location: 'Remote, United States' }), false);
  assert.equal(sponsorshipRequirement(profile, { location: 'London, UK' }), true);
  assert.equal(sponsorshipRequirement(profile, { title: 'Deployed Engineer (Amsterdam)' }), true);
  assert.equal(sponsorshipRequirement(profile, { location: 'Remote' }), false);
});

test('job board defaults choose the generic job-board option', () => {
  assert.equal(
    matchAnswerToOptions('Job board', ['Investor Job board', 'Job Board (e.g. Welcome To The Jungle)', 'Other']),
    'Job Board (e.g. Welcome To The Jungle)',
  );
});

test('adapter common questions expose job-aware company motivation when evidence intersects', () => {
  const table = commonQuestions({
    application_answers: {
      llm_evaluation: {
        answer: 'I built LLM evaluation, observability, and guardrail workflows using benchmarks and human review.',
        evidenceBacked: true,
        evidenceRefs: ['cv.md'],
      },
    },
  }, {
    company: 'Acme AI',
    title: 'Safety Engineer',
    url: 'https://jobs.example/acme/1',
    description: 'Our mission is to build reliable and interpretable AI. This role develops classifiers to detect misuse, evaluates agentic risks, and deploys mitigations for prompt injection attacks.',
  });

  assert.match(answerFor('Why Acme AI?', [table]) || '', /LLM evaluation/);
});

test('multiple ledger answers match each checkbox option independently', () => {
  assert.deepEqual(
    matchAnswersToOptions('API keys; OAuth 2.0; JWT', ['API keys', 'OAuth 2.0', 'JWT', 'None']),
    ['API keys', 'OAuth 2.0', 'JWT'],
  );
});
