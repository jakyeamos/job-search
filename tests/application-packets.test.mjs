import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildApplicationPacket, buildPacketMarkdown, packetFreshnessGate, packetPathsForItem } from '../apply/application-packets.mjs';

test('packet paths are stable and separated from application artifacts', () => {
  const item = { id: 'q1', company: 'Acme', title: 'Backend Engineer', applyUrl: 'https://jobs.example/acme/1' };
  const paths = packetPathsForItem(item, { outputRoot: '/tmp/application-packets-test' });
  assert.match(paths.json, /application-packets-test\/acme-backend-engineer-[a-f0-9]{12}\/submission-packet\.json$/);
  assert.match(paths.markdown, /submission-packet\.md$/);
  assert.notEqual(paths.json, paths.markdown);
});

test('packet markdown makes unknowns and the human submit boundary explicit', () => {
  const markdown = buildPacketMarkdown({
    status: 'needs-user-answers',
    target: { company: 'Acme', title: 'Backend Engineer', url: 'https://jobs.example/acme/1', adapter: 'greenhouse' },
    form: { navigationActions: [{ control: 'Apply', reason: 'posting-page-apply-navigation' }] },
    artifacts: { resumePdf: '/tmp/resume.pdf', coverLetterText: '/tmp/cover-letter.txt' },
    questions: [{ question: 'Why Acme?', status: 'known', answer: 'Verified answer', source: 'question-ledger:q1' }],
    unresolved: [{ id: 'q2', question: 'Do you require sponsorship?', required: true, options: ['Yes', 'No'] }],
    manualItems: [{ label: 'EEO', reason: 'complete manually' }],
  });
  assert.match(markdown, /Human submission only/);
  assert.match(markdown, /Why Acme\?/);
  assert.match(markdown, /Verified answer/);
  assert.match(markdown, /Do you require sponsorship\?/);
  assert.match(markdown, /\[your answer\]/);
  assert.match(markdown, /Safe browser navigation/);
  assert.match(markdown, /Clicked Apply \(posting-page-apply-navigation\)/);
  assert.match(markdown, /Click Submit\/Apply only after your review/);
});

test('packet freshness gate blocks aged roles and warns on recheck-due roles', () => {
  const stale = packetFreshnessGate({
    status: 'stale',
    firstSeenAt: '2026-06-01T00:00:00.000Z',
  }, '2026-07-21T00:00:00.000Z');
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /refresh and revalidate/);

  const due = packetFreshnessGate({
    status: 'in_review',
    firstSeenAt: '2026-06-15T00:00:00.000Z',
  }, '2026-07-21T00:00:00.000Z');
  assert.equal(due.ok, true);
  assert.match(due.warning, /recheck is due/);
});

test('packet dry-run inspects questions without writing ledger, packet, or artifacts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-dry-run-'));
  try {
    const ledgerPath = path.join(root, 'question-ledger.json');
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    const beforeLedger = readFileSync(ledgerPath, 'utf8');
    const item = {
      id: 'packet-dry-run',
      company: 'Acme',
      title: 'Backend Engineer',
      location: 'New York, NY',
      applyUrl: 'https://jobs.example/acme/backend',
      canonicalUrl: 'https://jobs.example/acme/backend',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build Python and TypeScript backend services, REST APIs, data pipelines, PostgreSQL workflows, automated tests, and reliable production systems with product and engineering partners.',
    };
    const inspection = {
      url: item.applyUrl,
      title: 'Apply — Acme',
      heading: 'Backend Engineer',
      formCount: 1,
      formReady: true,
      controls: [{
        id: 'snack',
        label: 'What is your preferred office snack?',
        kind: 'text',
        type: 'text',
        category: 'question',
        required: true,
        options: [],
      }],
      buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
      pages: [],
      manualSignals: [],
      blocked: false,
      blockedReason: '',
    };

    const packet = await buildApplicationPacket(item, {
      inspection,
      ledgerPath,
      outputRoot: root,
      dryRun: true,
      generateArtifacts: true,
    });
    assert.equal(packet.ok, true);
    assert.equal(packet.status, 'needs-user-input');
    assert.equal(packet.unresolved.length, 1);
    assert.match(packet.warnings.join('\n'), /dry-run/);
    assert.equal(readFileSync(ledgerPath, 'utf8'), beforeLedger);
    assert.equal(existsSync(packet.paths.json), false);
    assert.deepEqual(packet.artifacts.resumePdf, '');
    assert.deepEqual(packet.artifacts.coverLetterText, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet counts only nontrivial answer preparation and keeps standard fields separate', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-prep-counts-'));
  try {
    const ledgerPath = path.join(root, 'question-ledger.json');
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    const item = {
      id: 'packet-prep-counts',
      company: 'Acme',
      title: 'Backend Engineer',
      applyUrl: 'https://jobs.example/acme/backend-prep-counts',
      canonicalUrl: 'https://jobs.example/acme/backend-prep-counts',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build Python and TypeScript backend services, REST APIs, data pipelines, PostgreSQL workflows, automated tests, and reliable production systems with product and engineering partners.',
    };
    const packet = await buildApplicationPacket(item, {
      inspection: {
        url: item.applyUrl,
        title: 'Apply — Acme',
        heading: 'Backend Engineer',
        formCount: 1,
        formReady: true,
        controls: [
          { id: 'first-name', label: 'First Name', kind: 'text', category: 'standard', required: true },
          { id: 'name', label: 'Name', kind: 'text', category: 'question', required: true },
          { id: 'country', label: 'Country', kind: 'combobox', category: 'question', required: false, options: [] },
          { id: 'email', label: 'Email', kind: 'text', category: 'standard', required: true },
          { id: 'why', label: 'Why Acme?', kind: 'textarea', category: 'question', required: true, options: [] },
          { id: 'office', label: 'Are you open to working in person?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
          { id: 'gender', label: 'Gender', kind: 'combobox', category: 'question', required: false, options: ['Prefer not to say'] },
        ],
        buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
        pages: [],
        manualSignals: [],
        blocked: false,
        blockedReason: '',
      },
      ledgerPath,
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.status, 'needs-user-input');
    assert.deepEqual(packet.questions.map((question) => question.question), ['Why Acme?']);
    assert.deepEqual(packet.simpleFields.map((question) => question.question), ['Are you open to working in person?']);
    assert.equal(packet.standardFields.length, 4);
    assert.equal(packet.manualItems.length, 1);
    assert.deepEqual(packet.unresolved.map((question) => question.question), ['Why Acme?']);
    assert.deepEqual(packet.simpleUnresolved.map((question) => question.question), ['Are you open to working in person?']);
    assert.deepEqual(packet.answerPrep, {
      questionCount: 1,
      unresolvedCount: 1,
      simpleFieldCount: 1,
      simpleUnresolvedCount: 1,
      standardFieldCount: 4,
      manualFieldCount: 1,
      artifactFieldCount: 0,
      requiredUnresolvedCount: 2,
    });
    assert.equal(packet.ledger.canonicalQuestionCount, 2);
    assert.equal(packet.ledger.unresolvedCount, 2);
    assert.doesNotMatch(packet.markdown, /First Name/);
    assert.match(packet.markdown, /Why Acme\?/);
    assert.match(packet.markdown, /Simple fields to complete in the form/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet blocks incomplete posting evidence instead of presenting it as ready', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-blocked-'));
  try {
    const packet = await buildApplicationPacket({
      id: 'packet-missing-description',
      company: 'Acme',
      title: 'Backend Engineer',
      applyUrl: 'https://jobs.example/acme/backend',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Short listing.',
    }, {
      inspection: {
        url: 'https://jobs.example/acme/backend',
        title: 'Apply — Acme',
        heading: 'Backend Engineer',
        formCount: 1,
        formReady: true,
        controls: [],
        buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
        pages: [],
      },
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.ok, true);
    assert.equal(packet.status, 'blocked');
    assert.match(packet.warnings.join('\n'), /job description is missing or too short/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet hydrates a missing queue JD from the inspected application page and cleans source title tags', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-live-jd-'));
  try {
    const ledgerPath = path.join(root, 'question-ledger.json');
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    const item = {
      id: 'packet-live-jd',
      company: 'Acme',
      title: '\\[C\\] Backend Engineer',
      applyUrl: 'https://jobs.example/acme/backend-live-jd',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: '',
    };
    const packet = await buildApplicationPacket(item, {
      inspection: {
        url: item.applyUrl,
        title: 'Apply — Acme',
        heading: 'Backend Engineer',
        titleVisible: false,
        jobDescription: 'Build reliable Python and TypeScript services, APIs, data pipelines, PostgreSQL workflows, automated tests, and production systems with product and engineering partners. Own systems from design through operation and improve the developer experience.',
        jobDescriptionSource: 'application-page:selector',
        formCount: 1,
        formReady: true,
        controls: [],
        buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
        pages: [],
      },
      ledgerPath,
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.status, 'ready-for-human-review');
    assert.equal(packet.target.title, 'Backend Engineer');
    assert.equal(packet.target.descriptionSource, 'application-page:selector');
    assert.ok(packet.target.descriptionLength >= 120);
    assert.doesNotMatch(packet.warnings.join('\n'), /job description is missing or too short/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet keeps optional unknowns visible and preserves cover-letter review states', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-cover-'));
  try {
    const item = {
      id: 'packet-cover-review',
      company: 'Acme',
      title: 'Backend Engineer',
      applyUrl: 'https://jobs.example/acme/backend-cover',
      canonicalUrl: 'https://jobs.example/acme/backend-cover',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build Python and TypeScript backend services, REST APIs, data pipelines, PostgreSQL workflows, automated tests, and reliable production systems with product and engineering partners.',
    };
    const packet = await buildApplicationPacket(item, {
      inspection: {
        url: item.applyUrl,
        title: 'Apply — Acme',
        heading: 'Backend Engineer',
        formCount: 1,
        formReady: true,
        controls: [{
          id: 'optional',
          label: 'Optional application note',
          kind: 'textarea',
          type: 'textarea',
          category: 'question',
          required: false,
          options: [],
        }],
        buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
        pages: [],
      },
      drafts: {
        questions: [{
          question: 'Optional application note',
          draft: 'I built 3 reliable systems in 2025.',
          humanized: 'I built 3 reliable systems in 2025.',
          evidenceRefs: ['cv:experience'],
        }],
        coverLetter: {
          draft: 'I built a $160k workflow in 2024.',
          humanized: 'I built a $160k workflow in 2024.',
          approved: true,
          evidenceRefs: ['article-digest:workflow'],
        },
      },
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.status, 'ready-for-human-review');
    assert.equal(packet.unresolved.length, 0);
    assert.equal(packet.questions[0].status, 'humanized');
    assert.equal(packet.questions[0].provenance.evidenceRefs[0], 'cv:experience');
    assert.equal(packet.coverLetter.status, 'approved');
    assert.equal(packet.coverLetter.humanization.passed, true);
    assert.match(packet.markdown, /Approved copy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet history snapshots only material form changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-history-'));
  try {
    const item = {
      id: 'packet-history',
      company: 'Acme',
      title: 'Backend Engineer',
      applyUrl: 'https://jobs.example/acme/backend-history',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build Python and TypeScript backend services, REST APIs, data pipelines, PostgreSQL workflows, automated tests, and reliable production systems with product and engineering partners.',
    };
    const baseInspection = {
      url: item.applyUrl,
      title: 'Apply — Acme',
      heading: 'Backend Engineer',
      formCount: 1,
      formReady: true,
      controls: [],
      buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
      pages: [],
    };
    const first = await buildApplicationPacket(item, {
      inspection: baseInspection,
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.deepEqual(first.history, []);
    const second = await buildApplicationPacket(item, {
      inspection: { ...baseInspection, buttons: [{ ...baseInspection.buttons[0], text: 'Submit your application' }] },
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(second.history.length, 1);
    assert.deepEqual(second.history[0].reasonCodes, ['application-form-changed']);
    assert.equal(existsSync(second.history[0].jsonPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet dry-run never snapshots an existing packet into history', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-dry-run-history-'));
  try {
    const item = {
      id: 'packet-dry-run-history',
      company: 'Acme',
      title: 'Backend Engineer',
      applyUrl: 'https://jobs.example/acme/backend-dry-run-history',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build Python and TypeScript backend services, REST APIs, data pipelines, PostgreSQL workflows, automated tests, and reliable production systems with product and engineering partners.',
    };
    const baseInspection = {
      url: item.applyUrl,
      title: 'Apply — Acme',
      heading: 'Backend Engineer',
      formCount: 1,
      formReady: true,
      controls: [],
      buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
      pages: [],
    };
    const first = await buildApplicationPacket(item, {
      inspection: baseInspection,
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.deepEqual(first.history, []);
    const packetDirectory = packetPathsForItem(item, { outputRoot: root }).directory;
    const changedInspection = {
      ...baseInspection,
      buttons: [{ ...baseInspection.buttons[0], text: 'Submit your application' }],
    };
    const dryRun = await buildApplicationPacket(item, {
      inspection: changedInspection,
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
      dryRun: true,
    });
    assert.deepEqual(dryRun.history, []);
    assert.equal(existsSync(path.join(packetDirectory, 'history')), false);
    assert.equal(readFileSync(path.join(packetDirectory, 'submission-packet.json'), 'utf8').includes('Submit application'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
