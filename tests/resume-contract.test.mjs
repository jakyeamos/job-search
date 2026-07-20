import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildResumeRequest,
  inferResumeFormat,
  registerResumeArtifact,
  resolveResumeArtifact,
} from '../resume-contract.mjs';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-resume-contract-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), '# CV\n\n## Experience\nVerified evidence.\n', 'utf8');
  writeFileSync(join(root, 'article-digest.md'), '# Evidence\n', 'utf8');
  writeFileSync(join(root, 'config', 'profile.yml'), [
    'search_strategy:',
    '  lane_matrix:',
    '    backend_ai_platform:',
    '      resume_projects: [Tenure, BidCamp, Quality Runner]',
  ].join('\n'), 'utf8');
  return root;
}

test('resume request centralizes lane, evidence, format, and artifact paths', () => {
  const root = fixtureRoot();
  const request = buildResumeRequest({
    id: 'role-1',
    company: 'Example AI',
    title: 'Backend Engineer',
    location: 'Toronto, Canada',
    description: 'Build backend services and data pipelines.',
    applyUrl: 'https://jobs.example.com/role-1',
    lane: 'backend_ai_platform',
  }, root);

  assert.equal(request.paperFormat, 'letter');
  assert.deepEqual(request.selectedProjects, ['Tenure', 'BidCamp', 'Quality Runner']);
  assert.deepEqual(request.evidenceSources.map((source) => source.path), ['cv.md', 'article-digest.md', 'config/profile.yml']);
  assert.match(request.manifestPath, /output\/applications\/example-ai-backend-engineer-role-1\/resume-manifest\.json$/);
});

test('resume format uses A4 for European postings and letter by default', () => {
  assert.equal(inferResumeFormat('London, UK', ''), 'a4');
  assert.equal(inferResumeFormat('Remote', ''), 'letter');
});

test('legacy artifacts are accepted, then registration creates a verifiable manifest', () => {
  const root = fixtureRoot();
  const artifact = join(root, 'output', 'resume.pdf');
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(artifact, 'pdf fixture', 'utf8');
  const item = {
    id: 'role-2',
    company: 'Example AI',
    title: 'Applied AI Engineer',
    location: 'New York, NY',
    description: 'Build applied AI systems.',
    applyUrl: 'https://jobs.example.com/role-2',
    resumeArtifact: artifact,
    lane: 'applied_ai_client_delivery',
  };

  const legacy = resolveResumeArtifact(item, root);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.status, 'legacy-existing');

  const registered = registerResumeArtifact(item, root, {
    artifactPath: artifact,
    sourceMode: 'tailored',
    auditStatus: 'passed',
  });
  const manifest = JSON.parse(readFileSync(registered.manifestPath, 'utf8'));
  assert.equal(manifest.auditStatus, 'passed');
  assert.equal(manifest.sourceMode, 'tailored');

  const resolved = resolveResumeArtifact({ ...item, resumeManifest: registered.manifestPath }, root);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.status, 'manifested');

  writeFileSync(artifact, 'changed after registration', 'utf8');
  const stale = resolveResumeArtifact({ ...item, resumeManifest: registered.manifestPath }, root);
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 'stale');
});

test('markdown is not treated as an uploadable resume artifact', () => {
  const root = fixtureRoot();
  const item = {
    id: 'role-3',
    company: 'Example AI',
    title: 'Software Engineer',
    resumeArtifact: join(root, 'cv.md'),
  };
  const result = resolveResumeArtifact(item, root);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
});
