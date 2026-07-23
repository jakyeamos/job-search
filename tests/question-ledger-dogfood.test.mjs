import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PACKET_ROOT,
  buildDogfoodPlan,
  resolveDogfoodStaging,
  runLedgerDogfood,
} from '../apply/question-ledger-dogfood.mjs';
import { DEFAULT_LEDGER_PATH, recordQuestion } from '../apply/question-ledger.mjs';

const LONG_DESCRIPTION = 'Build reliable Python and TypeScript services, APIs, data pipelines, PostgreSQL workflows, automated tests, and production systems with product and engineering partners.'.repeat(2);

function item(id, adapter, overrides = {}) {
  const urls = {
    ashby: `https://jobs.ashbyhq.com/acme/${id}`,
    greenhouse: `https://boards.greenhouse.io/acme/jobs/${id}`,
    lever: `https://jobs.lever.co/acme/${id}`,
    unknown: `https://example.com/jobs/${id}`,
  };
  return {
    id,
    company: 'Acme',
    title: 'Backend Engineer',
    applyUrl: urls[adapter] || urls.unknown,
    canonicalUrl: urls[adapter] || urls.unknown,
    status: 'in_review',
    liveness: 'active',
    fitScore: 4.5,
    description: LONG_DESCRIPTION,
    firstSeenAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

test('dogfood selection is deterministic and round-robins supported ATS adapters', () => {
  const items = [
    item('a1', 'ashby', { fitScore: 4.1 }),
    item('a2', 'ashby', { fitScore: 4.8 }),
    item('g1', 'greenhouse', { fitScore: 4.2 }),
    item('g2', 'greenhouse', { fitScore: 4.7 }),
    item('l1', 'lever', { fitScore: 4.3 }),
    item('l2', 'lever', { fitScore: 4.6 }),
    item('unknown', 'unknown'),
    item('uncertain', 'ashby', { liveness: 'uncertain' }),
    item('missing-description', 'greenhouse', { description: '' }),
    item('excluded', 'lever', { status: 'excluded' }),
    item('submitted', 'ashby', { applicationState: 'submitted' }),
  ];
  const first = buildDogfoodPlan(items, { sampleSize: 4, minFitScore: 4 });
  const second = buildDogfoodPlan(items, { sampleSize: 4, minFitScore: 4 });

  assert.deepEqual(first.selected.map((candidate) => candidate.id), second.selected.map((candidate) => candidate.id));
  assert.deepEqual(first.selected.map((candidate) => candidate.adapter), ['ashby', 'greenhouse', 'lever', 'ashby']);
  assert.equal(first.eligible.length, 7);
  assert.equal(first.reasonCounts['unsupported-adapter'], 1);
  assert.equal(first.reasonCounts['liveness-uncertain'], 1);
  assert.equal(first.verificationWarningCounts['missing-description'], 1);
  assert.equal(first.reasonCounts['status-excluded'], 1);
  assert.equal(first.reasonCounts['application-state-submitted'], 1);
});

test('shape-only mode samples supported forms while retaining verification warnings', () => {
  const plan = buildDogfoodPlan([
    item('uncertain', 'ashby', { liveness: 'uncertain', description: '' }),
    item('active', 'greenhouse'),
    item('unknown', 'unknown'),
    item('excluded', 'lever', { status: 'excluded' }),
  ], { shapeOnly: true, sampleSize: 10 });

  assert.equal(plan.eligible.length, 2);
  assert.equal(plan.selected.length, 2);
  const uncertain = plan.selected.find((candidate) => candidate.id === 'uncertain');
  assert.ok(uncertain);
  assert.deepEqual(uncertain.verificationWarnings, ['liveness-uncertain', 'missing-description']);
  assert.equal(plan.reasonCounts['unsupported-adapter'], 1);
  assert.equal(plan.reasonCounts['status-excluded'], 1);
});

test('explicit all mode selects every eligible candidate while the default remains capped', () => {
  const items = Array.from({ length: 45 }, (_, index) => item(`a-${index}`, 'ashby'));
  assert.equal(buildDogfoodPlan(items).selected.length, 12);
  assert.equal(buildDogfoodPlan(items, { sampleSize: 999 }).selected.length, 40);
  const full = buildDogfoodPlan(items, { all: true });
  assert.equal(full.eligible.length, 45);
  assert.equal(full.selected.length, 45);
  assert.equal(full.policy.all, true);
  assert.equal(full.policy.sampleSize, null);
});

test('staging paths reject canonical data and packet roots', () => {
  assert.throws(() => resolveDogfoodStaging({ stagingRoot: DEFAULT_LEDGER_PATH }), /outside canonical/);
  assert.throws(() => resolveDogfoodStaging({ stagingRoot: DEFAULT_PACKET_ROOT }), /outside canonical/);

  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-dogfood-paths-'));
  try {
    const staging = resolveDogfoodStaging({ stagingRoot: path.join(root, 'staging') });
    assert.equal(staging.root, path.join(root, 'staging'));
    assert.ok(existsSync(staging.ledgerPath) === false);
    assert.ok(existsSync(staging.outputRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan mode does not create staging files or mutate queue and ledger sources', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-dogfood-plan-'));
  try {
    const queuePath = path.join(root, 'queue.json');
    const ledgerPath = path.join(root, 'ledger.json');
    writeFileSync(queuePath, JSON.stringify({ items: [item('plan', 'ashby')] }));
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    const queueBefore = readFileSync(queuePath, 'utf8');
    const ledgerBefore = readFileSync(ledgerPath, 'utf8');
    const result = await runLedgerDogfood({ mode: 'plan', queuePath, sourceLedgerPath: ledgerPath });

    assert.equal(result.report.mode, 'plan');
    assert.equal(result.report.sampleCount, 1);
    assert.equal(result.report.staging.root, null);
    assert.equal(readFileSync(queuePath, 'utf8'), queueBefore);
    assert.equal(readFileSync(ledgerPath, 'utf8'), ledgerBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run mode copies the ledger into staging and reports duplicate observations without promotion', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-dogfood-run-'));
  try {
    const queuePath = path.join(root, 'queue.json');
    const ledgerPath = path.join(root, 'ledger.json');
    const stagingRoot = path.join(root, 'staging');
    writeFileSync(queuePath, JSON.stringify({ items: [item('run-a', 'ashby'), item('run-g', 'greenhouse')] }));
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    const queueBefore = readFileSync(queuePath, 'utf8');
    const ledgerBefore = readFileSync(ledgerPath, 'utf8');

    const result = await runLedgerDogfood({
      mode: 'run',
      queuePath,
      sourceLedgerPath: ledgerPath,
      stagingRoot,
      buildPacket: async (target, options) => {
        assert.equal(options.generateArtifacts, false);
        assert.equal(options.generateCoverLetter, false);
        assert.match(options.ledgerPath, /staging\/question-ledger\.json$/);
        recordQuestion(options.ledgerPath, 'What is your preferred working location?', {
          company: target.company,
          fieldKind: 'text',
        });
        return {
          ok: true,
          status: 'needs-user-input',
          questions: [{ question: 'What is your preferred working location?' }],
          unresolved: [{ question: 'What is your preferred working location?', required: true }],
          warnings: [],
          ledger: { pendingGroups: 1 },
          paths: { json: path.join(options.outputRoot, `${target.id}.json`) },
        };
      },
    });

    assert.equal(result.report.mode, 'run');
    assert.equal(result.report.runs.length, 2);
    assert.equal(result.report.ledger.before.total, 0);
    assert.equal(result.report.ledger.after.total, 1);
    assert.equal(result.report.ledger.delta.observedQuestionCount, 2);
    assert.equal(result.report.ledger.delta.newEntries, 1);
    assert.equal(result.report.staging.canonicalLedgerTouched, false);
    assert.equal(result.report.staging.canonicalQueueTouched, false);
    assert.equal(readFileSync(queuePath, 'utf8'), queueBefore);
    assert.equal(readFileSync(ledgerPath, 'utf8'), ledgerBefore);
    assert.ok(existsSync(result.report.staging.ledgerPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
