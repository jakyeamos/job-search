import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveryQueries,
  discoverContactsForApplication,
  extractPublicContacts,
  isDiscoverableApplication,
} from '../contact-discovery.mjs';

const item = {
  company: 'Example AI',
  title: 'Backend AI Engineer',
  applyUrl: 'https://jobs.example.ai/roles/backend-ai',
};

test('contact discovery rejects aggregate alert identities', () => {
  assert.equal(isDiscoverableApplication(item), true);
  assert.equal(isDiscoverableApplication({
    ...item,
    company: 'F-ADA and 7 more jobs in New York, NY for you. Apply Now.',
  }), false);
  assert.equal(buildDiscoveryQueries(item).length, 2);
  assert.equal(buildDiscoveryQueries({ ...item, company: 'F-ADA and 7 more jobs' }).length, 0);
});

test('contact extraction only marks public company evidence as email-eligible', () => {
  const contacts = extractPublicContacts([
    {
      url: 'https://example.ai/team',
      title: 'Taylor Example | Engineering Manager | Example AI',
      markdown: 'Taylor Example\nEngineering Manager\n[taylor@example.ai](mailto:taylor@example.ai)',
    },
    {
      url: 'https://example.ai/careers',
      title: 'Example AI careers',
      markdown: 'Recruiting team: recruiting@example.ai',
    },
    {
      url: 'https://example.ai/about',
      title: 'Example AI leadership',
      markdown: 'Private mailbox: someone@gmail.com',
    },
    {
      url: 'https://other.example/team',
      title: 'Example AI team',
      markdown: 'Taylor Example\nEngineering Manager\ntaylor@example.ai',
    },
  ], item);

  assert.equal(contacts.length, 2);
  assert.equal(contacts.find((contact) => contact.name === 'Taylor Example')?.emailVerified, true);
  assert.equal(contacts.find((contact) => contact.name === 'Recruiting Team')?.email, 'recruiting@example.ai');
  assert.equal(contacts.some((contact) => contact.email === 'someone@gmail.com'), false);
  assert.equal(contacts.some((contact) => contact.sourceUrl === 'https://other.example/team'), false);
});

test('LinkedIn search results produce manual-only contact drafts', () => {
  const contacts = extractPublicContacts([{
    url: 'https://www.linkedin.com/in/taylor-example',
    title: 'Taylor Example - Engineering Manager - Example AI | LinkedIn',
    description: 'Engineering Manager at Example AI',
  }], item);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].emailVerified, false);
  assert.equal(contacts[0].email, null);
  assert.equal(contacts[0].sourceType, 'public-profile');
});

test('LinkedIn result snippets preserve explicitly published employer emails', () => {
  const contacts = extractPublicContacts([{
    url: 'https://www.linkedin.com/in/stephanie-example',
    title: 'Stephanie Example - Senior Technical Recruiter at Amazon Web Services | LinkedIn',
    description: 'Senior Technical Recruiter at Amazon Web Services. Contact: stephanie@amazon.com',
  }], {
    company: 'Amazon Web Services, Inc.',
    title: 'Big Data Engineer II',
    applyUrl: 'https://www.amazon.jobs/en/jobs/123/big-data-engineer-ii',
  });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].email, 'stephanie@amazon.com');
  assert.equal(contacts[0].emailVerified, true);
});

test('live discovery preserves contacts collected from search and scrape results', async () => {
  const calls = [];
  const result = await discoverContactsForApplication(item, {
    env: { FIRECRAWL_API_KEY: 'test-key', FIRECRAWL_API_URL: 'https://example.com' },
    fetchFn: async (input) => {
      calls.push(String(input));
      if (String(input).endsWith('/v2/search')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            web: [{
              url: 'https://example.ai/team',
              title: 'Taylor Example | Engineering Manager | Example AI',
              description: 'Example AI engineering leadership',
            }],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: { markdown: 'Example AI\nTaylor Example\nEngineering Manager\ntaylor@example.ai' },
      }), { status: 200 });
    },
  });
  assert.equal(result.status, 'found');
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].email, 'taylor@example.ai');
  assert.equal(calls.filter((url) => url.endsWith('/v2/search')).length, 2);
  assert.equal(calls.filter((url) => url.endsWith('/v2/scrape')).length, 2);
});
