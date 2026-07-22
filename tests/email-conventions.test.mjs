import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmailHypotheses, inferEmailConventions } from '../email-conventions.mjs';
import { rankContacts } from '../outreach-lib.mjs';

const item = {
  company: 'Example AI',
  title: 'Backend AI Engineer',
  applyUrl: 'https://jobs.example.ai/roles/backend-ai',
};

function publicExample(name, email, sourceUrl) {
  return {
    name,
    title: 'Engineering Manager',
    company: 'Example AI',
    email,
    emailVerified: true,
    guessed: false,
    private: false,
    publicProfessional: true,
    sourceType: 'company-site',
    sourceUrl,
    roleRelevance: 'high',
  };
}

test('email convention inference requires multiple named public examples and sources', () => {
  const conventions = inferEmailConventions([
    publicExample('Taylor Example', 'taylor.example@example.ai', 'https://example.ai/team/taylor'),
    publicExample('Jordan Example', 'jordan.example@example.ai', 'https://example.ai/team/jordan'),
    publicExample('Casey Example', 'casey.example@example.ai', 'https://example.ai/about/casey'),
  ]);
  assert.equal(conventions.length, 1);
  assert.deepEqual(conventions[0], {
    domain: 'example.ai',
    pattern: 'first.last',
    confidence: 'high',
    sampleCount: 3,
    sourceCount: 3,
    evidenceUrls: [
      'https://example.ai/team/taylor',
      'https://example.ai/team/jordan',
      'https://example.ai/about/casey',
    ],
    sampleNames: ['Taylor Example', 'Jordan Example', 'Casey Example'],
    verificationState: 'public-pattern-observed',
    sendable: false,
  });

  assert.equal(inferEmailConventions([
    publicExample('Taylor Example', 'taylor.example@example.ai', 'https://example.ai/team/taylor'),
  ]).length, 0);
  assert.equal(inferEmailConventions([
    publicExample('Taylor Example', 'taylor.example@example.ai', 'https://example.ai/team/taylor'),
    { ...publicExample('Recruiting Team', 'recruiting@example.ai', 'https://example.ai/careers'), title: 'Recruiting' },
  ]).length, 0);
});

test('convention hypotheses remain ineligible until exact evidence is found', () => {
  const conventions = inferEmailConventions([
    publicExample('Taylor Example', 'taylor.example@example.ai', 'https://example.ai/team/taylor'),
    publicExample('Jordan Example', 'jordan.example@example.ai', 'https://example.ai/team/jordan'),
  ]);
  const hypotheses = buildEmailHypotheses(conventions, [{
    name: 'Morgan Example',
    title: 'Technical Recruiter',
    company: 'Example AI',
    email: null,
    emailVerified: false,
    guessed: false,
    private: false,
    publicProfessional: true,
    sourceType: 'public-profile',
    sourceUrl: 'https://www.linkedin.com/in/morgan-example',
    profileUrl: 'https://www.linkedin.com/in/morgan-example',
    roleRelevance: 'high',
  }]);
  assert.equal(hypotheses.length, 1);
  assert.equal(hypotheses[0].email, 'morgan.example@example.ai');
  assert.equal(hypotheses[0].emailVerified, false);
  assert.equal(hypotheses[0].guessed, true);
  assert.equal(hypotheses[0].emailVerificationState, 'unverified-hypothesis');
  assert.equal(hypotheses[0].sendable, false);
  assert.equal(rankContacts(hypotheses, item)[0].email, null);
  assert.equal(rankContacts(hypotheses, item)[0].emailEligible, false);
});
