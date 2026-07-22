import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveryQueries,
  discoverContactsForApplication,
  extractPublicContacts,
  isDiscoverableApplication,
} from '../contact-discovery.mjs';
import { rankContacts, selectContacts } from '../outreach-lib.mjs';

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

test('discovery selects an email duo when a public-profile candidate has no email', () => {
  const contacts = extractPublicContacts([
    {
      url: 'https://example.ai/team/taylor',
      title: 'Taylor Example | Engineering Manager | Example AI',
      markdown: 'Taylor Example\nEngineering Manager\ntaylor@example.ai',
    },
    {
      url: 'https://example.ai/careers',
      title: 'Example AI careers',
      markdown: 'Recruiting team: recruiting@example.ai',
    },
    {
      url: 'https://www.linkedin.com/in/jordan-example',
      title: 'Jordan Example - Technical Recruiter - Example AI | LinkedIn',
      description: 'Technical Recruiter at Example AI',
    },
  ], item);
  const selected = selectContacts(rankContacts(contacts, item), 2);
  assert.equal(selected.length, 2);
  assert.equal(selected.filter((contact) => contact.emailEligible).length, 2);
  assert.deepEqual(selected.map((contact) => contact.email).sort(), [
    'recruiting@example.ai',
    'taylor@example.ai',
  ]);
});

test('live discovery preserves contacts collected from search and scrape results', async () => {
  const calls = [];
  const result = await discoverContactsForApplication(item, {
    env: { FIRECRAWL_API_KEY: 'test-key', FIRECRAWL_API_URL: 'https://203.0.113.10' },
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

test('live discovery infers a review-only convention without making hypotheses sendable', async () => {
  const result = await discoverContactsForApplication({
    ...item,
    companyWebsite: 'https://example.ai',
  }, {
    env: { FIRECRAWL_API_KEY: 'test-key', FIRECRAWL_API_URL: 'https://203.0.113.10' },
    fetchFn: async (input) => {
      if (String(input).endsWith('/v2/search')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            web: [
              {
                url: 'https://www.linkedin.com/in/taylor-example',
                title: 'Taylor Example - Engineering Manager - Example AI | LinkedIn',
                description: 'Engineering Manager at Example AI. Contact: taylor.example@example.ai',
              },
              {
                url: 'https://www.linkedin.com/in/jordan-example',
                title: 'Jordan Example - Engineering Manager - Example AI | LinkedIn',
                description: 'Engineering Manager at Example AI. Contact: jordan.example@example.ai',
              },
              {
                url: 'https://www.linkedin.com/in/casey-example',
                title: 'Casey Example - Technical Recruiter - Example AI | LinkedIn',
                description: 'Technical Recruiter at Example AI. Contact: casey.example@example.ai',
              },
              {
                url: 'https://www.linkedin.com/in/morgan-example',
                title: 'Morgan Example - Technical Recruiter - Example AI | LinkedIn',
                description: 'Technical Recruiter at Example AI',
              },
            ],
          },
        }), { status: 200 });
      }
      throw new Error(`unexpected scrape request: ${String(input)}`);
    },
  });
  assert.equal(result.status, 'found');
  assert.equal(result.emailConventions.length, 1);
  assert.equal(result.emailConventions[0].pattern, 'first.last');
  assert.equal(result.emailHypotheses.length, 1);
  assert.equal(result.emailHypotheses[0].email, 'morgan.example@example.ai');
  assert.equal(result.emailHypotheses[0].emailVerified, false);
  assert.equal(result.emailHypotheses[0].guessed, true);
});
