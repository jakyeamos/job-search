import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRelationshipDiscoveryPlan,
  discoverWarmContactsForApplication,
  extractGmailRelationshipContacts,
} from '../relationship-discovery.mjs';

const item = {
  company: 'Example AI',
  title: 'Backend AI Engineer',
  applyUrl: 'https://jobs.example.ai/roles/backend-ai',
};

const profile = {
  candidate: { email: 'jakyejobs@gmail.com' },
  outreach_policy: {
    relationshipSources: [
      { name: 'Amazon', terms: ['Amazon', 'AWS'], domains: ['amazon.com', 'amazon.jobs'] },
    ],
  },
};

function message(id, from, to = 'Jakye Amos <jakyejobs@gmail.com>') {
  return {
    id,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: 'Professional conversation' },
      ],
    },
  };
}

test('relationship plan searches the target company and configured warm networks', () => {
  const plan = buildRelationshipDiscoveryPlan(item, profile);
  assert.ok(plan.gmailQueries.some((query) => query.includes('example.ai')));
  assert.equal(plan.gmailQueries.some((query) => query.includes('amazon.com')), false);
  assert.ok(plan.webQueries.some((query) => query.includes('Amazon')));
});

test('Gmail relationship extraction requires target-company evidence and does not relabel unrelated relationships', () => {
  const contacts = extractGmailRelationshipContacts([
    message('target-1', 'Recruiting Team <recruiting@example.ai>'),
    message('amazon-1', 'Taylor Amazon <taylor@amazon.com>'),
    message('cwru-1', 'Professor Example <professor@case.edu>'),
    message('private-1', 'Personal Contact <person@gmail.com>'),
  ], item, profile);

  assert.equal(contacts.length, 1);
  assert.equal(contacts.find((contact) => contact.email === 'recruiting@example.ai')?.roleRelevance, 'high');
  assert.equal(contacts.some((contact) => contact.email === 'taylor@amazon.com'), false);
  assert.equal(contacts.some((contact) => contact.email === 'professor@case.edu'), false);
  assert.equal(contacts.some((contact) => contact.email === 'person@gmail.com'), false);
});

test('job-board URLs never become target-company domains for Gmail relationships', () => {
  const linkedinItem = {
    company: 'Paramount',
    title: 'Software Engineer',
    applyUrl: 'https://www.linkedin.com/comm/jobs/view/4408291912',
    canonicalUrl: 'https://www.linkedin.com/comm/jobs/view/4408291912',
  };
  const plan = buildRelationshipDiscoveryPlan(linkedinItem, profile);
  const contacts = extractGmailRelationshipContacts([
    message('linkedin-news', 'Amazon News <newsletters-noreply@linkedin.com>'),
    message('linkedin-relay', 'Jyothika Punujur <hit-reply@linkedin.com>'),
  ], linkedinItem, profile);

  assert.equal(plan.gmailQueries.some((query) => query.includes('linkedin.com')), false);
  assert.deepEqual(contacts, []);
});

test('warm discovery combines Gmail relationships with public Amazon network signals', async () => {
  const client = {
    async listMessages() { return [{ id: 'amazon-1' }]; },
    async getMessage() { return message('amazon-1', 'Taylor Amazon <taylor@amazon.com>'); },
  };
  const result = await discoverWarmContactsForApplication(item, profile, {
    gmailClient: client,
    searchFn: async () => [{
      url: 'https://www.linkedin.com/in/example-manager',
      title: 'Jordan Example - Engineering Manager - Example AI | LinkedIn',
      description: 'Jordan Example is an Engineering Manager at Example AI and previously worked at Amazon.',
    }],
  });

  assert.equal(result.status, 'found');
  assert.equal(result.contacts.some((contact) => contact.email === 'taylor@amazon.com'), false);
  assert.ok(result.contacts.some((contact) => contact.profileUrl === 'https://www.linkedin.com/in/example-manager'));
  assert.ok(result.webQueries.length > 0);
});

test('missing optional Gmail access is a warning instead of a per-role discovery error', async () => {
  const result = await discoverWarmContactsForApplication(item, profile, {
    searchFn: async () => [],
  });

  assert.equal(result.status, 'no_contacts');
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings[0], /Gmail relationship search is unavailable/i);
});

test('warm discovery respects a public-search circuit opened by another role', async () => {
  let calls = 0;
  const sourceState = {
    publicSearchUnavailableReason: 'Firecrawl credits are exhausted; automated public contact search is paused.',
  };
  const result = await discoverWarmContactsForApplication(item, profile, {
    sourceState,
    searchFn: async () => {
      calls += 1;
      return [];
    },
  });

  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /credits are exhausted/i);
  assert.equal(calls, 0);
});
