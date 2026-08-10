import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCivicDiscoveryReport,
  loadCivicDiscoveryReport,
  renderCivicDiscoveryMarkdown,
  runCivicDiscoveryCli,
} from '../civic-discovery.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('civic discovery keeps live roles, outreach targets, and stale leads in separate lanes', () => {
  const report = loadCivicDiscoveryReport({ generatedAt: '2026-08-08T12:00:00.000Z' });

  assert.equal(report.currentRoles.length, 5);
  assert.equal(report.staleLeads.length, 2);
  assert.ok(report.outreachTargets.some((record) => record.id === 'ppg'));
  const communityTechAlliance = report.outreachTargets.find((record) => record.id === 'community-tech-alliance');
  assert.equal(communityTechAlliance.layer, 'national-progressive-civic-tech');
  assert.equal(communityTechAlliance.url, 'https://communitytechalliance.org/');
  const openCleveland = report.outreachTargets.find((record) => record.id === 'open-cleveland');
  assert.equal(openCleveland.location, 'Cleveland / Northeast Ohio');
  assert.equal(openCleveland.verification, 'source-verified');
  assert.ok(openCleveland.sourceEvidence.some((entry) => entry.url === 'https://opencleveland.org/about/'));
  const charlotteDataTrust = report.outreachTargets.find((record) => record.id === 'charlotte-regional-data-trust');
  assert.equal(charlotteDataTrust.location, 'Charlotte / Mecklenburg County');
  assert.equal(charlotteDataTrust.layer, 'charlotte-local');
  assert.equal(charlotteDataTrust.verification, 'source-verified');
  assert.equal(report.missionFirstTargets.length, 9);
  const clevelandOwns = report.missionFirstTargets.find((record) => record.id === 'cleveland-owns');
  assert.equal(clevelandOwns.orientation, 'mission-first');
  assert.match(clevelandOwns.interestFit, /economic democracy/i);
  assert.match(clevelandOwns.technicalBridge, /Secondary/i);
  assert.equal(report.otherOutreachTargets.length, report.outreachTargets.length - report.missionFirstTargets.length);
  assert.ok(report.currentRoles.every((record) => record.verification === 'live-verified'));
  assert.ok(report.staleLeads.every((record) => record.reason));
  assert.equal(report.rules.applicationTracker, false);
  assert.equal(report.rules.autoContact, false);
  assert.equal(report.rules.autoSubmit, false);

  const markdown = renderCivicDiscoveryMarkdown(report);
  assert.match(markdown, /Current roles — human review before applying/);
  assert.match(markdown, /Outreach targets — human review before contacting/);
  assert.match(markdown, /Stale leads — refresh before acting/);
  assert.match(markdown, /Blue Rose Research/);
  assert.match(markdown, /Cleveland Owns/);
  assert.match(markdown, /Interest fit: The clearest Cleveland fit for economic democracy/);
});

test('unverified discoveries cannot be presented as current roles', () => {
  assert.throws(() => buildCivicDiscoveryReport({
    discoveries: [{
      id: 'unverified-role',
      organization: 'Example Civic Lab',
      lane: 'current-role',
      title: 'Engineer',
      url: 'https://example.com/jobs/engineer',
      verification: 'unverified-lead',
      sourceEvidence: ['strategy memo'],
    }],
  }), /verification must be live-verified/);
});

test('CLI writes only the separate civic report and leaves applications.md unchanged', () => {
  const applicationsPath = path.join(ROOT, 'data', 'applications.md');
  const before = readFileSync(applicationsPath, 'utf8');
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'civic-discovery-'));

  try {
    const message = runCivicDiscoveryCli(['--write', '--output-dir', outputDir]);
    assert.match(message, /civic-discovery\.md/);
    assert.match(message, /civic-discovery\.json/);
    assert.equal(readFileSync(applicationsPath, 'utf8'), before);
    assert.match(readFileSync(path.join(outputDir, 'civic-discovery.md'), 'utf8'), /additive lane/);
    assert.match(readFileSync(path.join(outputDir, 'civic-discovery.json'), 'utf8'), /"currentRoles"/);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
