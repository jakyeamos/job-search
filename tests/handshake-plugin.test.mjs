import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin from '../plugins.local/handshake/index.mjs';

test('Handshake local plugin is cache-backed, read-only, and surfaces a blocked sync', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-handshake-'));
  const cache = path.join(dir, 'recommendations.json');
  const status = path.join(dir, 'status.json');
  const source = {
    jobs: [{
      url: 'https://app.joinhandshake.com/jobs/11190664',
      title: 'Associate Enterprise Systems Analyst',
      company: 'Momentum',
      description: 'Build and support enterprise systems and data workflows. '.repeat(4),
      applyAvailable: true,
      sourceEvidence: { authenticated: true },
    }],
  };
  writeFileSync(cache, JSON.stringify(source));
  writeFileSync(status, JSON.stringify({ ok: false, outcome: 'bridge-unavailable', error: 'daemon unavailable' }));
  const logs = [];
  const jobs = await plugin.ingest({
    settings: { cache_file: cache, status_file: status },
    dryRun: true,
    log: (message) => logs.push(message),
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].liveness, 'active');
  assert.match(logs[0], /browser sync unavailable/i);
  assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')), source);
});
