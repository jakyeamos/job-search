import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverProofRepos, renderProofScan, scanProofRepos } from '../proof-scan.mjs';

test('discovers proof sources while excluding the scanner and deprecated console by default', () => {
  const root = '/Users/jakyeamos/projects';
  const active = discoverProofRepos(root);
  const withArchived = discoverProofRepos(root, { includeArchived: true });

  assert.ok(!active.includes('/Users/jakyeamos/projects/career-ops'));
  assert.ok(!active.includes('/Users/jakyeamos/projects/BIP-Console'));
  assert.ok(withArchived.includes('/Users/jakyeamos/projects/career-ops'));
  assert.ok(withArchived.includes('/Users/jakyeamos/projects/BIP-Console'));
});

test('renders an empty proof report as a review-only artifact', () => {
  const report = scanProofRepos({ root: '/Users/jakyeamos/projects/does-not-exist', date: '2026-07-22' });
  const markdown = renderProofScan(report);

  assert.equal(report.repoCount, 0);
  assert.equal(report.eventCount, 0);
  assert.equal(report.root, 'does-not-exist');
  assert.match(markdown, /review input/);
  assert.match(markdown, /does not publish, submit/);
});

test('keeps local repository paths out of the serialized proof report', () => {
  const report = scanProofRepos({ root: '/Users/jakyeamos/projects', date: '2026-07-22' });

  assert.doesNotMatch(JSON.stringify(report), /\/Users\/jakyeamos/);
});
