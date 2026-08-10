import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImportPlan,
  normalizeJackBoardCards,
  parseApplicationConfirmation,
} from '../application-ingest.mjs';

/** @param {string} value @returns {string} */
function encoded(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** @param {{ subject: string, from?: string, body?: string, dmarc?: string }} input */
function message(input) {
  return {
    id: 'message-1',
    internalDate: String(Date.parse('2026-07-27T12:00:00Z')),
    payload: {
      headers: [
        { name: 'Subject', value: input.subject },
        { name: 'From', value: input.from || 'Acme Recruiting <jobs@acme.example>' },
        { name: 'Authentication-Results', value: `mx.example; dmarc=${input.dmarc || 'pass'}` },
      ],
      body: { data: encoded(input.body || 'Thank you for applying.') },
    },
  };
}

test('authenticated confirmation with a dashed subject is a high-confidence signal', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Application Received - Software Engineer - Acme',
  }));
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.role, 'Software Engineer');
  assert.equal(parsed.company, 'Acme');
  assert.equal(parsed.date, '2026-07-27');
});

test('rejection emails are high-confidence Rejected evidence with the real role and company', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Auctor Application Update',
    from: 'Matthew Blackburn Hiring Team <no-reply@ashbyhq.com>',
    body: 'Thank you for applying for the Software Engineer role at Auctor. After reviewing your application, our team has decided not to move forward with your candidacy at this time.',
  }));
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.status, 'Rejected');
  assert.equal(parsed.role, 'Software Engineer');
  assert.equal(parsed.company, 'Auctor');
});

test('a URL after the role cannot be misclassified as the employer', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Thank You for applying to Sift',
    from: 'Sift Talent Team <no-reply@ashbyhq.com>',
    body: 'Thank you for applying for the Software Engineer, Backend role at http://siftstack. We decided not to move forward.',
  }));
  assert.equal(parsed.status, 'Rejected');
  assert.equal(parsed.company, 'Sift');
  assert.equal(parsed.role, 'Software Engineer, Backend');
});

test('acknowledgements normalize role suffixes and preserve parenthesized company names', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Application received by National Hockey League (NHL)',
    from: 'TeamWork Online <services@teamworkonline.com>',
    body: 'Your Application has been Received! On behalf of the National Hockey League (NHL), thank you for applying for the role of: AI Engineer role at National Hockey League (NHL).',
  }));
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.status, 'Applied');
  assert.equal(parsed.role, 'AI Engineer');
  assert.equal(parsed.company, 'National Hockey League (NHL)');
});

test('body parsing does not swallow a no-space acknowledgement tail into the company', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Thank you for applying!',
    from: 'Utah Jazz <do-not-reply@mail.paylocity.com>',
    body: 'Dear Jakye,Thank you for your interest in the AI & Innovation Intern role with Utah Jazz.We have received your application and the Hiring Manager will be reviewing it shortly.',
  }));
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.status, 'Applied');
  assert.equal(parsed.role, 'AI & Innovation Intern');
  assert.equal(parsed.company, 'Utah Jazz');
});

test('LinkedIn sent-to acknowledgements stay review-only provider evidence', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Jakye, your application was sent to Initialize',
    from: 'LinkedIn <jobs-noreply@linkedin.com>',
    body: '<a href="https://www.linkedin.com/comm/jobs/view/4441526201/?trackingId=x">Backend Python Developer (AI)\nInitialize · United Kingdom (Remote)</a>',
  }));
  assert.equal(parsed.confidence, 'review');
  assert.equal(parsed.status, 'Applied');
  assert.equal(parsed.role, 'Backend Python Developer (AI)');
  assert.equal(parsed.company, 'Initialize');
  assert.equal(parsed.url, 'https://www.linkedin.com/comm/jobs/view/4441526201/');
  assert.equal(parsed.evidenceType, 'provider-submission');
  assert.match(parsed.reason, /LinkedIn-originated/);
});

test('plain-text LinkedIn acknowledgements use the first job block, not recommended jobs', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Jakye, your application was sent to Blossom',
    from: 'LinkedIn <jobs-noreply@linkedin.com>',
    body: [
      'Your application was sent to Blossom',
      '',
      'Applied AI Software Engineer (All Levels)',
      'Blossom',
      'New York, NY',
      'View job: https://www.linkedin.com/comm/jobs/view/4419616912/',
      'View similar jobs you may be interested in',
      'Software Engineer',
      'Yext',
    ].join('\n'),
  }));
  assert.equal(parsed.confidence, 'review');
  assert.equal(parsed.company, 'Blossom');
  assert.equal(parsed.role, 'Applied AI Software Engineer (All Levels)');
  assert.equal(parsed.evidenceType, 'provider-submission');
});

test('LinkedIn rejection subjects preserve the exact role and employer', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Your application to Backend Python Developer (AI) at Initialize',
    from: 'LinkedIn <jobs-noreply@linkedin.com>',
    body: 'We will not be moving forward with your application.',
  }));
  assert.equal(parsed.status, 'Rejected');
  assert.equal(parsed.company, 'Initialize');
  assert.equal(parsed.role, 'Backend Python Developer (AI)');
});

test('LinkedIn newsletter sender cannot become employer confirmation even with application-shaped text', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Your application was sent to Amazon',
    from: 'Amazon News <newsletters-noreply@linkedin.com>',
    body: '<a href="https://www.linkedin.com/comm/jobs/view/1234567890/">Software Engineer Amazon · United States</a>',
  }));
  assert.equal(parsed.confidence, 'review');
  assert.equal(parsed.evidenceType, 'provider-submission');
  assert.notEqual(parsed.confidence, 'high');
});

test('a no-reply ATS confirmation remains eligible when provenance and job evidence are clear', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Application received - Software Engineer - FlexAI',
    from: 'FlexAI <no-reply@ats.rippling.com>',
    body: 'Thank you for applying for the Software Engineer role at FlexAI. We have received your application.',
  }));
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.evidenceType, 'company-or-ats-confirmation');
});

test('application acknowledgements preserve parenthesized roles and keep role-only mail reviewable', () => {
  const cohere = parseApplicationConfirmation(message({
    subject: 'Thanks for applying to Forward Deployed Engineer, Agentic Platform (UK/Europe) role at Cohere!',
    from: 'Cohere Talent Team <no-reply@ashbyhq.com>',
    body: 'Thanks for applying.',
  }));
  assert.equal(cohere.confidence, 'high');
  assert.equal(cohere.role, 'Forward Deployed Engineer, Agentic Platform (UK/Europe)');
  assert.equal(cohere.company, 'Cohere');

  const renaissance = parseApplicationConfirmation(message({
    subject: 'Thank you for your application!',
    from: 'Airtable Automations <noreply+automations@airtableemail.com>',
    body: 'Thank you for your application to Renaissance Philanthropy. The team will be in touch should your application progress.',
  }));
  assert.equal(renaissance.confidence, 'review');
  assert.equal(renaissance.status, 'Applied');
  assert.match(renaissance.reason, /role and company/);
});

test('brand-only sender evidence matches an existing expanded company name', () => {
  const plan = buildImportPlan({
    rows: [{ num: 991, company: 'Sift Stack, Inc.', role: 'Software Engineer, Backend (Agentic AI)', status: 'Evaluated', notes: '' }],
    emailSignals: [{ source: 'gmail', status: 'Applied', company: 'Sift', role: 'Software Engineer, Backend', date: '2026-07-29' }],
  });
  assert.deepEqual(plan.actions.map((action) => action.num), [991]);
  assert.equal(plan.actions[0].status, 'Applied');
  assert.equal(plan.actions[0].type, 'update');
});

test('import plans cannot promote a LinkedIn signal supplied after parsing', () => {
  const plan = buildImportPlan({
    rows: [{ num: 680, company: 'Initialize', role: 'Backend Python Developer (AI)', status: 'SKIP', notes: '' }],
    emailSignals: [{
      source: 'gmail',
      from: 'Amazon News <newsletters-noreply@linkedin.com>',
      subject: 'Your application was sent to Initialize',
      status: 'Applied',
      company: 'Initialize',
      role: 'Backend Python Developer (AI)',
      date: '2026-07-30',
    }],
  });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.incomingCount, 0);
  assert.equal(plan.review.length, 1);
  assert.match(plan.review[0].reason, /LinkedIn-originated/);
});

test('rejection evidence promotes an existing application without adding a duplicate row', () => {
  const plan = buildImportPlan({
    rows: [{ num: 102, company: 'Auctor', role: 'Software Engineer', status: 'Applied', notes: '' }],
    emailSignals: [{ source: 'gmail', status: 'Rejected', company: 'Auctor', role: 'Software Engineer', date: '2026-07-27' }],
  });
  assert.deepEqual(plan.actions, [{
    type: 'update',
    num: 102,
    status: 'Rejected',
    notes: 'Imported evidence: Gmail rejection 2026-07-27.',
    company: 'Auctor',
    role: 'Software Engineer',
  }]);
  assert.equal(plan.actions.some((action) => action.type === 'add'), false);
});

test('messages without DMARC pass are ignored', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Application Received - Software Engineer - Acme',
    dmarc: 'fail',
  }));
  assert.equal(parsed.confidence, 'ignore');
});

test('authenticated confirmations without reliable role or company stay in review', () => {
  const parsed = parseApplicationConfirmation(message({
    subject: 'Application Received - Software Engineer',
    from: 'Greenhouse Notifications <no-reply@greenhouse.io>',
  }));
  assert.equal(parsed.confidence, 'review');
  assert.match(parsed.reason, /role and company/);
});

test('board normalization keeps provenance and lets the importer ignore Saved cards', () => {
  const cards = normalizeJackBoardCards({
    sourceUrl: 'https://app.jackandjill.ai/jack/dashboard/jobs/kanban',
    observedAt: '2026-07-27T14:16:09Z',
    columns: [
      { name: 'Saved', cards: [{ id: 'jack-card-1', role: 'Backend Engineer', company: 'Acme', applyUrl: 'https://jobs.example/acme' }] },
      { name: 'Applied', cards: [{ role: 'Backend Engineer', company: 'Acme' }] },
    ],
  });
  assert.deepEqual(cards.map((card) => card.status), ['Saved', 'Applied']);
  assert.equal(cards[1].source, 'jackandjill');
  assert.equal(cards[1].observedAt, '2026-07-27T14:16:09Z');
  assert.equal(cards[0].sourceId, 'jack-card-1');
  assert.equal(cards[0].applyUrl, 'https://jobs.example/acme');
});

test('import plans promote evidence, preserve SKIP, and deduplicate email plus board evidence', () => {
  const plan = buildImportPlan({
    rows: [
      { num: 1, company: 'Acme', role: 'Backend Engineer', status: 'Evaluated', notes: '' },
      { num: 2, company: 'Closed', role: 'Software Engineer', status: 'SKIP', notes: 'Do not resurface' },
      { num: 3, company: 'Advanced', role: 'Platform Engineer', status: 'Interview', notes: '' },
    ],
    emailSignals: [{
      source: 'gmail',
      company: 'Acme',
      role: 'Backend Engineer',
      date: '2026-07-27',
    }],
    boardCards: [
      { source: 'jackandjill', status: 'Applied', boardStatus: 'Applied', company: 'Acme', role: 'Backend Engineer', observedAt: '2026-07-27T14:16:09Z' },
      { source: 'jackandjill', status: 'Applied', boardStatus: 'Applied', company: 'Closed', role: 'Software Engineer', observedAt: '2026-07-27T14:16:09Z' },
      { source: 'jackandjill', status: 'Applied', boardStatus: 'Applied', company: 'Advanced', role: 'Platform Engineer', observedAt: '2026-07-27T14:16:09Z' },
      { source: 'jackandjill', status: 'Saved', boardStatus: 'Saved', company: 'Saved Co', role: 'Software Engineer', observedAt: '2026-07-27T14:16:09Z' },
      { source: 'jackandjill', status: 'Applied', boardStatus: 'Applied', company: 'New Co', role: 'Software Engineer', observedAt: '2026-07-27T14:16:09Z' },
    ],
  });

  assert.equal(plan.incomingCount, 4);
  const updates = plan.actions.filter((action) => action.type === 'update');
  assert.equal(updates.length, 2);
  assert.equal(updates.find((action) => action.num === 1).status, 'Applied');
  assert.match(updates.find((action) => action.num === 1).notes, /Gmail application confirmation/);
  assert.equal(updates.find((action) => action.num === 3).status, 'Interview');
  assert.equal(plan.actions.filter((action) => action.type === 'add').length, 1);
  assert.equal(plan.actions.find((action) => action.type === 'add').company, 'New Co');
  assert.equal(plan.review.length, 1);
  assert.equal(plan.review[0].trackerNum, 2);
});
