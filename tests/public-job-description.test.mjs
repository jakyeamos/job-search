import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAtsDescription,
  fetchAtsJobDescription,
  normalizePublicDescription,
} from '../apply/public-job-description.mjs';

const LONG_DESCRIPTION = 'Build reliable Python and TypeScript services for a production platform. Work with product and engineering partners to ship tested APIs, data workflows, observability, and applied AI capabilities.';

test('normalizes public HTML without retaining scripts or markup', () => {
  assert.equal(
    normalizePublicDescription('<p>Build &amp; ship</p><script>secret()</script><p>tested systems.</p>'),
    'Build & ship tested systems.',
  );
});

test('extracts the public description fields for supported ATS response shapes', () => {
  assert.match(extractAtsDescription('greenhouse', { content: `<p>${LONG_DESCRIPTION}</p>` }), /Build reliable Python/);
  assert.match(extractAtsDescription('lever', { descriptionPlain: LONG_DESCRIPTION }), /production platform/);
  assert.match(extractAtsDescription('ashby', { jobs: [{ id: 'job-1', descriptionHtml: `<p>${LONG_DESCRIPTION}</p>` }] }, { jobId: 'job-1' }), /applied AI capabilities/);
  assert.equal(extractAtsDescription('greenhouse', { content: 'too short' }), '');
});

test('fetches only the fixed public ATS endpoint and returns provenance', async () => {
  const calls = [];
  const result = await fetchAtsJobDescription('https://jobs.lever.co/example/job-1', {
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      return { descriptionPlain: LONG_DESCRIPTION };
    },
  });
  assert.deepEqual(result, {
    ats: 'lever',
    endpoint: 'https://api.lever.co/v0/postings/example/job-1',
    description: LONG_DESCRIPTION,
  });
  assert.deepEqual(calls, [{
    url: 'https://api.lever.co/v0/postings/example/job-1',
    options: {
      timeoutMs: undefined,
      headers: { accept: 'application/json' },
      redirect: 'error',
    },
  }]);
  const ashbyCalls = [];
  const ashbyResult = await fetchAtsJobDescription('https://jobs.ashbyhq.com/example/job-1', {
    fetchJson: async (url, options) => {
      ashbyCalls.push({ url, options });
      return { jobs: [{ id: 'job-1', descriptionHtml: `<p>${LONG_DESCRIPTION}</p>` }] };
    },
  });
  assert.equal(ashbyResult?.ats, 'ashby');
  assert.equal(ashbyResult?.endpoint, 'https://api.ashbyhq.com/posting-api/job-board/example?includeCompensation=true');
  assert.equal(ashbyCalls[0].options.redirect, 'error');
  assert.equal(await fetchAtsJobDescription('https://example.com/jobs/1', { fetchJson: async () => ({}) }), null);
});
