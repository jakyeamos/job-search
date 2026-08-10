import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canFetchPosting,
  enrichCandidates,
  fetchPosting,
  fetchPostings,
  htmlToText,
  linkedinJobId,
  parseLinkedinPosting,
  resolveEmbeddedGreenhouse,
  resolvePostingBatchSource,
} from '../posting-fetch.mjs';

const LONG_BODY = 'We build payment systems in Python and Go. '.repeat(8);

function linkedinHtml(body = LONG_BODY) {
  return `
    <h2 class="top-card-layout__title">Backend Engineer</h2>
    <a class="topcard__org-name-link" href="#">Acme Corp</a>
    <span class="topcard__flavor topcard__flavor--bullet">New York, NY</span>
    <div class="show-more-less-html__markup">${body}</div>
    <h3 class="description__job-criteria-subheader">Seniority level</h3>
    <span class="description__job-criteria-text">Mid-Senior level</span>
  `;
}

/** Minimal stand-in for a fetch Response. */
function response(status, { text = '', json = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => json,
  };
}

test('LinkedIn job ids are extracted from alert, canonical, and query URL shapes', () => {
  assert.equal(linkedinJobId('https://www.linkedin.com/comm/jobs/view/4430806173'), '4430806173');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/view/backend-engineer-at-acme-4430806173'), '4430806173');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/search?currentJobId=4430806173'), '4430806173');
});

test('LinkedIn job id extraction rejects other hosts and lookalike domains', () => {
  assert.equal(linkedinJobId('https://notlinkedin.com/comm/jobs/view/4430806173'), null);
  assert.equal(linkedinJobId('https://linkedin.com.evil.test/jobs/view/4430806173'), null);
  assert.equal(linkedinJobId('https://jobs.lever.co/acme/abc'), null);
  assert.equal(linkedinJobId('not a url'), null);
});

test('posting HTML is flattened to text with entities and list markers resolved', () => {
  const text = htmlToText('<p>Build&nbsp;APIs</p><ul><li>Python &amp; Go</li><li>3+ years</li></ul>');
  assert.equal(text, 'Build APIs\n- Python & Go\n- 3+ years');
});

test('LinkedIn posting parse appends job criteria so blocker rules can see seniority', () => {
  const parsed = parseLinkedinPosting(linkedinHtml('We build <b>payment</b> systems.'));
  assert.equal(parsed.title, 'Backend Engineer');
  assert.equal(parsed.company, 'Acme Corp');
  assert.equal(parsed.location, 'New York, NY');
  assert.match(parsed.description, /We build payment systems\./);
  assert.match(parsed.description, /Seniority level: Mid-Senior level/);
});

test('embedded Greenhouse boards are resolved from gh_jid on a company domain', () => {
  const resolved = resolveEmbeddedGreenhouse('https://nuro.ai/careersitem?gh_jid=7896063');
  assert.equal(resolved.ats, 'greenhouse');
  assert.equal(resolved.apiUrl, 'https://boards-api.greenhouse.io/v1/boards/nuro/jobs/7896063');
  // The board name is a guess, so callers must not read a 404 as a dead posting.
  assert.equal(resolved.guessedBoard, true);
});

test('embedded Greenhouse resolution rejects non-https and missing or malformed gh_jid', () => {
  assert.equal(resolveEmbeddedGreenhouse('http://nuro.ai/careersitem?gh_jid=7896063'), null);
  assert.equal(resolveEmbeddedGreenhouse('https://nuro.ai/careersitem'), null);
  assert.equal(resolveEmbeddedGreenhouse('https://nuro.ai/careersitem?gh_jid=../../etc'), null);
});

test('fetchability is decided by whether a public description source exists', () => {
  assert.equal(canFetchPosting('https://www.linkedin.com/comm/jobs/view/4430806173'), true);
  assert.equal(canFetchPosting('https://nuro.ai/careersitem?gh_jid=7896063'), true);
  // Glassdoor serves 403 to every non-browser client, so there is nothing to fetch.
  assert.equal(canFetchPosting('https://www.glassdoor.com/job-listing/abc'), false);
  assert.equal(canFetchPosting(''), false);
});

test('batch sources group ATS postings by organization instead of job URL', () => {
  const greenhouseA = resolvePostingBatchSource('https://job-boards.greenhouse.io/acme/jobs/12345');
  const greenhouseB = resolvePostingBatchSource('https://job-boards.greenhouse.io/acme/jobs/67890');
  const lever = resolvePostingBatchSource('https://jobs.lever.co/example/abc-123');
  const ashby = resolvePostingBatchSource('https://jobs.ashbyhq.com/example/job-123');

  assert.equal(greenhouseA.key, greenhouseB.key);
  assert.match(greenhouseA.apiUrl, /\/boards\/acme\/jobs\?content=true$/);
  assert.equal(lever.key, 'lever:example');
  assert.equal(ashby.key, 'ashby:example');
});

test('batch fetching makes one Ashby board request for multiple postings', async () => {
  const urls = [
    'https://jobs.ashbyhq.com/acme/job-1',
    'https://jobs.ashbyhq.com/acme/job-2',
  ];
  const calls = [];
  const results = await fetchPostings(urls, {
    gapMs: 0,
    fetchFn: async (url) => {
      calls.push(url);
      return response(200, {
        json: {
          jobs: [
            { id: 'job-1', title: 'Backend Engineer', location: 'Remote US', descriptionHtml: LONG_BODY },
            { id: 'job-2', title: 'Data Engineer', location: 'New York, NY', descriptionHtml: LONG_BODY },
          ],
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].fields.title, 'Data Engineer');
});

test('batch fetching shares Greenhouse and Lever board payloads', async () => {
  const urls = [
    'https://job-boards.greenhouse.io/acme/jobs/12345',
    'https://job-boards.greenhouse.io/acme/jobs/67890',
    'https://jobs.lever.co/example/lever-1',
    'https://jobs.lever.co/example/lever-2',
  ];
  const calls = [];
  const results = await fetchPostings(urls, {
    gapMs: 0,
    fetchFn: async (url) => {
      calls.push(url);
      if (url.includes('greenhouse')) {
        return response(200, {
          json: {
            jobs: [
              { id: 12345, title: 'Software Engineer', location: { name: 'Remote US' }, content: LONG_BODY },
              { id: 67890, title: 'Data Engineer', location: { name: 'Buffalo, NY' }, content: LONG_BODY },
            ],
          },
        });
      }
      return response(200, {
        json: [
          { id: 'lever-1', text: 'Backend Engineer', categories: { location: 'Remote US' }, descriptionPlain: LONG_BODY },
          { id: 'lever-2', text: 'AI Engineer', categories: { location: 'New York, NY' }, descriptionPlain: LONG_BODY },
        ],
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(results.filter((result) => result.ok).length, 4);
});

test('a missing official board endpoint falls back to the per-job endpoint', async () => {
  const calls = [];
  const [result] = await fetchPostings([
    'https://job-boards.greenhouse.io/acme/jobs/12345',
  ], {
    gapMs: 0,
    fetchFn: async (url) => {
      calls.push(url);
      if (url.includes('?content=true')) return response(404);
      return response(200, {
        json: {
          id: 12345,
          title: 'Software Engineer',
          location: { name: 'Remote US' },
          content: LONG_BODY,
        },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.fields.title, 'Software Engineer');
});

test('an unfetchable host is reported as unsupported without a network call', async () => {
  const result = await fetchPosting('https://www.glassdoor.com/job-listing/abc', {
    fetchFn: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unsupported');
});

test('Handshake records never fall through to public posting fetch', async () => {
  const result = await fetchPosting('https://app.joinhandshake.com/jobs/11190664', {
    fetchFn: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unsupported');
  assert.match(result.reason, /authenticated Handshake browser/i);
});

test('a removed LinkedIn posting is expired, a throttled one is only blocked', async () => {
  const gone = await fetchPosting('https://www.linkedin.com/comm/jobs/view/4430806173', {
    fetchFn: async () => response(404),
  });
  assert.equal(gone.outcome, 'expired');

  const throttled = await fetchPosting('https://www.linkedin.com/comm/jobs/view/4430806173', {
    fetchFn: async () => response(429),
  });
  // Throttling says nothing about the posting; it must stay eligible for a retry.
  assert.equal(throttled.outcome, 'blocked');
});

test('a LinkedIn closure banner wins over a retained description', async () => {
  const closed = await fetchPosting('https://www.linkedin.com/comm/jobs/view/4430806173', {
    fetchFn: async () => response(200, {
      text: `<div>No longer accepting applications</div>${linkedinHtml()}`,
    }),
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.outcome, 'expired');
  assert.match(closed.reason, /no longer accepting applications/i);
});

test('an ambiguous LinkedIn response is not treated as a closed posting', async () => {
  const ambiguous = await fetchPosting('https://www.linkedin.com/comm/jobs/view/4430806173', {
    fetchFn: async () => response(200, { text: '<main>Please sign in to continue</main>' }),
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.outcome, 'empty');
});

test('enrichment replaces email-subject metadata with the real posting', async () => {
  const candidate = {
    canonicalUrl: 'https://www.linkedin.com/comm/jobs/view/4430806173',
    title: 'Data Analyst',
    company: 'F-ADA and 7 more jobs in New York, NY for you. Apply Now.',
    location: '',
    description: '',
  };

  const { candidates, outcomes } = await enrichCandidates([candidate], {
    gapMs: 0,
    fetchFn: async () => response(200, { text: linkedinHtml() }),
  });

  assert.equal(outcomes.updated, 1);
  assert.equal(candidates[0].company, 'Acme Corp');
  assert.equal(candidates[0].title, 'Backend Engineer');
  assert.equal(candidates[0].location, 'New York, NY');
  assert.match(candidates[0].description, /payment systems/);
  assert.equal(candidates[0].liveness, 'active');
  assert.ok(candidates[0].descriptionFetchedAt);
});

test('enrichment skips candidates that already have a description or no public source', async () => {
  const described = { canonicalUrl: 'https://www.linkedin.com/comm/jobs/view/4430806173', description: 'Already fetched.' };
  const unfetchable = { canonicalUrl: 'https://www.glassdoor.com/job-listing/abc', description: '' };

  const { candidates, outcomes } = await enrichCandidates([described, unfetchable], {
    gapMs: 0,
    fetchFn: async () => { throw new Error('must not be called'); },
  });

  assert.equal(outcomes.updated, 0);
  assert.equal(outcomes.skipped, 1, 'only the unfetchable one counts as skipped');
  assert.deepEqual(candidates, [described, unfetchable], 'untouched candidates pass through by identity');
});

test('a candidate whose posting is gone is marked expired so the queue drops it', async () => {
  const candidate = { canonicalUrl: 'https://www.linkedin.com/comm/jobs/view/4430806173', description: '' };
  const { candidates, outcomes } = await enrichCandidates([candidate], {
    gapMs: 0,
    fetchFn: async () => response(410),
  });
  assert.equal(outcomes.expired, 1);
  assert.equal(candidates[0].liveness, 'expired');
});

test('enrichment caps how many postings one run will fetch', async () => {
  const candidates = Array.from({ length: 5 }, (unused, index) => ({
    canonicalUrl: `https://www.linkedin.com/comm/jobs/view/44308061${index}0`,
    description: '',
  }));
  let calls = 0;

  const { outcomes } = await enrichCandidates(candidates, {
    limit: 2,
    gapMs: 0,
    fetchFn: async () => { calls += 1; return response(200, { text: linkedinHtml() }); },
  });

  assert.equal(calls, 2);
  assert.equal(outcomes.updated, 2);
  assert.equal(outcomes.skipped, 3);
});

test('the fetch budget goes to alert candidates before scanned ones', async () => {
  // Scanned candidates are deduped ahead of alerts, so without prioritisation they
  // would consume the whole limit and leave the blind-scored ones blind.
  const scanned = Array.from({ length: 3 }, (unused, index) => ({
    canonicalUrl: `https://www.linkedin.com/comm/jobs/view/11111${index}0`,
    description: '',
    liveness: 'active',
  }));
  const alert = {
    canonicalUrl: 'https://www.linkedin.com/comm/jobs/view/4430806173',
    description: '',
    liveness: 'source-alert',
  };
  const fetched = [];

  await enrichCandidates([...scanned, alert], {
    limit: 1,
    gapMs: 0,
    fetchFn: async (url) => { fetched.push(url); return response(200, { text: linkedinHtml() }); },
  });

  assert.deepEqual(fetched, ['https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4430806173']);
});

test('persisted alert candidates are fetched newest-first within the bounded budget', async () => {
  const alerts = Array.from({ length: 3 }, (unused, index) => ({
    canonicalUrl: `https://www.linkedin.com/comm/jobs/view/44308062${index}0`,
    description: '',
    liveness: 'source-alert',
  }));
  const fetched = [];

  await enrichCandidates(alerts, {
    limit: 2,
    gapMs: 0,
    fetchFn: async (url) => { fetched.push(url); return response(200, { text: linkedinHtml() }); },
  });

  assert.deepEqual(fetched, [
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4430806220',
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4430806210',
  ]);
});
