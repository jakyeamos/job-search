import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectStaleSourceReferences,
  discoverRepositories,
  renderRefreshReport,
} from '../cv-refresh.mjs';

test('repository discovery stops at Git roots and skips dependency trees', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-cv-refresh-'));
  const repository = path.join(root, 'pronto');
  const nestedDependency = path.join(repository, 'node_modules', 'fake-repo');
  mkdirSync(path.join(repository, '.git'), { recursive: true });
  mkdirSync(path.join(nestedDependency, '.git'), { recursive: true });

  assert.deepEqual(discoverRepositories([root], 4), [realpathSync(repository)]);
});

test('refresh reports preserve the report-only boundary and review wording', () => {
  const result = {
    date: '2026-07-27',
    roots: ['/Users/jakyeamos/projects', '/Users/jakyeamos/Documents'],
    repositories: [],
    reviewCandidates: [{
      displayName: 'Pronto',
      discoveryStatus: 'baseline',
      path: '/Users/jakyeamos/Documents/pronto',
      branch: 'main',
      version: '1.0.0',
      tag: 'f8a40fa',
      latestCommit: { date: '2026-07-27', subject: 'docs: record app install workflow' },
      dirty: false,
      represented: false,
      matchedAliases: [],
      evidenceSignals: ['public-v1', 'read-only'],
      evidencePaths: ['/Users/jakyeamos/Documents/pronto/.tracker/PROJECT_TRUTH.md'],
      reviewReasons: ['not represented in cv.md, article-digest.md, or the accomplishment ledger'],
      description: 'A local-first portfolio command center for Git repositories.',
    }],
    staleSourceReferences: [],
  };

  const report = renderRefreshReport(result);
  assert.match(report, /This is a report-only scan/);
  assert.match(report, /Pronto/);
  assert.match(report, /Candidate wording — review before applying/);
  assert.match(report, /never approves a project/);
});

test('stale ledger references are reported without mutating the ledger', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-cv-refresh-ledger-'));
  const ledgerPath = path.join(root, 'ledger.json');
  const missingPath = path.join(root, 'missing', 'README.md');
  writeFileSync(ledgerPath, JSON.stringify({ entries: [{ id: 'pronto', sourceRefs: [missingPath] }] }));

  assert.deepEqual(collectStaleSourceReferences(ledgerPath), [{ id: 'pronto', sourceRef: missingPath }]);
});
