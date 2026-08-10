import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateLinkedInIdentity,
  applyHealthResult,
  checkHealthUrl,
  healthCircuitDecision,
  isLinkedInHealthUrl,
  isRestrictedHealthUrl,
  linkedinCompaniesMatch,
  selectHealthTargets,
} from '../queue-health.mjs';

test('health target selection includes LinkedIn alerts while skipping restricted alert sources', () => {
  const state = {
    items: [
      { id: 'old', company: 'Old Co', title: 'Backend Engineer', status: 'in_review', liveness: 'uncertain', postedAt: '2026-06-01', applyUrl: 'https://jobs.ashbyhq.com/old/1' },
      { id: 'duplicate', company: 'Old Co', title: 'Backend Engineer', status: 'in_review', liveness: 'uncertain', postedAt: '2026-06-02', applyUrl: 'https://jobs.ashbyhq.com/old/1' },
      { id: 'linkedin', company: 'Alert Co', title: 'Software Engineer', status: 'in_review', liveness: 'source-alert', applyUrl: 'https://www.linkedin.com/comm/jobs/view/4430806173' },
      { id: 'teamwork', company: 'Sports Co', title: 'Software Engineer', status: 'in_review', liveness: 'source-alert', applyUrl: 'https://www.teamworkonline.com/jobs/123' },
      { id: 'applied', company: 'Applied Co', title: 'Software Engineer', status: 'applied', liveness: 'active', applyUrl: 'https://jobs.ashbyhq.com/applied/1' },
    ],
  };
  const result = selectHealthTargets(state, { limit: 10 });
  assert.equal(result.targets.length, 2);
  assert.deepEqual(result.targets[0].items.map((item) => item.id), ['old', 'duplicate']);
  assert.deepEqual(result.targets[1].items.map((item) => item.id), ['linkedin']);
  assert.deepEqual(result.skippedRestricted.map((item) => item.id), ['teamwork']);
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

test('health target selection can isolate LinkedIn for a focused queue sweep', () => {
  const state = {
    items: [
      { id: 'linkedin', status: 'in_review', applyUrl: 'https://www.linkedin.com/jobs/view/backend-engineer-4430806173' },
      { id: 'ashby', status: 'in_review', applyUrl: 'https://jobs.ashbyhq.com/example/123' },
      { id: 'teamwork', status: 'in_review', applyUrl: 'https://www.teamworkonline.com/jobs/123' },
    ],
  };
  const result = selectHealthTargets(state, { all: true, linkedinOnly: true });
  assert.deepEqual(result.targets.map((target) => target.items[0].id), ['linkedin']);
  assert.equal(result.skippedRestricted.length, 0);
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

test('LinkedIn employer mismatches stale the queue identity without calling the URL expired', () => {
  assert.equal(linkedinCompaniesMatch('OpenAI: up to $325K/year', 'OpenAI'), true);
  assert.equal(linkedinCompaniesMatch('Revolut', 'Bark.com'), false);

  const state = {
    items: [
      {
        id: 'misbound',
        company: 'Revolut',
        title: 'Platform Engineer (Java)',
        status: 'in_review',
        liveness: 'source-alert',
        selectedForToday: true,
        queueRank: 1,
      },
    ],
  };
  const target = { url: 'https://www.linkedin.com/jobs/view/4421170285', items: [state.items[0]] };
  const annotated = annotateLinkedInIdentity(target, {
    result: 'active',
    method: 'linkedin-guest',
    code: 'linkedin_guest_active',
    reason: 'public LinkedIn guest posting is present',
    observedTitle: 'Backend Engineer',
    observedCompany: 'Bark.com',
  });
  assert.equal(annotated.result, 'uncertain');
  assert.equal(annotated.code, 'linkedin_identity_mismatch');
  assert.deepEqual(annotated.identityMismatchIds, ['misbound']);

  applyHealthResult(state, target, annotated, '2026-07-30T02:30:00.000Z');
  assert.equal(state.items[0].status, 'stale');
  assert.equal(state.items[0].liveness, 'uncertain');
  assert.equal(state.items[0].livenessCheck.code, 'linkedin_identity_mismatch');
  assert.deepEqual(state.items[0].livenessCheck.observed, {
    title: 'Backend Engineer',
    company: 'Bark.com',
    location: '',
  });
  assert.equal(state.items[0].selectedForToday, false);
});

test('health checks prefer ATS API and never crawl restricted sources', async () => {
  assert.equal(isLinkedInHealthUrl('https://www.linkedin.com/comm/jobs/view/4430806173'), true);
  assert.equal(isRestrictedHealthUrl('https://www.linkedin.com/comm/jobs/view/4430806173'), false);
  assert.equal(isRestrictedHealthUrl('https://www.teamworkonline.com/jobs/123'), true);
  const apiResult = await checkHealthUrl('https://jobs.ashbyhq.com/example/123', {
    apiChecker: async () => ({ result: 'expired', code: 'ashby_api_unlisted', reason: 'unlisted' }),
    publicChecker: async () => { throw new Error('HTTP fallback should not run after API result'); },
  });
  assert.deepEqual(apiResult, { result: 'expired', method: 'ats-api', code: 'ashby_api_unlisted', reason: 'unlisted' });

  const restricted = await checkHealthUrl('https://www.teamworkonline.com/jobs/123', {
    apiChecker: async () => { throw new Error('restricted URL should not be checked'); },
    publicChecker: async () => { throw new Error('restricted URL should not be checked'); },
  });
  assert.equal(restricted.code, 'restricted_source');
  assert.equal(restricted.result, 'uncertain');
});

test('LinkedIn guest checks distinguish active, removed, and blocked postings', async () => {
  const url = 'https://www.linkedin.com/comm/jobs/view/4430806173';
  const never = async () => { throw new Error('LinkedIn must not fall through to ATS or generic HTTP checks'); };

  const active = await checkHealthUrl(url, {
    linkedinChecker: async () => ({
      ok: true,
      liveness: 'active',
      fields: { title: 'Backend Engineer', company: 'Acme Corp', location: 'New York, NY', description: 'Build APIs.' },
    }),
    apiChecker: never,
    publicChecker: never,
  });
  assert.deepEqual(active, {
    result: 'active',
    method: 'linkedin-guest',
    code: 'linkedin_guest_active',
    reason: 'public LinkedIn guest posting is present',
    observedTitle: 'Backend Engineer',
    observedCompany: 'Acme Corp',
    observedLocation: 'New York, NY',
  });

  const expired = await checkHealthUrl(url, {
    linkedinChecker: async () => ({ ok: false, outcome: 'expired', reason: 'guest endpoint 404 — posting removed' }),
    apiChecker: never,
    publicChecker: never,
  });
  assert.deepEqual(expired, {
    result: 'expired',
    method: 'linkedin-guest',
    code: 'linkedin_guest_gone',
    reason: 'guest endpoint 404 — posting removed',
  });

  const blocked = await checkHealthUrl(url, {
    linkedinChecker: async () => ({ ok: false, outcome: 'blocked', reason: 'guest endpoint 429 — throttled' }),
    apiChecker: never,
    publicChecker: never,
  });
  assert.deepEqual(blocked, {
    result: 'uncertain',
    method: 'linkedin-guest',
    code: 'linkedin_guest_blocked',
    reason: 'guest endpoint 429 — throttled',
  });
});

test('LinkedIn ambiguity falls back to the canonical posting in Playwright', async () => {
  const url = 'https://www.linkedin.com/comm/jobs/view/4430806173?tracking=alert';
  let checkedUrl = '';
  const result = await checkHealthUrl(url, {
    linkedinChecker: async () => ({
      ok: false,
      outcome: 'blocked',
      reason: 'guest endpoint 429 — throttled',
    }),
    allowBrowser: true,
    getBrowserTools: async () => ({ page: /** @type {any} */ ({}) }),
    browserChecker: async (_page, browserUrl) => {
      checkedUrl = browserUrl;
      return {
        result: 'expired',
        code: 'expired_body',
        reason: 'pattern matched: no longer accepting applications',
      };
    },
  });
  assert.equal(checkedUrl, 'https://www.linkedin.com/jobs/view/4430806173');
  assert.deepEqual(result, {
    result: 'expired',
    method: 'playwright-linkedin',
    code: 'expired_body',
    reason: 'guest check blocked; browser: pattern matched: no longer accepting applications',
  });
});

test('the LinkedIn circuit breaker stops on throttling or repeated source failures', () => {
  const blocked = healthCircuitDecision({
    result: 'uncertain',
    method: 'linkedin-guest',
    code: 'linkedin_guest_blocked',
    reason: 'guest endpoint 429',
  });
  assert.equal(blocked.stop, true);

  const first = healthCircuitDecision({
    result: 'uncertain',
    method: 'linkedin-guest',
    code: 'linkedin_guest_error',
    reason: 'fetch failed',
  });
  const second = healthCircuitDecision({
    result: 'uncertain',
    method: 'linkedin-guest',
    code: 'linkedin_guest_empty',
    reason: 'description too short',
  }, first.consecutiveSourceFailures);
  const third = healthCircuitDecision({
    result: 'uncertain',
    method: 'linkedin-guest',
    code: 'linkedin_guest_error',
    reason: 'fetch failed',
  }, second.consecutiveSourceFailures);
  assert.equal(first.stop, false);
  assert.equal(second.stop, false);
  assert.equal(third.stop, true);

  const recovered = healthCircuitDecision({
    result: 'active',
    method: 'linkedin-guest',
    code: 'linkedin_guest_active',
    reason: 'posting present',
  }, second.consecutiveSourceFailures);
  assert.equal(recovered.stop, false);
  assert.equal(recovered.consecutiveSourceFailures, 0);
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
