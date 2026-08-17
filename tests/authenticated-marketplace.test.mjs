import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTHENTICATED_MARKETPLACE_SOURCE_IDS,
  canonicalMarketplaceUrl,
  normalizeMarketplaceJob,
} from '../authenticated-marketplace-lib.mjs';
import {
  collectMarketplaceCandidates,
  pageLooksAuthenticated,
  parseOpenCliOutput,
} from '../marketplace.mjs';
import wellfound from '../plugins/wellfound/index.mjs';
import contra from '../plugins/contra/index.mjs';
import braintrust from '../plugins/braintrust/index.mjs';

test('authenticated marketplace contract covers all four sources and canonicalizes detail URLs', () => {
  assert.deepEqual(AUTHENTICATED_MARKETPLACE_SOURCE_IDS, ['handshake', 'wellfound', 'contra', 'braintrust']);
  assert.equal(
    canonicalMarketplaceUrl('wellfound', 'https://wellfound.com/jobs/senior-ai-engineer-at-acme?source=feed#details'),
    'https://wellfound.com/jobs/senior-ai-engineer-at-acme',
  );
  assert.equal(
    canonicalMarketplaceUrl('contra', 'https://contra.com/projects/abc-123/'),
    'https://contra.com/projects/abc-123',
  );
  assert.equal(
    canonicalMarketplaceUrl('braintrust', 'https://app.usebraintrust.com/talent/opportunities/abc-123'),
    'https://app.usebraintrust.com/talent/opportunities/abc-123',
  );
  assert.equal(canonicalMarketplaceUrl('wellfound', 'https://example.com/jobs/123'), '');
});

test('complete authenticated detail records are active and explicitly read-only', () => {
  const job = normalizeMarketplaceJob({
    url: 'https://app.usebraintrust.com/jobs/abc-123',
    title: 'Senior AI Product Engineer',
    company: 'Example Labs',
    location: 'Remote - United States',
    description: 'Own the product and engineering loop for an applied AI platform. '.repeat(4),
    compensation: { min: 120, max: 160, currency: 'USD', unit: 'hour' },
    jobType: 'Contract',
    commitment: '20 hours per week',
    applyAvailable: true,
  }, { source: 'braintrust', authenticated: true, observedAt: '2026-08-12T12:00:00.000Z' });

  assert.equal(job?.liveness, 'active');
  assert.equal(job?.fitConfidence, 'high');
  assert.equal(job?.sourceEvidence?.method, 'authenticated-chrome-dom-read');
  assert.equal(job?.sourceEvidence?.readOnly, true);
  assert.equal(job?.readOnlyActions?.apply, false);
  assert.equal(job?.marketplace?.compensation, '120 - 160 - USD - hour');
});

test('feed-only or incomplete cards stay source-alert', () => {
  const job = normalizeMarketplaceJob({
    url: 'https://wellfound.com/jobs/ai-operator-at-example',
    title: 'AI Operator',
    company: 'Example Labs',
    cardText: 'AI Operator at Example Labs',
    applyAvailable: false,
  }, { source: 'wellfound', authenticated: true });
  assert.equal(job?.liveness, 'source-alert');
  assert.match(job?.warnings?.join(' '), /description|Apply/i);
});

test('browser extraction helpers reject unauthenticated pages and dedupe candidates', () => {
  assert.equal(pageLooksAuthenticated({ hasLoginControl: true, hasAuthenticatedNav: false }), false);
  assert.equal(pageLooksAuthenticated({ hasLoginControl: false, hasAuthenticatedNav: true }), true);
  const candidates = collectMarketplaceCandidates('contra', [
    { url: 'https://contra.com/jobs/abc?ref=one', title: 'A' },
    { url: 'https://contra.com/jobs/abc?ref=two', title: 'A duplicate' },
    { url: 'https://example.com/jobs/nope', title: 'Wrong host' },
  ], 10);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, 'https://contra.com/jobs/abc');
  assert.deepEqual(parseOpenCliOutput('notice\n{"tabs":[{"id":"1","url":"https://contra.com/jobs"}]}'), {
    tabs: [{ id: '1', url: 'https://contra.com/jobs' }],
  });
  assert.deepEqual(parseOpenCliOutput('Waited 6s'), { message: 'Waited 6s' });
});

test('marketplace ingest plugins read normalized caches and do not require browser access', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-marketplace-'));
  const records = {
    wellfound: { url: 'https://wellfound.com/jobs/ai-operator-at-example' },
    contra: { url: 'https://contra.com/jobs/ai-operator-example' },
    braintrust: { url: 'https://app.usebraintrust.com/jobs/ai-operator-example' },
  };
  const plugins = { wellfound, contra, braintrust };
  for (const [source, plugin] of Object.entries(plugins)) {
    const cache = path.join(dir, `${source}.json`);
    const status = path.join(dir, `${source}-status.json`);
    writeFileSync(cache, JSON.stringify({ jobs: [{
      ...records[source],
      title: 'AI Operator',
      company: 'Example Labs',
      description: 'Work across product, research, and delivery for an applied AI system. '.repeat(3),
      applyAvailable: true,
    }] }));
    writeFileSync(status, JSON.stringify({ ok: true, authenticated: true }));
    const logs = [];
    const jobs = await plugin.ingest({
      settings: { cache_file: cache, status_file: status },
      dryRun: true,
      log: (message) => logs.push(message),
    });
    assert.equal(jobs.length, 1, source);
    assert.equal(jobs[0].source, source);
    assert.equal(jobs[0].liveness, 'active');
    assert.match(logs[0], /cached opportunity/i);
    assert.ok(readFileSync(cache, 'utf8').includes('Example Labs'));
  }
});
