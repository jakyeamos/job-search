import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFastPassManifest,
  parsePendingPipeline,
  safeAutoSkipBlockers,
} from '../pipeline-fast-pass.mjs';

const LONG_BODY = 'Build reliable Python and TypeScript services for AI products. '.repeat(8);

test('fast pass parses only unchecked pipeline rows and preserves line numbers', () => {
  const text = [
    '# Pipeline',
    '',
    '- [ ] https://jobs.ashbyhq.com/acme/job-1 | Acme | Software Engineer | Remote US',
    '- [x] https://jobs.ashbyhq.com/acme/job-2 | Acme | Data Engineer | Remote US',
    '- [!] https://example.com/job-3 — unreachable',
    '- [ ] https://jobs.lever.co/example/job-4 | Example | AI Engineer | New York, NY',
  ].join('\n');

  const jobs = parsePendingPipeline(text);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.lineNumber), [3, 6]);
  assert.equal(jobs[1].company, 'Example');
});

test('fast pass routes deterministic blockers, active candidates, and expired roles', () => {
  const jobs = parsePendingPipeline([
    '- [ ] https://jobs.ashbyhq.com/acme/job-1 | Acme | Senior Software Engineer | Remote US',
    '- [ ] https://jobs.ashbyhq.com/acme/job-2 | Acme | Software Engineer | Remote US',
    '- [ ] https://jobs.ashbyhq.com/acme/job-3 | Acme | Data Engineer | Remote US',
  ].join('\n'));
  const results = [
    { ok: true, fields: { title: 'Senior Software Engineer', location: 'Remote US', description: LONG_BODY }, liveness: 'active' },
    { ok: true, fields: { title: 'Software Engineer', location: 'Remote US', description: LONG_BODY }, liveness: 'active' },
    { ok: false, outcome: 'expired', reason: 'not on board' },
  ];

  const manifest = buildFastPassManifest(jobs, results, {}, {
    generatedAt: '2026-07-29T12:00:00.000Z',
    elapsedMs: 42,
  });

  assert.equal(manifest.items[0].route, 'deterministic_skip');
  assert.match(manifest.items[0].deterministic.autoSkipBlockers[0], /seniority title/);
  assert.equal(manifest.items[1].route, 'model_triage');
  assert.equal(manifest.items[2].route, 'expired');
  assert.deepEqual(manifest.routes, {
    deterministic_skip: 1,
    model_triage: 1,
    expired: 1,
  });
  assert.equal(manifest.instructions.submitApplications, false);
  assert.equal(manifest.instructions.reportMode, 'compact-decision-card');
});

test('generic government prose requires model review unless title or company confirms defense work', () => {
  const ambiguous = {
    blockers: ['defense, intelligence, clearance, or government-mission role'],
  };
  assert.deepEqual(safeAutoSkipBlockers({
    company: 'CoreWeave',
    title: 'Systems Engineer',
  }, ambiguous), []);
  assert.deepEqual(safeAutoSkipBlockers({
    company: 'Example',
    title: 'Forward Deployed Engineer - US Government',
  }, ambiguous), ambiguous.blockers);
});
