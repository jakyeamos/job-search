import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDSHAKE_SOURCE,
  normalizeHandshakeJob,
  normalizeHandshakeJobUrl,
  normalizeHandshakeJobs,
} from '../handshake-lib.mjs';
import { collectHandshakeCandidates, normalizeCreatedTab, normalizeTabRecords, parseOpenCliOutput } from '../handshake.mjs';
import { buildQueueItem, classifyMissionFit, normalizeUrl } from '../queue-lib.mjs';

const DETAIL = {
  url: 'https://app.joinhandshake.com/jobs/11190664?ref=feed',
  sourceUrl: 'https://app.joinhandshake.com/jobs/11190664?ref=feed',
  title: 'Associate Enterprise Systems Analyst',
  company: 'Momentum',
  location: 'Buffalo, NY',
  description: 'Build and support enterprise systems, improve data workflows, and collaborate with stakeholders. '.repeat(4),
  applyAvailable: true,
  applyLabel: 'Apply',
  authenticated: true,
};

test('Handshake URLs collapse host and tracking variants to numeric job identity', () => {
  const expected = 'https://app.joinhandshake.com/jobs/11190664';
  assert.equal(normalizeHandshakeJobUrl(DETAIL.url), expected);
  assert.equal(normalizeUrl('https://www.joinhandshake.com/jobs/11190664?utm_source=feed'), expected);
  assert.equal(normalizeHandshakeJobUrl('https://app.joinhandshake.com/job-search/11190664?ref=explore'), expected);
  assert.equal(normalizeHandshakeJobUrl('https://example.com/jobs/11190664'), '');
});

test('complete authenticated detail records are active and carry bounded provenance', () => {
  const job = normalizeHandshakeJob(DETAIL, { observedAt: '2026-08-07T12:00:00.000Z', authenticated: true });
  assert.equal(job.liveness, 'active');
  assert.equal(job.source, HANDSHAKE_SOURCE);
  assert.equal(job.sourceEvidence.method, 'authenticated-chrome-read');
  assert.equal(job.sourceEvidence.authenticated, true);
  assert.equal(job.sourceEvidence.verification, 'authenticated Handshake browser');
  assert.equal(job.canonicalUrl, 'https://app.joinhandshake.com/jobs/11190664');
  assert.equal(job.applyAvailable, true);
  assert.equal(job.applyLabel, 'Apply');
  const [roundTripped] = normalizeHandshakeJobs([job], { observedAt: '2026-08-07T12:00:00.000Z', authenticated: true });
  assert.equal(roundTripped.liveness, 'active');
  assert.equal(roundTripped.applyAvailable, true);
});

test('feed-only or incomplete records stay source-alert and cannot become ready evidence', () => {
  const [job] = normalizeHandshakeJobs([{
    url: 'https://app.joinhandshake.com/jobs/11190664',
    title: 'Associate Enterprise Systems Analyst',
    company: 'Momentum',
  }], { authenticated: true });
  assert.equal(job.liveness, 'source-alert');
  assert.match(job.warnings.join(' '), /description|Apply/i);
});

test('queue item preserves source evidence and computes mission fit separately from numeric fit', () => {
  const profile = {
    civic_mission: { enabled: true, issue_areas: ['civic education', 'electoral reform'] },
    target_roles: { primary: ['Software Engineer'] },
  };
  const candidate = normalizeHandshakeJob({
    ...DETAIL,
    title: 'Civic Data Software Engineer',
    description: 'Build civic education and electoral reform data systems. '.repeat(5),
  }, { authenticated: true });
  const item = buildQueueItem(candidate, profile, process.cwd());
  assert.equal(item.source, 'handshake');
  assert.equal(item.sourceEvidence.provider, 'handshake');
  assert.equal(item.missionFit.label, 'aligned');
  assert.equal(typeof item.missionFit.reason, 'string');
  assert.equal(item.fitScore, 4.7);
  assert.deepEqual(classifyMissionFit(candidate, profile).matches, ['civic education', 'electoral reform']);
});

test('OpenCLI tab envelopes normalize without retaining browser session data', () => {
  const tabs = normalizeTabRecords({ result: { tabs: [
    { targetId: 'tab-1', url: 'https://app.joinhandshake.com/feed', title: 'Feed | Handshake', cookies: ['must-not-copy'] },
    { page: 'page-2', url: 'https://app.joinhandshake.com/explore', title: 'Explore | Handshake' },
  ] } });
  assert.deepEqual(tabs, [
    { id: 'tab-1', url: 'https://app.joinhandshake.com/feed', title: 'Feed | Handshake' },
    { id: 'page-2', url: 'https://app.joinhandshake.com/explore', title: 'Explore | Handshake' },
  ]);
});

test('detail discovery candidates deduplicate tracking variants and respect the cap', () => {
  const candidates = collectHandshakeCandidates([
    { url: 'https://app.joinhandshake.com/job-search/11190664?ref=one', ariaLabel: 'first' },
    { url: 'https://app.joinhandshake.com/jobs/11190664?ref=two', ariaLabel: 'duplicate' },
    { url: 'https://app.joinhandshake.com/jobs/22222222?ref=three', ariaLabel: 'second' },
    { url: 'https://example.com/jobs/33333333', ariaLabel: 'external' },
  ], 2);
  assert.deepEqual(candidates.map((candidate) => candidate.url), [
    'https://app.joinhandshake.com/jobs/11190664',
    'https://app.joinhandshake.com/jobs/22222222',
  ]);
  assert.equal(candidates[0].sourceUrl, 'https://app.joinhandshake.com/job-search/11190664?ref=one');
});

test('OpenCLI tab creation envelopes expose only the page identity', () => {
  assert.equal(normalizeCreatedTab({ page: 'created-page', url: 'https://app.joinhandshake.com/jobs/11190664' }), 'created-page');
  assert.equal(normalizeCreatedTab({ result: { targetId: 'created-target' } }), 'created-target');
  assert.equal(normalizeCreatedTab({ url: 'https://app.joinhandshake.com/explore' }), '');
});

test('OpenCLI wait acknowledgements are accepted at the bridge boundary', () => {
  assert.deepEqual(parseOpenCliOutput('Waited 2s'), { message: 'Waited 2s' });
});
