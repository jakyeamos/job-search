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
  assert.ok(plan.gmailQueries.some((query) => query.includes('amazon.com')));
  assert.ok(plan.webQueries.some((query) => query.includes('Amazon')));
});

test('Gmail relationship extraction finds target-company and Amazon connections without reading message bodies', () => {
  const contacts = extractGmailRelationshipContacts([
    message('target-1', 'Recruiting Team <recruiting@example.ai>'),
    message('amazon-1', 'Taylor Amazon <taylor@amazon.com>'),
    message('private-1', 'Personal Contact <person@gmail.com>'),
  ], item, profile);

  assert.equal(contacts.length, 2);
  assert.equal(contacts.find((contact) => contact.email === 'recruiting@example.ai')?.roleRelevance, 'high');
  assert.equal(contacts.find((contact) => contact.email === 'taylor@amazon.com')?.relationshipType, 'existing_amazon_relationship');
  assert.equal(contacts.find((contact) => contact.email === 'taylor@amazon.com')?.sourceType, 'first-party-relationship');
  assert.equal(contacts.some((contact) => contact.email === 'person@gmail.com'), false);
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
  assert.ok(result.contacts.some((contact) => contact.email === 'taylor@amazon.com'));
  assert.ok(result.contacts.some((contact) => contact.profileUrl === 'https://www.linkedin.com/in/example-manager'));
  assert.ok(result.webQueries.length > 0);
});
