import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCandidateEmailVerificationQuery,
  buildCandidateXVerificationQueries,
  buildExactEmailVerificationQuery,
  buildDiscoveryQueries,
  classifyPublicSearchFailure,
  discoverContactsForApplication,
  extractPublicContacts,
  isDiscoverableApplication,
  verifyPublicEmailHypotheses,
  verifyPublicCandidateEmails,
  verifyPublicCandidateXProfiles,
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
  assert.equal(queries.length, 9);
  assert.ok(queries.includes('site:linkedin.com/in "Example AI"'));
  assert.ok(queries.some((query) => query.includes('site:linkedin.com/in') && query.includes('recruiter')));
  assert.ok(queries.some((query) => query.includes('site:linkedin.com/in') && query.includes('engineering manager')));
  assert.ok(queries.some((query) => query.includes('site:example.ai') && query.includes('"@example.ai"')));
  assert.ok(queries.some((query) => query.includes('site:x.com')));
  assert.ok(queries.some((query) => query.includes('site:twitter.com')));
  assert.ok(queries.some((query) => query.includes('site:x.com') && query.includes('software engineer')));
  assert.equal(buildDiscoveryQueries({ ...item, company: 'F-ADA and 7 more jobs' }).length, 0);
  const greenhouseQueries = buildDiscoveryQueries({
    ...item,
    company: 'Example Cloud',
    applyUrl: 'https://job-boards.greenhouse.io/examplecloud/jobs/123',
  });
  assert.equal(greenhouseQueries.length, 8);
  assert.equal(greenhouseQueries.some((query) => query.includes('greenhouse.io')), false);
});

test('confirmed application research can proceed without a surviving posting URL', () => {
  const urlLessItem = {
    company: 'Example AI',
    title: 'Backend AI Engineer',
  };
  assert.equal(isDiscoverableApplication(urlLessItem), false);
  assert.equal(isDiscoverableApplication(urlLessItem, { allowMissingPostingUrl: true }), true);
  const queries = buildDiscoveryQueries(urlLessItem, { allowMissingPostingUrl: true });
  assert.equal(queries.length, 8);
  assert.ok(queries.some((query) => query.includes('site:linkedin.com/in')));
  assert.ok(queries.some((query) => query.includes('site:x.com')));
  assert.ok(queries.some((query) => query.includes('site:twitter.com')));
  assert.equal(buildDiscoveryQueries({
    ...urlLessItem,
    company: 'Example AI and 3 more jobs',
  }, { allowMissingPostingUrl: true }).length, 0);
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

test('any current employee is eligible even when their title is not role-specific', () => {
  const contacts = extractPublicContacts([{
    url: 'https://www.linkedin.com/in/avery-example',
    title: 'Avery Example - Financial Analyst - Example AI | LinkedIn',
    description: 'Financial Analyst at Example AI',
  }], item);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, 'Avery Example');
  assert.equal(contacts[0].title, 'Financial Analyst at Example AI');
  assert.equal(contacts[0].roleRelevance, 'company');
  assert.equal(contacts[0].routingContact, true);
  assert.equal(rankContacts(contacts, item).length, 1);
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

test('X and Twitter profiles require current-employer evidence and remain manual-only', () => {
  const contacts = extractPublicContacts([{
    url: 'https://x.com/taylorexample/status/123',
    title: 'Taylor Example (@taylorexample) / X',
    description: 'Engineering Manager at Example AI',
  }, {
    url: 'https://twitter.com/formerexample',
    title: 'Former Example (@formerexample) / X',
    description: 'Former Engineering Manager at Example AI; now elsewhere.',
  }], item);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, 'Taylor Example');
  assert.equal(contacts[0].emailVerified, false);
  assert.equal(contacts[0].profileUrl, null);
  assert.equal(contacts[0].xHandle, '@taylorexample');
  assert.equal(contacts[0].xProfileUrl, 'https://x.com/taylorexample');
});

test('candidate X verification searches exact names and verifies current-employer profiles', async () => {
  const candidate = {
    name: 'Taylor Example',
    title: 'Engineering Manager',
    company: 'Example AI',
    profileUrl: 'https://www.linkedin.com/in/taylor-example',
  };
  assert.deepEqual(buildCandidateXVerificationQueries(candidate, item), [
    'site:x.com "Taylor Example" "Example AI"',
    'site:twitter.com "Taylor Example" "Example AI"',
    'site:x.com "Taylor Example"',
    'site:twitter.com "Taylor Example"',
  ]);
  const calls = [];
  const result = await verifyPublicCandidateXProfiles([candidate], item, {
    searchFn: async (query) => {
      calls.push(query);
      return [{
        url: 'https://x.com/taylorexample',
        title: 'Taylor Example (@taylorexample) / X',
        description: 'Engineering Manager at Example AI',
      }];
    },
    env: {},
  });
  assert.equal(calls.length, 1);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].xHandle, '@taylorexample');
  assert.equal(result.verifications[0].status, 'verified-current-employer-x-profile');
});

test('candidate X verification accepts an exact-name profile without employer text when employment is proven separately', async () => {
  const candidate = {
    name: 'Avery Example',
    title: 'Financial Analyst at Example AI',
    company: 'Example AI',
    profileUrl: 'https://www.linkedin.com/in/avery-example',
    sourceUrl: 'https://www.linkedin.com/in/avery-example',
    roleRelevance: 'company',
    routingContact: true,
  };
  const result = await verifyPublicCandidateXProfiles([candidate], item, {
    searchFn: async () => [{
      url: 'https://x.com/averyexample',
      title: 'Avery Example (@averyexample) / X',
      description: 'Data, cycling, and coffee.',
    }],
    env: {},
  });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].xHandle, '@averyexample');
  assert.equal(result.contacts[0].employmentEvidenceUrl, candidate.sourceUrl);
  assert.equal(result.contacts[0].routingContact, true);
});

test('candidate X verification rejects a different displayed person even when employment is proven', async () => {
  const result = await verifyPublicCandidateXProfiles([{
    name: 'Avery Example',
    title: 'Financial Analyst at Example AI',
    company: 'Example AI',
    sourceUrl: 'https://www.linkedin.com/in/avery-example',
  }], item, {
    searchFn: async () => [{
      url: 'https://x.com/notavery',
      title: 'Jordan Example (@notavery) / X',
      description: 'Software and startups.',
    }],
    env: {},
  });
  assert.equal(result.contacts.length, 0);
  assert.equal(result.verifications[0].status, 'not_observed');
});

test('candidate X verification accepts one handle cross-linked by an exact-name current-employer page', async () => {
  const candidate = {
    name: 'Taylor Example',
    title: 'Engineering Manager',
    company: 'Example AI',
    profileUrl: 'https://www.linkedin.com/in/taylor-example',
  };
  const result = await verifyPublicCandidateXProfiles([candidate], item, {
    searchFn: async () => [{
      url: 'https://taylorexample.dev/about',
      title: 'Taylor Example',
      description: 'Taylor Example is an Engineering Manager at Example AI. Follow https://x.com/taylorexample.',
    }],
    env: {},
  });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].xProfileUrl, 'https://x.com/taylorexample');
  assert.deepEqual(result.contacts[0].evidenceUrls, [
    'https://taylorexample.dev/about',
    'https://x.com/taylorexample',
  ]);
});

test('candidate X verification rejects ambiguous cross-linked handles', async () => {
  const result = await verifyPublicCandidateXProfiles([{
    name: 'Taylor Example',
    title: 'Engineering Manager',
    company: 'Example AI',
  }], item, {
    searchFn: async () => [{
      url: 'https://example.ai/team/taylor',
      title: 'Taylor Example | Engineering Manager | Example AI',
      description: 'Taylor Example links https://x.com/taylorexample and https://x.com/exampleai.',
    }],
    env: {},
  });
  assert.equal(result.contacts.length, 0);
  assert.equal(result.verifications[0].status, 'not_observed');
});

test('discovery merges LinkedIn and X evidence for the same current employee', () => {
  const contacts = extractPublicContacts([{
    url: 'https://www.linkedin.com/in/taylor-example',
    title: 'Taylor Example - Engineering Manager - Example AI | LinkedIn',
    description: 'Engineering Manager at Example AI',
  }, {
    url: 'https://x.com/taylorexample',
    title: 'Taylor Example (@taylorexample) / X',
    description: 'Engineering Manager at Example AI',
  }], item);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].profileUrl, 'https://www.linkedin.com/in/taylor-example');
  assert.equal(contacts[0].xProfileUrl, 'https://x.com/taylorexample');
  assert.equal(contacts[0].evidenceUrls.length, 2);
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
  assert.equal(calls.filter((url) => url.endsWith('/v2/search')).length, 13);
  assert.equal(calls.filter((url) => url.endsWith('/v2/scrape')).length, 13);
});

test('provider exhaustion pauses public discovery after one request and shares the circuit across roles', async () => {
  const sourceState = {};
  let calls = 0;
  const options = {
    sourceState,
    env: { FIRECRAWL_API_KEY: 'test-key', FIRECRAWL_API_URL: 'https://203.0.113.10' },
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify({ success: false }), { status: 402 });
    },
  };

  const first = await discoverContactsForApplication(item, options);
  assert.equal(first.status, 'unavailable');
  assert.match(first.reason, /credits are exhausted/i);
  assert.equal(first.errors.length, 1);
  assert.equal(calls, 1);
  assert.match(sourceState.publicSearchUnavailableReason, /credits are exhausted/i);

  const second = await discoverContactsForApplication({ ...item, title: 'Platform Engineer' }, options);
  assert.equal(second.status, 'unavailable');
  assert.match(second.reason, /credits are exhausted/i);
  assert.equal(second.errors.length, 0);
  assert.equal(calls, 1, 'the shared provider circuit must prevent per-role retries');
});

test('public search failures distinguish provider outages from ordinary errors', () => {
  assert.match(classifyPublicSearchFailure(new Error('Firecrawl /v2/search failed: 429'))?.reason || '', /rate limited/i);
  assert.match(classifyPublicSearchFailure(new Error('Firecrawl /v2/search failed: 502'))?.reason || '', /temporarily unavailable/i);
  assert.match(classifyPublicSearchFailure(new TypeError('fetch failed'))?.reason || '', /could not reach/i);
  assert.match(classifyPublicSearchFailure(new Error('request ETIMEDOUT'))?.reason || '', /could not reach/i);
  assert.equal(classifyPublicSearchFailure(new Error('unexpected parser failure')), null);
});

test('ordinary search errors never collapse into a no-contacts result', async () => {
  const result = await discoverContactsForApplication(item, {
    env: { FIRECRAWL_API_KEY: 'test-key', FIRECRAWL_API_URL: 'https://203.0.113.10' },
    fetchFn: async () => { throw new Error('unexpected parser failure'); },
  });

  assert.equal(result.status, 'error');
  assert.match(result.reason, /failed before producing reliable evidence/i);
  assert.equal(result.errors.length > 0, true);
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
  assert.equal(searchQueries.length, 14);
  assert.equal(result.candidateXVerification[0].status, 'not_observed');
});

test('live discovery infers a convention and marks hypotheses sendable when configured', async () => {
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
  assert.equal(result.emailHypotheses[0].sendable, true);
  assert.equal(result.emailVerification[0].status, 'not_observed');
});
