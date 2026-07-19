import test from 'node:test';
import assert from 'node:assert/strict';

import { adapterForUrl, parseAdapterResult, queueApplicationGate } from '../application-queue.mjs';
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
