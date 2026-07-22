import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCandidateEmailVerificationQuery,
  buildExactEmailVerificationQuery,
  buildDiscoveryQueries,
  discoverContactsForApplication,
  extractPublicContacts,
  isDiscoverableApplication,
  verifyPublicEmailHypotheses,
  verifyPublicCandidateEmails,
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
  const queries = buildDiscoveryQueries(item);
  assert.equal(queries.length, 5);
  assert.ok(queries.some((query) => query.includes('site:linkedin.com/in') && query.includes('recruiter')));
  assert.ok(queries.some((query) => query.includes('site:linkedin.com/in') && query.includes('engineering manager')));
  assert.ok(queries.some((query) => query.includes('site:example.ai') && query.includes('"@example.ai"')));
  assert.equal(buildDiscoveryQueries({ ...item, company: 'F-ADA and 7 more jobs' }).length, 0);
  const greenhouseQueries = buildDiscoveryQueries({
    ...item,
    company: 'Example Cloud',
    applyUrl: 'https://job-boards.greenhouse.io/examplecloud/jobs/123',
  });
  assert.equal(greenhouseQueries.length, 4);
  assert.equal(greenhouseQueries.some((query) => query.includes('greenhouse.io')), false);
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
    {
      url: 'https://rocketreach.co/taylor-example-email_12345',
      title: 'Taylor Example - Example AI',
      markdown: 'Taylor Example\ntaylor@example.ai',
    },
    {
      url: 'https://wiza.co/d/example-ai/taylor-example',
      title: 'Taylor Example - Example AI',
      markdown: 'Taylor Example\ntaylor@example.ai',
    },
    {
      url: 'https://chairnerd.example.ai/policy/email-access',
      title: 'Example IAM Policy | Example AI',
      markdown: 'Example IAM Policy\nteam: developer-experience\nzhammer@example.ai',
    },
  ], item);

  assert.equal(contacts.length, 2);
  assert.equal(contacts.find((contact) => contact.name === 'Taylor Example')?.emailVerified, true);
  assert.equal(contacts.find((contact) => contact.name === 'Recruiting Team')?.email, 'recruiting@example.ai');
  assert.equal(contacts.some((contact) => contact.email === 'someone@gmail.com'), false);
  assert.equal(contacts.some((contact) => contact.sourceUrl.includes('rocketreach.co')), false);
  assert.equal(contacts.some((contact) => contact.sourceUrl.includes('wiza.co')), false);
  assert.equal(contacts.some((contact) => contact.sourceUrl === 'https://other.example/team'), false);
  assert.equal(contacts.some((contact) => contact.email === 'zhammer@example.ai'), false);
});

test('LinkedIn alumni snippets are not promoted as current employer contacts', () => {
  const contacts = extractPublicContacts([{
    url: 'https://www.linkedin.com/in/frank-cebek',
    title: 'Frank Cebek - VP, Talent Acquisition and HR Ops at Gravie',
    description: 'SeatGeek Graphic. Left the company.',
  }], {
    company: 'SeatGeek',
    title: 'Software Engineer - New Grad (New York)',
    applyUrl: 'https://seatgeek.com/jobs/7858968',
  });
  assert.equal(contacts.length, 0);
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

test('exact email verification promotes only a named public match', async () => {
  const hypothesis = {
    name: 'Morgan Example',
    title: 'Technical Recruiter',
    company: 'Example AI',
    email: 'morgan.example@example.ai',
    sourceUrl: 'https://www.linkedin.com/in/morgan-example',
  };
  assert.equal(buildExactEmailVerificationQuery(hypothesis, item), '"morgan.example@example.ai" "Morgan Example" "Example AI"');
  const verified = await verifyPublicEmailHypotheses([hypothesis], item, {
    searchFn: async () => [{
      url: 'https://example.ai/team/morgan',
      title: 'Morgan Example | Technical Recruiter | Example AI',
      markdown: 'Morgan Example\nTechnical Recruiter\nmorgan.example@example.ai',
    }],
  });
  assert.equal(verified.contacts.length, 1);
  assert.equal(verified.contacts[0].email, hypothesis.email);
  assert.equal(verified.contacts[0].emailVerified, true);
  assert.equal(verified.contacts[0].guessed, false);
  assert.equal(verified.contacts[0].emailVerificationType, 'exact-public-source');
  assert.equal(verified.verifications[0].status, 'verified-exact-public-source');

  const mismatch = await verifyPublicEmailHypotheses([hypothesis], item, {
    searchFn: async () => [{
      url: 'https://example.ai/team/other',
      title: 'Jordan Example | Technical Recruiter | Example AI',
      markdown: 'Jordan Example\nTechnical Recruiter\nmorgan.example@example.ai',
    }],
  });
  assert.equal(mismatch.contacts.length, 0);
  assert.equal(mismatch.verifications[0].status, 'not_observed');
});

test('candidate email discovery searches names without inventing an address', async () => {
  const candidate = {
    name: 'Morgan Example',
    title: 'Technical Recruiter',
    company: 'Example AI',
    email: null,
    sourceType: 'public-profile',
    sourceUrl: 'https://www.linkedin.com/in/morgan-example',
  };
  assert.equal(
    buildCandidateEmailVerificationQuery(candidate, { ...item, companyWebsite: 'https://example.ai' }),
    '"Morgan Example" "Example AI" email contact',
  );
  const result = await verifyPublicCandidateEmails([candidate], { ...item, companyWebsite: 'https://example.ai' }, {
    searchFn: async () => [{
      url: 'https://example.ai/team/morgan',
      title: 'Morgan Example | Technical Recruiter | Example AI',
      markdown: 'Morgan Example\nTechnical Recruiter\nmorgan@example.ai',
    }],
  });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].email, 'morgan@example.ai');
  assert.equal(result.contacts[0].emailVerificationType, 'exact-public-source');
  assert.equal(result.verifications[0].status, 'verified-exact-public-source');

  const fallbackQueries = [];
  const fallback = await verifyPublicCandidateEmails([candidate], { ...item, companyWebsite: 'https://example.ai' }, {
    searchFn: async (query) => {
      fallbackQueries.push(query);
      return query.includes('site:example.ai') ? [{
        url: 'https://example.ai/team/morgan',
        title: 'Morgan Example | Technical Recruiter | Example AI',
        markdown: 'Morgan Example\nTechnical Recruiter\nmorgan@example.ai',
      }] : [];
    },
  });
  assert.equal(fallback.contacts.length, 1);
  assert.equal(fallbackQueries.length, 2);
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
            }, {
              url: 'https://www.instagram.com/example',
              title: 'Example AI recruiting',
              description: 'Taylor Example Engineering Manager Example AI',
            }, {
              url: 'https://wiza.co/d/example-ai/1234/taylor-example',
              title: 'Taylor Example - Example AI',
              description: 'Engineering Manager',
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
  assert.equal(result.sources.some((source) => /instagram\.com|wiza\.co/.test(source)), false);
  assert.equal(calls.filter((url) => url.endsWith('/v2/search')).length, 5);
  assert.equal(calls.filter((url) => url.endsWith('/v2/scrape')).length, 5);
});

test('public candidates receive bounded exact email verification', async () => {
  const searchQueries = [];
  const result = await discoverContactsForApplication(item, {
    env: { FIRECRAWL_API_KEY: 'test-key', FIRECRAWL_API_URL: 'https://203.0.113.10' },
    fetchFn: async (input, init) => {
      if (String(input).endsWith('/v2/search')) {
        const body = JSON.parse(String(init?.body || '{}'));
        const query = String(body.query || '');
        searchQueries.push(query);
        const web = query.includes('email contact')
          ? [{
            url: 'https://example.ai/team/morgan',
            title: 'Morgan Example | Technical Recruiter | Example AI',
            markdown: 'Morgan Example\nTechnical Recruiter\nmorgan@example.ai',
          }]
          : [{
            url: 'https://www.linkedin.com/in/morgan-example',
            title: 'Morgan Example - Technical Recruiter - Example AI | LinkedIn',
            description: 'Technical Recruiter at Example AI',
          }];
        return new Response(JSON.stringify({ success: true, data: { web } }), { status: 200 });
      }
      throw new Error(`unexpected scrape request: ${String(input)}`);
    },
  });
  assert.equal(result.status, 'found');
  assert.ok(result.contacts.some((contact) => contact.email === 'morgan@example.ai'));
  assert.equal(result.candidateEmailVerification[0].status, 'verified-exact-public-source');
  assert.equal(searchQueries.length, 6);
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
  assert.equal(result.emailVerification[0].status, 'not_observed');
});
