import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adapterCommand,
  adapterForUrl,
  parseAdapterResult,
  queueApplicationGate,
  selectClearItems,
  shouldRunPostApplicationOutreach,
} from '../application-queue.mjs';
import { DEFAULT_POLICY } from '../apply/application-policy.mjs';

test('queue maps supported ATS hosts and rejects unknown forms', () => {
  assert.equal(adapterForUrl('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse');
  assert.equal(adapterForUrl('https://jobs.ashbyhq.com/acme/1'), 'ashby');
  assert.equal(adapterForUrl('https://jobs.lever.co/acme/1'), 'lever');
  assert.equal(adapterForUrl('https://blossom.example/apply'), null);
});

test('queue gate requires an active high-fit posting', () => {
  const policy = { ...DEFAULT_POLICY, enabled: true, authorized: true };
  const item = { fitScore: 4.4, liveness: 'active' };
  assert.equal(queueApplicationGate(item, policy, 'greenhouse').ok, true);
  assert.equal(queueApplicationGate({ ...item, liveness: 'source-alert' }, policy, 'greenhouse').ok, false);
  assert.equal(queueApplicationGate(item, policy, null).ok, false);
});

test('worker consumes the adapter result marker', () => {
  const result = parseAdapterResult('log\nCAREER_OPS_APPLICATION_RESULT {"state":"submitted","reason":"confirmed"}\n');
  assert.deepEqual(result, { state: 'submitted', reason: 'confirmed' });
  assert.equal(parseAdapterResult('no marker'), null);
});

test('queue adapter commands are fill-only unless an explicit mode requests otherwise', () => {
  const command = adapterCommand(
    { id: 'q1', applyUrl: 'https://jobs.ashbyhq.com/acme/1', company: 'Acme', title: 'Engineer', location: 'London, UK', lane: 'engineering', description: 'Build things', fitScore: 4.5, liveness: 'active' },
    'ashby',
    { headless: true },
    { artifactPath: '/tmp/resume.pdf' },
  );
  assert.equal(command.includes('--submit'), false);
  assert.equal(command.includes('--headless'), true);
  assert.equal(command[command.indexOf('--job-location') + 1], 'London, UK');
});

test('queue withholds an unhumanized cover letter from the adapter', () => {
  const command = adapterCommand(
    { id: 'q2', applyUrl: 'https://jobs.ashbyhq.com/acme/2', company: 'Acme', title: 'Engineer', location: 'London, UK', lane: 'engineering', description: 'Build things', fitScore: 4.5, liveness: 'active' },
    'ashby',
    { headless: true },
    { artifactPath: '/tmp/resume.pdf' },
    {
      coverLetterPdf: '/tmp/unhumanized-cover.pdf',
      coverLetterText: '/tmp/unhumanized-cover.txt',
      manifestPath: '/tmp/missing-manifest.json',
      coverLetterReady: false,
    },
  );
  assert.equal(command.includes('--cover'), false);
  assert.equal(command.includes('--cover-text'), false);
});


test('post-application outreach only runs after confirmed non-dry-run submissions', () => {
  assert.equal(shouldRunPostApplicationOutreach(1, false), true);
  assert.equal(shouldRunPostApplicationOutreach(6, false), true);
  assert.equal(shouldRunPostApplicationOutreach(0, false), false);
  assert.equal(shouldRunPostApplicationOutreach(1, true), false);
});

test('clear selection keeps one active supported role per company', () => {
  const policy = { ...DEFAULT_POLICY, minFitScore: 4 };
  const state = {
    items: [
      { id: 'a1', company: 'Acme', title: 'Backend Engineer', status: 'ready', fitScore: 4.8, liveness: 'active', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' },
      { id: 'a2', company: 'Acme', title: 'Data Engineer', status: 'ready', fitScore: 4.7, liveness: 'active', applyUrl: 'https://boards.greenhouse.io/acme/jobs/2' },
      { id: 'b1', company: 'Beta', title: 'Applied AI Engineer', status: 'in_review', fitScore: 4.5, liveness: 'active', applyUrl: 'https://jobs.ashbyhq.com/beta/1' },
      { id: 'unsupported', company: 'Gamma', title: 'Software Engineer', status: 'ready', fitScore: 5, liveness: 'active', applyUrl: 'https://gamma.example/apply' },
      { id: 'old', company: 'Delta', title: 'Backend Engineer', status: 'ready', fitScore: 5, liveness: 'active', applicationState: 'submission_unknown', applyUrl: 'https://jobs.lever.co/delta/1' },
    ],
  };
  const selected = selectClearItems(state, policy, 6);
  assert.deepEqual(selected.map((item) => item.id), ['a1', 'b1']);
  assert.equal(state.items.find((item) => item.id === 'a1').queueRank, 1);
  assert.equal(state.items.find((item) => item.id === 'a2').selectedForToday, false);
  assert.equal(state.items.find((item) => item.id === 'old').selectedForToday, false);
});
