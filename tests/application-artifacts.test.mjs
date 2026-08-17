import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  artifactPathsForItem,
  assessResumeReuse,
  buildCoverLetter,
  candidateCopyArtifactReadiness,
  generateApplicationArtifacts,
  laneForItem,
} from '../apply/application-artifacts.mjs';

function fixtureItem(overrides = {}) {
  return {
    id: 'artifact-test-role',
    company: 'Example AI',
    title: 'Backend / AI Engineer',
    location: 'New York, NY',
    description: 'Build Python and TypeScript backend services, REST APIs, data pipelines, PostgreSQL workflows, LLM integrations, automated tests, and CI/CD systems.',
    applyUrl: 'https://jobs.ashbyhq.com/example/role',
    lane: 'backend_ai_platform',
    ...overrides,
  };
}

test('artifact generation selects verified lane evidence and writes a truthful cover letter', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-artifacts-'));
  try {
    const result = await generateApplicationArtifacts(fixtureItem(), {
      outputRoot: root,
      renderPdf: false,
      fetchJobDescription: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.cached, false);
    assert.deepEqual(result.selectedProjects.map((project) => project.name), [
      'Tenure',
      'BidCamp',
      'Quality Runner',
      'AI Context Runtime',
      'Agent Eval Runtime',
    ]);
    const cover = readFileSync(result.coverLetterText, 'utf8');
    assert.equal(result.resumeMarkdown, '');
    assert.equal(result.resumeHtml, '');
    assert.match(result.resumePdf, /output\/lanes\/Jakye-Amos-Resume-Backend-AI-Data\.pdf$/);
    assert.equal(existsSync(path.join(root, 'resume.md')), false);
    assert.match(cover, /Example AI/);
    assert.match(cover, /Backend \/ AI Engineer/);
    assert.doesNotMatch(cover, /Snowflake/);
    assert.equal(result.coverLetterReady, false);
    assert.equal(result.coverLetter.copyQuality.status, 'pending');
    assert.equal(candidateCopyArtifactReadiness(result, result.coverLetterText).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact generation caches by job and evidence hashes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-artifact-cache-'));
  try {
    const item = fixtureItem({ id: 'cache-role' });
    const first = await generateApplicationArtifacts(item, { outputRoot: root, renderPdf: false, fetchJobDescription: false });
    const second = await generateApplicationArtifacts(item, { outputRoot: root, renderPdf: false, fetchJobDescription: false });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(second.manifestPath, artifactPathsForItem(item, { outputRoot: root }).manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact generation uses a public ATS description before the browserless page fallback', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-ats-description-'));
  const previousFetch = globalThis.fetch;
  try {
    const apiDescription = '<h2>What you will do</h2><p>Build reliable Python and TypeScript services for a production platform. Work with product and engineering partners to ship tested APIs, data workflows, observability, and applied AI capabilities.</p>';
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://boards-api.greenhouse.io/v1/boards/example/jobs/123');
      assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify({ content: apiDescription }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await generateApplicationArtifacts(fixtureItem({
      id: 'ats-description-role',
      description: 'Short listing.',
      applyUrl: 'https://boards.greenhouse.io/example/jobs/123',
    }), {
      outputRoot: root,
      renderPdf: false,
    });
    assert.equal(result.ok, true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.job.descriptionSource, 'ats-api');
    assert.equal(manifest.job.descriptionEndpoint, 'https://boards-api.greenhouse.io/v1/boards/example/jobs/123');
    assert.match(result.jobDescription, /Build reliable Python and TypeScript services/);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('lane inference prefers data roles over the default backend lane', () => {
  assert.equal(laneForItem({ title: 'Data Platform Engineer', description: 'Build SQL analytics pipelines.' }, {}), 'data_analytics');
  assert.equal(laneForItem({ title: 'Frontend Product Engineer', description: 'Own the customer product surface.' }, {}), 'product_full_stack');
});

test('generator reads the configured profile lane matrix', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-data-lane-'));
  try {
    const result = await generateApplicationArtifacts(fixtureItem({
      id: 'data-lane-role',
      title: 'Data Platform Engineer',
      description: 'Build SQL analytics pipelines and decision-support workflows for product teams. Partner with engineering and product leaders to improve data quality, reporting, and reliable delivery of insights into customer-facing systems.',
      lane: 'data_analytics',
    }), { outputRoot: root, renderPdf: false, fetchJobDescription: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.selectedProjects.map((project) => project.name), [
      'Dsci-proj',
      'BBDSE / CourtIQ',
      'Agent Eval Runtime',
      'AI Workflow Leverage',
      'Tenure',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generator fails closed when the job description is too short', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-short-jd-'));
  try {
    const result = await generateApplicationArtifacts(fixtureItem({ id: 'short-jd', description: 'Backend role.' }), {
      outputRoot: root,
      renderPdf: false,
      fetchJobDescription: false,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /too short/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cover letter builder stays grounded in selected projects', () => {
  const cover = buildCoverLetter({
    profile: { candidate: { full_name: 'Jakye Amos' } },
    item: fixtureItem(),
    lane: 'backend_ai_platform',
    projects: [{ name: 'Tenure', description: 'A pilot-ready knowledge platform.', missing: false }],
    competencies: ['Python', 'REST APIs'],
  });
  assert.match(cover.text, /pilot-ready knowledge platform/);
  assert.match(cover.text, /REST APIs/);
  assert.doesNotMatch(cover.text, /customers|revenue|completed pilots/i);
});

test('resume selection always uses the canonical lane artifact', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-resume-reuse-'));
  try {
    const item = fixtureItem({ id: 'reuse-role', liveness: 'active' });
    const generated = await generateApplicationArtifacts(item, {
      outputRoot: root,
      renderPdf: false,
      fetchJobDescription: false,
    });
    const decision = assessResumeReuse(item, { outputRoot: root, description: item.description });
    assert.equal(decision.decision, 'lane');
    assert.match(decision.artifactPath, /output\/lanes\/Jakye-Amos-Resume-Backend-AI-Data\.pdf$/);
    assert.match(decision.reasonCodes.join(','), /per-job-generation-retired/);
    assert.equal(generated.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('material artifact changes create one history snapshot while same-content rebuilds do not', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-artifact-history-'));
  try {
    const item = fixtureItem({ id: 'history-role' });
    const first = await generateApplicationArtifacts(item, {
      outputRoot: root,
      renderPdf: false,
      fetchJobDescription: false,
    });
    assert.equal(first.ok, true);
    const same = await generateApplicationArtifacts(item, {
      outputRoot: root,
      renderPdf: false,
      fetchJobDescription: false,
      force: true,
    });
    const sameManifest = JSON.parse(readFileSync(same.manifestPath, 'utf8'));
    assert.equal(sameManifest.history.length, 0);

    const changed = await generateApplicationArtifacts({
      ...item,
      description: `${item.description} Own incident response and observability for production services.`,
    }, {
      outputRoot: root,
      renderPdf: false,
      fetchJobDescription: false,
      force: true,
    });
    const changedManifest = JSON.parse(readFileSync(changed.manifestPath, 'utf8'));
    assert.equal(changedManifest.history.length, 1);
    assert.equal('resumeMarkdown' in changedManifest.history[0].paths, false);
    assert.equal(existsSync(changedManifest.history[0].paths.coverLetterText), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
