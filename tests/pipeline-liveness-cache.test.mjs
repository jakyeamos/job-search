import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  clearBrowserFallback,
  getCachedBrowserFallback,
  listCachedBrowserFallbacks,
  recordBrowserFallback,
} from '../pipeline-liveness-cache.mjs';

function fixtureRoot() {
  return mkdtempSync(path.join(tmpdir(), 'career-ops-liveness-cache-'));
}

test('browser fallback cache is host-scoped, provisional, and reusable within its TTL', () => {
  const root = fixtureRoot();
  const now = Date.parse('2026-07-29T00:00:00.000Z');
  recordBrowserFallback('https://job-boards.greenhouse.io/acme/jobs/123', {
    root,
    reason: 'Greenhouse blocked by active browser safety policy',
    now,
  });

  const cached = getCachedBrowserFallback('https://job-boards.greenhouse.io/other/jobs/456', { root, now: now + 1_000 });
  assert.equal(cached?.host, 'job-boards.greenhouse.io');
  assert.equal(cached?.verification, 'unconfirmed');
  assert.equal(cached?.scope, 'batch-fallback-only');
  assert.equal(listCachedBrowserFallbacks({ root, now }).length, 1);
});

test('expired observations do not suppress a fresh browser attempt', () => {
  const root = fixtureRoot();
  const now = Date.parse('2026-07-29T00:00:00.000Z');
  recordBrowserFallback('https://apply.workable.com/acme/jobs/view/abc', {
    root,
    reason: 'Workable browser surface unavailable',
    now,
    ttlMs: 1_000,
  });
  assert.equal(getCachedBrowserFallback('https://apply.workable.com/acme/jobs/view/abc', { root, now: now + 1_001 }), null);
  assert.equal(listCachedBrowserFallbacks({ root, now: now + 1_001 }).length, 0);
});

test('cache can be explicitly cleared and invalid values are rejected', () => {
  const root = fixtureRoot();
  const url = 'https://boards.greenhouse.io/acme/jobs/123';
  recordBrowserFallback(url, { root, reason: 'policy block' });
  assert.equal(clearBrowserFallback(url, { root }), true);
  assert.equal(clearBrowserFallback(url, { root }), false);
  assert.equal(existsSync(path.join(root, 'data', 'cache', 'pipeline-liveness')), true);
  assert.throws(() => recordBrowserFallback(url, { root, reason: 'x', kind: 'active' }), /Unsupported fallback cache kind/);
});
