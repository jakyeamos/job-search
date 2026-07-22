import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditCoachResponse,
  buildJackCoachPrompt,
  normalizeJackJob,
  normalizeJackJobs,
  normalizeJackJobUrl,
} from '../jackandjill-lib.mjs';
import plugin from '../plugins/jackandjill/index.mjs';
import { normalizeUrl } from '../queue-lib.mjs';
import { dedupCandidates } from '../queue.mjs';

const netic = JSON.parse(readFileSync(new URL('./fixtures/jackandjill/netic.json', import.meta.url), 'utf8'));
const lightfield = JSON.parse(readFileSync(new URL('./fixtures/jackandjill/lightfield.json', import.meta.url), 'utf8'));

test('Jack job URLs collapse direct, app, and Gmail tracking variants to one UUID identity', () => {
  const expected = 'https://app.jackandjill.ai/jobs/11111111-1111-4111-8111-111111111111/post';
  assert.equal(normalizeJackJobUrl(netic.job.url), expected);
  assert.equal(normalizeJackJobs({ record: netic.job }).length, 1);
  assert.equal(normalizeUrl('https://app.jackandjill.ai/jobs/11111111-1111-4111-8111-111111111111/post?source=email&campaign=jack_agent'), expected);
  assert.equal(normalizeJackJobUrl('https://example.com/jobs/11111111-1111-4111-8111-111111111111/post'), '');
});

test('complete Jack records are active while incomplete records remain source-alert', () => {
  const active = normalizeJackJob(netic.job);
  assert.equal(active.liveness, 'active');
  assert.equal(active.source, 'jackandjill');
  assert.equal(active.sourceLabel, 'Jack & Jill');

  const incomplete = normalizeJackJob({ ...netic.job, description: '', liveness: 'active' });
  assert.equal(incomplete.liveness, 'source-alert');
  assert.match(incomplete.warnings.join(' '), /description/i);
});

test('Gmail provenance survives enrichment into a direct Jack record', () => {
  const enriched = normalizeJackJob({
    ...netic.job,
    description: 'Complete job description',
    sourceMessageId: 'gmail-message-123',
    sourceUrl: 'https://app.jackandjill.ai/jobs/11111111-1111-4111-8111-111111111111/post?source=email',
  });
  assert.equal(enriched.sourceMessageId, 'gmail-message-123');
  assert.equal(enriched.sourceUrl.includes('source=email'), true);
});

test('queue dedup keeps Gmail message provenance when Jack enriches the same job', () => {
  const [merged] = dedupCandidates([
    {
      url: 'https://app.jackandjill.ai/jobs/11111111-1111-4111-8111-111111111111/post?source=email&campaign=jack_agent',
      sourceUrl: 'https://app.jackandjill.ai/jobs/11111111-1111-4111-8111-111111111111/post?source=email&campaign=jack_agent',
      source: 'gmail:review',
      sourceMessageId: 'gmail-message-456',
      liveness: 'source-alert',
      title: 'Software Engineer, Agent Platform',
    },
    {
      ...netic.job,
      url: 'https://www.jackandjill.ai/jobs/11111111-1111-4111-8111-111111111111',
      source: 'jackandjill',
      liveness: 'active',
    },
  ]);
  assert.equal(merged.url, 'https://app.jackandjill.ai/jobs/11111111-1111-4111-8111-111111111111/post');
  assert.equal(merged.source, 'jackandjill');
  assert.equal(merged.sourceMessageId, 'gmail-message-456');
  assert.match(merged.sourceUrl, /source=email/);
  assert.equal(merged.liveness, 'active');
});

test('coaching prompt contains the requested Netic and Lightfield structure', () => {
  for (const fixture of [netic, lightfield]) {
    const prompt = buildJackCoachPrompt({
      cv: fixture.resumeEvidence,
      digest: 'Verified proof points and published projects.',
      profile: 'target_roles: backend, applied AI',
      job: normalizeJackJob(fixture.job),
    });
    for (const signal of fixture.expectedAdviceSignals) {
      assert.match(prompt, new RegExp(signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
    assert.match(prompt, /Do not invent metrics, tools, dates, customers/i);
  }
});

test('evidence audit flags unsupported numeric claims instead of silently accepting them', () => {
  const audit = auditCoachResponse('This achieved 99% faster delivery in 2024.', ['The project shipped in 2023.']);
  assert.equal(audit.accepted, false);
  assert.deepEqual(audit.unsupportedClaims, ['99%', '2024']);
});

test('cache-backed plugin is read-only and returns normalized Jack records', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-jackandjill-'));
  const cache = path.join(dir, 'recommendations.json');
  writeFileSync(cache, JSON.stringify({ jobs: [netic.job, { ...lightfield.job, description: '' }] }));
  const logs = [];
  const jobs = await plugin.ingest({
    settings: { cache_file: cache },
    dryRun: true,
    log: (message) => logs.push(message),
  });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].liveness, 'active');
  assert.equal(jobs[1].liveness, 'source-alert');
  assert.match(logs[0], /2 cached recommendation/);
  assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')).jobs.length, 2);
});
