import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHealthResult,
  checkHealthUrl,
  isRestrictedHealthUrl,
  selectHealthTargets,
} from '../queue-health.mjs';

test('health target selection deduplicates URLs and skips restricted alert sources', () => {
  const state = {
    items: [
      { id: 'old', company: 'Old Co', title: 'Backend Engineer', status: 'in_review', liveness: 'uncertain', postedAt: '2026-06-01', applyUrl: 'https://jobs.ashbyhq.com/old/1' },
      { id: 'duplicate', company: 'Old Co', title: 'Backend Engineer', status: 'in_review', liveness: 'uncertain', postedAt: '2026-06-02', applyUrl: 'https://jobs.ashbyhq.com/old/1' },
      { id: 'linkedin', company: 'Alert Co', title: 'Software Engineer', status: 'in_review', liveness: 'source-alert', applyUrl: 'https://www.linkedin.com/comm/jobs/view/123' },
      { id: 'applied', company: 'Applied Co', title: 'Software Engineer', status: 'applied', liveness: 'active', applyUrl: 'https://jobs.ashbyhq.com/applied/1' },
    ],
  };
  const result = selectHealthTargets(state, { limit: 10 });
  assert.equal(result.targets.length, 1);
  assert.deepEqual(result.targets[0].items.map((item) => item.id), ['old', 'duplicate']);
  assert.deepEqual(result.skippedRestricted.map((item) => item.id), ['linkedin']);
});

test('health target selection prioritizes unchecked and oldest roles', () => {
  const state = {
    items: [
      { id: 'checked', status: 'in_review', livenessCheckedAt: '2026-07-18T00:00:00Z', postedAt: '2026-07-01', applyUrl: 'https://jobs.lever.co/checked/1' },
      { id: 'unchecked', status: 'in_review', postedAt: '2026-07-10', applyUrl: 'https://jobs.lever.co/unchecked/1' },
      { id: 'oldest', status: 'in_review', postedAt: '2026-06-10', applyUrl: 'https://jobs.lever.co/oldest/1' },
    ],
  };
  const result = selectHealthTargets(state, { limit: 2 });
  assert.deepEqual(result.targets.map((target) => target.items[0].id), ['oldest', 'unchecked']);
});

test('health result marks only mutable expired roles stale and preserves applied history', () => {
  const state = {
    items: [
      { id: 'mutable', status: 'in_review', selectedForToday: true, queueRank: 1, liveness: 'uncertain', applyUrl: 'https://jobs.lever.co/example/1' },
      { id: 'applied', status: 'applied', selectedForToday: false, liveness: 'active', applyUrl: 'https://jobs.lever.co/example/1' },
    ],
  };
  const target = { url: 'https://jobs.lever.co/example/1', items: [state.items[0]] };
  const updated = applyHealthResult(state, target, {
    result: 'expired',
    method: 'ats-api',
    code: 'lever_api_gone',
    reason: 'posting removed',
  }, '2026-07-19T12:00:00.000Z');
  assert.equal(updated.length, 1);
  assert.equal(state.items[0].status, 'stale');
  assert.equal(state.items[0].selectedForToday, false);
  assert.equal(state.items[0].livenessCheck.code, 'lever_api_gone');
  assert.equal(state.items[1].status, 'applied');
  assert.equal(state.items[1].liveness, 'active');
});

test('health checks prefer ATS API and never crawl restricted sources', async () => {
  assert.equal(isRestrictedHealthUrl('https://www.linkedin.com/comm/jobs/view/123'), true);
  const apiResult = await checkHealthUrl('https://jobs.ashbyhq.com/example/123', {
    apiChecker: async () => ({ result: 'expired', code: 'ashby_api_unlisted', reason: 'unlisted' }),
    publicChecker: async () => { throw new Error('HTTP fallback should not run after API result'); },
  });
  assert.deepEqual(apiResult, { result: 'expired', method: 'ats-api', code: 'ashby_api_unlisted', reason: 'unlisted' });

  const restricted = await checkHealthUrl('https://www.linkedin.com/comm/jobs/view/123', {
    apiChecker: async () => { throw new Error('restricted URL should not be checked'); },
    publicChecker: async () => { throw new Error('restricted URL should not be checked'); },
  });
  assert.equal(restricted.code, 'restricted_source');
  assert.equal(restricted.result, 'uncertain');
});

test('health checks stay browserless when lightweight checks are inconclusive', async () => {
  const result = await checkHealthUrl('https://example.com/jobs/123', {
    apiChecker: async () => null,
    publicChecker: async () => 'uncertain',
    allowBrowser: false,
  });
  assert.equal(result.result, 'uncertain');
  assert.equal(result.method, 'http');
  assert.equal(result.code, 'inconclusive');
});
