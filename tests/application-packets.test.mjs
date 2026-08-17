import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildApplicationPacket, buildPacketMarkdown, packetFreshnessGate, packetPathsForItem } from '../apply/application-packets.mjs';
import { OUTREACH_DISCOVERY_PIPELINE_VERSION } from '../outreach-lib.mjs';

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

test('packet markdown keeps unhumanized narrative drafts out of copy/paste', () => {
  const markdown = buildPacketMarkdown({
    status: 'ready-for-human-review',
    copyQuality: { status: 'review_required' },
    target: { company: 'Acme', title: 'Backend Engineer', url: 'https://jobs.example/acme/1', adapter: 'greenhouse' },
    form: { navigationActions: [] },
    artifacts: {},
    questions: [{
      question: 'Why Acme?',
      status: 'draft',
      answer: 'Raw evidence-bound draft',
      rawAnswer: 'Raw evidence-bound draft',
      copyQualityRequired: true,
      copyQuality: { status: 'pending', finalReady: false },
    }],
    unresolved: [],
    manualItems: [],
  });
  const copyPasteSection = markdown.split('## Copy/paste answers')[1].split('## Drafts awaiting Humanizer')[0];
  assert.match(markdown, /Candidate copy gate: review_required/);
  assert.doesNotMatch(copyPasteSection, /Raw evidence-bound draft/);
  assert.match(markdown, /Drafts awaiting Humanizer/);
  assert.match(markdown, /Do not copy this answer yet/);
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
    assert.equal(packet.status, 'ready-for-human-review');
    assert.deepEqual(packet.questions.map((question) => question.question), ['Why Acme?']);
    assert.match(packet.questions[0].answer, /I am interested in Acme/);
    assert.equal(packet.questions[0].source, 'job-aware-motivation');
    assert.equal(packet.questions[0].copyQualityRequired, true);
    assert.equal(packet.questions[0].copyQuality.status, 'pending');
    assert.equal(packet.copyQuality.status, 'review_required');
    assert.equal(packet.copyQuality.finalReady, false);
    assert.deepEqual(packet.simpleFields.map((question) => question.question), ['Are you open to working in person?']);
    assert.equal(packet.simpleFields[0].answer, 'Yes');
    assert.equal(packet.simpleFields[0].status, 'confirmed');
    assert.equal(packet.standardFields.length, 4);
    assert.equal(packet.manualItems.length, 1);
    assert.deepEqual(packet.unresolved.map((question) => question.question), []);
    assert.deepEqual(packet.simpleUnresolved.map((question) => question.question), []);
    assert.deepEqual(packet.answerPrep, {
      questionCount: 1,
      unresolvedCount: 0,
      simpleFieldCount: 1,
      simpleUnresolvedCount: 0,
      standardFieldCount: 4,
      manualFieldCount: 1,
      artifactFieldCount: 0,
      requiredUnresolvedCount: 0,
    });
    assert.equal(packet.ledger.canonicalQuestionCount, 2);
    assert.equal(packet.ledger.unresolvedCount, 0);
    assert.doesNotMatch(packet.markdown, /First Name/);
    assert.match(packet.markdown, /Why Acme\?/);
    assert.match(packet.markdown, /Simple fields to complete in the form/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('profile evidence does not answer capability, relocation, sponsorship, or country prompts with an address', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-profile-boundaries-'));
  try {
    const item = {
      id: 'packet-profile-boundaries',
      company: 'Acme',
      title: 'Backend Engineer',
      applyUrl: 'https://jobs.example/acme/backend-profile-boundaries',
      canonicalUrl: 'https://jobs.example/acme/backend-profile-boundaries',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build reliable Python and TypeScript services, APIs, data pipelines, PostgreSQL workflows, automated tests, and production systems with product and engineering partners.',
    };
    const packet = await buildApplicationPacket(item, {
      inspection: {
        url: item.applyUrl,
        title: 'Apply — Acme',
        heading: 'Backend Engineer',
        formCount: 1,
        formReady: true,
        controls: [
          { id: 'location', label: 'Current Location', kind: 'combobox', category: 'question', required: true, options: [] },
          { id: 'work-country', label: 'Which country are you working from?', kind: 'combobox', category: 'question', required: true, options: [] },
          { id: 'capability', label: 'Have you worked with Salesforce integrations in an engineering capacity?', kind: 'textarea', category: 'question', required: true, options: [] },
          { id: 'relocation', label: 'Are you open to relocation for this role?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
          { id: 'sponsorship', label: 'Will you now or in the future require visa sponsorship?', kind: 'checkbox', category: 'question', required: true, options: ['Yes', 'No'] },
          { id: 'authorization', label: 'Are you currently authorized to work in the United States?', kind: 'checkbox', category: 'question', required: true, options: ['Yes', 'No'] },
          { id: 'country', label: 'Country*', kind: 'combobox', category: 'question', required: true, options: [] },
        ],
        buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
        pages: [],
        manualSignals: [],
        blocked: false,
        blockedReason: '',
      },
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.status, 'needs-user-input');
    assert.equal(packet.simpleFields.find((field) => field.question === 'Current Location')?.answer, 'Buffalo, NY');
    assert.equal(packet.simpleFields.find((field) => field.question === 'Which country are you working from?')?.answer, 'United States');
    assert.equal(packet.questions.find((field) => field.question.startsWith('Have you worked with Salesforce'))?.status, 'unanswered');
    assert.equal(packet.manualItems.find((field) => field.label.startsWith('Are you open to relocation'))?.reason, 'sensitive or eligibility field — complete manually');
    assert.equal(packet.manualItems.find((field) => field.label.startsWith('Will you now or in the future'))?.reason, 'sensitive or eligibility field — complete manually');
    assert.equal(packet.manualItems.find((field) => field.label.startsWith('Are you currently authorized'))?.reason, 'sensitive or eligibility field — complete manually');
    assert.ok(packet.standardFields.some((field) => field.label === 'Country*'));
    assert.equal(packet.standardFields.some((field) => field.label === 'Country*' && field.answer), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AI usage variants reuse one evidence-backed profile answer', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-ai-usage-'));
  try {
    const ledgerPath = path.join(root, 'question-ledger.json');
    const profilePath = path.join(root, 'application-profile.json');
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    writeFileSync(profilePath, JSON.stringify({
      application_answers: {
        ai_usage: {
          answer: 'I use AI in products and engineering workflows, with human review around the output.',
          source: 'profile:application_answers.ai_usage',
          answerScope: 'question',
          evidenceBacked: true,
          evidenceRefs: ['cv.md', 'article-digest.md'],
        },
      },
    }));
    const item = {
      id: 'packet-ai-usage',
      company: 'Acme',
      title: 'Applied AI Engineer',
      applyUrl: 'https://jobs.example/acme/applied-ai',
      canonicalUrl: 'https://jobs.example/acme/applied-ai',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build reliable AI-enabled products and backend services with TypeScript, Python, evaluation workflows, retrieval, automated tests, and product partners.',
    };
    const inspection = {
      url: item.applyUrl,
      title: 'Apply — Acme',
      heading: 'Applied AI Engineer',
      formCount: 1,
      formReady: true,
      controls: [
        {
          id: 'ai-tools',
          label: 'What AI tools are you currently using today and how are you using them?',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'ai-experiment',
          label: 'How are you using AI today in your current role? If applicable, show us your last AI experiment.',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
      ],
      buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
      pages: [],
      manualSignals: [],
      blocked: false,
      blockedReason: '',
    };
    const packet = await buildApplicationPacket(item, {
      inspection,
      ledgerPath,
      profilePath,
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.status, 'ready-for-human-review');
    assert.equal(packet.questions.length, 2);
    assert.deepEqual(packet.questions.map((question) => question.answer), [
      'I use AI in products and engineering workflows, with human review around the output.',
      'I use AI in products and engineering workflows, with human review around the output.',
    ]);
    assert.deepEqual(packet.questions.map((question) => question.status), ['evidence-backed', 'evidence-backed']);
    assert.equal(packet.questions[0].id, packet.questions[1].id);
    assert.equal(packet.ledger.canonicalQuestionCount, 1);
    assert.equal(packet.unresolved.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('experience prompts reuse distinct evidence-backed profile answers', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-experience-answers-'));
  try {
    const ledgerPath = path.join(root, 'question-ledger.json');
    const profilePath = path.join(root, 'application-profile.json');
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    writeFileSync(profilePath, JSON.stringify({
      application_answers: {
        production_system: {
          answer: 'I built and owned BidCamp end to end as a live closed-beta SaaS.',
          source: 'profile:application_answers.production_system',
          answer_scope: 'question',
          evidence_backed: true,
          evidence_refs: ['cv.md', '/Users/jakyeamos/projects/BidCamp/README.md'],
        },
        agentic_systems: {
          answer: 'Yes. I build and evaluate observable, review-gated agentic systems.',
          source: 'profile:application_answers.agentic_systems',
          answer_scope: 'question',
          evidence_backed: true,
          evidence_refs: ['cv.md', '/Users/jakyeamos/projects/AIOS/README.md'],
        },
        python_production: {
          answer: 'Quality Runner is my clearest published Python CLI and MCP example.',
          source: 'profile:application_answers.python_production',
          answer_scope: 'question',
          evidence_backed: true,
          evidence_refs: ['cv.md', '/Users/jakyeamos/projects/quality-runner/README.md'],
        },
      },
    }));
    const item = {
      id: 'packet-experience-answers',
      company: 'Acme',
      title: 'Applied AI Engineer',
      applyUrl: 'https://jobs.example/acme/applied-ai-experience',
      canonicalUrl: 'https://jobs.example/acme/applied-ai-experience',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build reliable AI-enabled products and Python services with evaluation workflows, automated tests, observability, and product partners across the full delivery lifecycle.',
    };
    const inspection = {
      url: item.applyUrl,
      title: 'Apply — Acme',
      heading: 'Applied AI Engineer',
      formCount: 1,
      formReady: true,
      controls: [
        {
          id: 'production-system',
          label: 'Describe a production, end-user-facing system you owned end-to-end while working closely with Product and UX.',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'agentic-systems',
          label: 'Do you have hands-on experience building or evaluating agentic systems?',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'python-production',
          label: 'Please share an example of a Python project you shipped to production.',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
      ],
      buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
      pages: [],
      manualSignals: [],
      blocked: false,
      blockedReason: '',
    };
    const packet = await buildApplicationPacket(item, {
      inspection,
      ledgerPath,
      profilePath,
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.status, 'ready-for-human-review');
    assert.equal(packet.questions.length, 3);
    assert.deepEqual(packet.questions.map((question) => question.status), ['evidence-backed', 'evidence-backed', 'evidence-backed']);
    assert.equal(packet.unresolved.length, 0);
    assert.deepEqual(packet.questions.map((question) => question.answer), [
      'I built and owned BidCamp end to end as a live closed-beta SaaS.',
      'Yes. I build and evaluate observable, review-gated agentic systems.',
      'Quality Runner is my clearest published Python CLI and MCP example.',
    ]);
    assert.deepEqual(packet.questions.map((question) => question.source), [
      'profile:application_answers.production_system',
      'profile:application_answers.agentic_systems',
      'profile:application_answers.python_production',
    ]);
    assert.deepEqual(packet.questions.map((question) => question.provenance.evidenceRefs), [
      ['profile:application_answers.production_system', 'cv.md', '/Users/jakyeamos/projects/BidCamp/README.md'],
      ['profile:application_answers.agentic_systems', 'cv.md', '/Users/jakyeamos/projects/AIOS/README.md'],
      ['profile:application_answers.python_production', 'cv.md', '/Users/jakyeamos/projects/quality-runner/README.md'],
    ]);
    assert.equal(packet.questions[0].id === packet.questions[1].id, false);
    assert.equal(packet.questions[1].id === packet.questions[2].id, false);
    assert.equal(packet.ledger.canonicalQuestionCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrected application answers resolve experience, identity, and availability prompts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-corrected-answers-'));
  try {
    const ledgerPath = path.join(root, 'question-ledger.json');
    const profilePath = path.join(root, 'application-profile.json');
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    writeFileSync(profilePath, JSON.stringify({
      application_answers: {
        agentic_systems: {
          answer: 'Yes. I have designed and built review-gated LLM-powered and agentic systems.',
          source: 'profile:application_answers.agentic_systems',
          evidence_backed: true,
          evidence_refs: ['cv.md', 'config/project-accomplishment-ledger.json'],
        },
        production_system: {
          answer: 'Yes. I have shipped and operated live production software, including BidCamp.',
          source: 'profile:application_answers.production_system',
          evidence_backed: true,
          evidence_refs: ['cv.md', '/Users/jakyeamos/projects/BidCamp/README.md'],
        },
        customer_delivery: {
          answer: 'Yes. I have built customer-facing demos and proof-of-concepts for client and startup work.',
          source: 'profile:application_answers.customer_delivery',
          evidence_backed: true,
          evidence_refs: ['cv.md', 'config/project-accomplishment-ledger.json'],
        },
        technical_foundations: {
          answer: 'Yes. I have strong Python, JavaScript, and systems fundamentals across product and backend work.',
          source: 'profile:application_answers.technical_foundations',
          evidence_backed: true,
          evidence_refs: ['cv.md', 'article-digest.md'],
        },
        cloud_infrastructure: {
          answer: 'Yes. I have cloud and Docker experience plus working knowledge of basic Kubernetes concepts.',
          source: 'profile:application_answers.cloud_infrastructure',
          answer_status: 'confirmed',
          evidence_backed: false,
          evidence_refs: ['cv.md'],
        },
        most_recent_employer: {
          answer: 'Self-employed / Amazon',
          source: 'profile:application_answers.most_recent_employer',
          answer_status: 'confirmed',
          evidence_backed: false,
          evidence_refs: ['cv.md'],
        },
        most_recent_job_title: {
          answer: 'Software Development Engineer',
          source: 'profile:application_answers.most_recent_job_title',
          answer_status: 'confirmed',
          evidence_backed: false,
          evidence_refs: ['cv.md'],
        },
        availability: {
          answer: 'Soon (as soon as possible)',
          source: 'profile:application_answers.availability',
          answer_status: 'confirmed',
          evidence_backed: false,
          evidence_refs: ['config/profile.yml'],
        },
      },
    }));
    const item = {
      id: 'packet-corrected-answers',
      company: 'Acme',
      title: 'Applied AI Engineer',
      applyUrl: 'https://jobs.example/acme/applied-ai-corrected',
      canonicalUrl: 'https://jobs.example/acme/applied-ai-corrected',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build reliable AI-enabled products with Python, JavaScript, systems design, Docker, cloud services, and production operations.',
    };
    const inspection = {
      url: item.applyUrl,
      title: 'Apply — Acme',
      heading: 'Applied AI Engineer',
      formCount: 1,
      formReady: true,
      controls: [
        {
          id: 'agentic-systems',
          label: 'Have you designed agent-based or LLM-powered applications?',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'production-software',
          label: 'Have you shipped and operated production software?',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'customer-delivery',
          label: 'Have you built customer-facing demos or proof-of-concepts?',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'technical-foundations',
          label: 'Do you have strong Python, JavaScript and systems fundamentals?',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'cloud-infrastructure',
          label: 'Do you have experience with cloud environments, containers, and basic Kubernetes?',
          kind: 'textarea',
          category: 'question',
          required: true,
        },
        {
          id: 'most-recent-employer',
          label: 'Most Recent Employer',
          kind: 'text',
          category: 'question',
          required: true,
        },
        {
          id: 'most-recent-title',
          label: 'Most Recent Job Title',
          kind: 'text',
          category: 'question',
          required: true,
        },
        {
          id: 'start-date',
          label: 'What is the earliest date you can join us?',
          kind: 'text',
          category: 'question',
          required: true,
        },
      ],
      buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
      pages: [],
      manualSignals: [],
      blocked: false,
      blockedReason: '',
    };
    const packet = await buildApplicationPacket(item, {
      inspection,
      ledgerPath,
      profilePath,
      outputRoot: root,
      generateArtifacts: false,
    });
    assert.equal(packet.status, 'ready-for-human-review');
    assert.equal(packet.questions.length, 7);
    assert.equal(packet.simpleFields.length, 1);
    assert.equal(packet.unresolved.length, 0);
    assert.deepEqual(packet.questions.map((question) => question.status), [
      'evidence-backed',
      'evidence-backed',
      'evidence-backed',
      'evidence-backed',
      'confirmed',
      'confirmed',
      'confirmed',
    ]);
    assert.equal(packet.simpleFields[0].answer, 'Soon (as soon as possible)');
    assert.equal(packet.simpleFields[0].status, 'confirmed');
    assert.deepEqual(packet.questions.map((question) => question.answer), [
      'Yes. I have designed and built review-gated LLM-powered and agentic systems.',
      'Yes. I have shipped and operated live production software, including BidCamp.',
      'Yes. I have built customer-facing demos and proof-of-concepts for client and startup work.',
      'Yes. I have strong Python, JavaScript, and systems fundamentals across product and backend work.',
      'Yes. I have cloud and Docker experience plus working knowledge of basic Kubernetes concepts.',
      'Self-employed / Amazon',
      'Software Development Engineer',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet resolves corrected profile questions, groups referrals, and routes acknowledgements to review', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-profile-corrections-'));
  try {
    const ledgerPath = path.join(root, 'question-ledger.json');
    const profilePath = path.join(root, 'application-profile.json');
    writeFileSync(ledgerPath, '{"schemaVersion":2,"entries":[]}\n');
    const evidence = (answer, refs) => ({
      answer,
      source: 'career-ops-evidence:test',
      answer_scope: 'question',
      answer_status: 'evidence-backed',
      evidence_backed: true,
      evidence_refs: refs,
    });
    writeFileSync(profilePath, JSON.stringify({
      identity: { pronouns: 'He/Him', phone: '716-578-8221' },
      address: { city: 'Buffalo', state: 'NY', country: 'United States' },
      application_answers: {
        anthropic_interview: { answer: 'No', source: 'user-confirmed', answer_status: 'confirmed' },
        glean_relationship: { answer: 'No', source: 'user-confirmed', answer_status: 'confirmed' },
        hybrid_work: { answer: 'Yes', source: 'user-confirmed', answer_status: 'confirmed' },
        dutch_proficiency: { answer: 'No', source: 'user-confirmed', answer_status: 'confirmed', evidence_backed: false },
        located_in_us: evidence('Yes', ['config/application-profile.json']),
        located_in_north_america: evidence('Yes', ['config/application-profile.json']),
        located_in_bay_area: evidence('No', ['config/application-profile.json']),
        restricted_state_residence: evidence('No', ['config/application-profile.json']),
        sentry_experience: evidence('Yes. I have used Sentry in Tenure.', ['/Users/jakyeamos/projects/tenure/README.md']),
        llm_evaluation: evidence('Yes. I have worked with LLM evaluation, observability, and guardrails.', ['cv.md', '/Users/jakyeamos/projects/agent-eval-runtime/README.md']),
        recent_code_commit: { answer: 'Today', source: 'user-confirmed', answer_status: 'confirmed' },
        programming_languages: evidence('TypeScript, JavaScript, Python, Java, Go, SQL, R, and MATLAB; BidCamp is my most complex application.', ['cv.md', '/Users/jakyeamos/projects/BidCamp/README.md']),
        main_development_language: evidence('TypeScript', ['cv.md']),
      },
    }));
    const item = {
      id: 'packet-profile-corrections',
      company: 'Acme',
      title: 'Applied AI Engineer',
      applyUrl: 'https://jobs.example/acme/applied-ai-profile-corrections',
      canonicalUrl: 'https://jobs.example/acme/applied-ai-profile-corrections',
      liveness: 'active',
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      description: 'Build reliable AI-enabled products with TypeScript, Python, Sentry, LLM evaluation, observability, cloud services, and production operations across customer-facing systems.',
    };
    const inspection = {
      url: item.applyUrl,
      title: 'Apply — Acme',
      heading: 'Applied AI Engineer',
      formCount: 1,
      formReady: true,
      controls: [
        { id: 'anthropic', label: 'Have you ever interviewed at Anthropic before?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'hybrid', label: 'Are you open to working in-person in one of our offices 25% of the time?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'city-office', label: 'Are you willing to work from NYC or San Francisco 2–3 days per week?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'nyc-option-group', label: 'NYC', kind: 'radio', category: 'question', required: true, options: ['Yes | I will relocate to the broader NYC area upon offer acceptance and comfortable being in the NY office at least 3 days/week', 'Yes | Currently located in the broader NYC area and comfortable being in the NY office at least 3 days/week', 'No | I am seeking a remote role'] },
        { id: 'us-location', label: 'Are you located in the United States?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'north-america', label: 'Are you located in North America?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'bay-area', label: 'Are you located in the San Francisco Bay Area?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'restricted-state', label: 'Do you live in one of the following states?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'glean', label: 'Do you know anyone currently at Glean?', kind: 'combobox', category: 'question', required: true, options: ['Yes', 'No'] },
        { id: 'sentry', label: 'Have you ever used Sentry before?', kind: 'textarea', category: 'question', required: true },
        { id: 'llm', label: 'Have you worked with LLM evaluation, observability, or guardrails?', kind: 'textarea', category: 'question', required: true },
        { id: 'commit', label: 'How long since you last committed non-personal code to a repository?', kind: 'text', category: 'question', required: true },
        { id: 'languages', label: 'Which programming languages do you know, and what was your most complex application?', kind: 'textarea', category: 'question', required: true },
        { id: 'main-language', label: 'What is your main development language?', kind: 'text', category: 'question', required: true },
        { id: 'pronouns', label: 'Pronouns', kind: 'text', category: 'question', required: true },
        { id: 'phone', label: 'Contact number', kind: 'tel', category: 'question', required: true },
        { id: 'referral-one', label: 'How did you hear about Glean?', kind: 'combobox', category: 'question', required: true, options: ['Job board', 'Referral', 'Other'] },
        { id: 'referral-two', label: 'How did you hear about this opportunity? — 3How did you hear about this position? — 3', kind: 'combobox', category: 'question', required: true, options: ['Job board', 'Referral', 'Other'] },
        { id: 'dutch', label: 'Do you speak Dutch at C1/C2 level or higher?', kind: 'textarea', category: 'question', required: true },
        { id: 'privacy', label: 'Celonis Privacy Notice confirmation', kind: 'checkbox', category: 'question', required: true },
        { id: 'policy', label: 'AI Policy for Application', kind: 'checkbox', category: 'question', required: true },
        { id: 'double-check', label: 'Please double-check all the information provided above.', kind: 'checkbox', category: 'question', required: true },
        { id: 'london', label: 'Are you available to work full-time onsite at our London office?', kind: 'checkbox', category: 'question', required: true },
      ],
      buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
      pages: [],
      manualSignals: [],
      blocked: false,
      blockedReason: '',
    };
    const packet = await buildApplicationPacket(item, {
      inspection,
      ledgerPath,
      profilePath,
      outputRoot: root,
      generateArtifacts: false,
    });
    const fields = [...packet.questions, ...packet.simpleFields];
    const field = (label) => fields.find((entry) => entry.question === label);
    assert.equal(packet.status, 'needs-user-input');
    assert.equal(field('Have you ever interviewed at Anthropic before?').answer, 'No');
    assert.equal(field('Are you open to working in-person in one of our offices 25% of the time?').answer, 'Yes');
    assert.equal(field('Are you willing to work from NYC or San Francisco 2–3 days per week?').answer, 'Yes');
    assert.equal(field('NYC').answer, 'Yes | I will relocate to the broader NYC area upon offer acceptance and comfortable being in the NY office at least 3 days/week');
    assert.equal(field('Are you located in the United States?').answer, 'Yes');
    assert.equal(field('Are you located in North America?').answer, 'Yes');
    assert.equal(field('Are you located in the San Francisco Bay Area?').answer, 'No');
    assert.equal(field('Do you know anyone currently at Glean?').answer, 'No');
    assert.equal(field('Have you ever used Sentry before?').status, 'evidence-backed');
    assert.equal(field('Have you worked with LLM evaluation, observability, or guardrails?').status, 'evidence-backed');
    assert.equal(field('How long since you last committed non-personal code to a repository?').answer, 'Today');
    assert.equal(field('Which programming languages do you know, and what was your most complex application?').status, 'evidence-backed');
    assert.equal(field('What is your main development language?').answer, 'TypeScript');
    assert.equal(field('Pronouns').answer, 'He/Him');
    assert.equal(packet.standardFields.find((entry) => entry.label === 'Contact number')?.label, 'Contact number');
    assert.equal(field('Do you speak Dutch at C1/C2 level or higher?').answer, 'No');
    assert.equal(field('Do you speak Dutch at C1/C2 level or higher?').status, 'confirmed');
    assert.equal(packet.simpleUnresolved.filter((entry) => entry.question.startsWith('How did you hear about')).length, 2);
    assert.equal(packet.manualItems.some((entry) => entry.label === 'Celonis Privacy Notice confirmation'), true);
    assert.equal(packet.manualItems.some((entry) => entry.label === 'AI Policy for Application'), true);
    assert.equal(packet.manualItems.some((entry) => entry.label.startsWith('Please double-check')), true);
    assert.equal(packet.manualItems.some((entry) => entry.label.includes('London office')), true);
    assert.equal(packet.questions.some((entry) => /Privacy Notice|AI Policy|double-check|London office/i.test(entry.question)), false);
    assert.equal(packet.ledger.canonicalQuestionCount, 17);
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
    assert.equal(packet.copyQuality.status, 'passed');
    assert.equal(packet.copyQuality.finalReady, true);
    assert.equal(packet.questions[0].copyQuality.status, 'passed');
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

function contactDiscoveryPacketItem(fitScore, suffix) {
  return {
    id: `packet-contact-${suffix}`,
    company: 'Acme',
    title: 'Backend Engineer',
    location: 'New York, NY',
    applyUrl: `https://jobs.example/acme/backend-${suffix}`,
    canonicalUrl: `https://jobs.example/acme/backend-${suffix}`,
    liveness: 'active',
    fitScore,
    firstSeenAt: '2026-07-29T00:00:00.000Z',
    description: 'Build Python and TypeScript backend services, REST APIs, data pipelines, PostgreSQL workflows, automated tests, and reliable production systems with product and engineering partners.',
  };
}

function contactDiscoveryInspection(item) {
  return {
    url: item.applyUrl,
    title: 'Apply — Acme',
    heading: item.title,
    formCount: 1,
    formReady: true,
    controls: [],
    buttons: [{ text: 'Submit application', submitLike: true, nextLike: false, blockedLike: false, disabled: false }],
    pages: [],
    manualSignals: [],
    blocked: false,
    blockedReason: '',
  };
}

test('packet prep runs contact discovery at the 4.3 floor and reports evidence without authorizing outreach', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-contact-floor-'));
  const item = contactDiscoveryPacketItem(4.3, 'floor');
  const calls = [];
  try {
    const packet = await buildApplicationPacket(item, {
      inspection: contactDiscoveryInspection(item),
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
      contactDiscoveryRunner: async (target) => {
        calls.push(target.id);
        return {
          status: 'found',
          pipelineVersion: 11,
          mode: 'packet-prep',
          reason: 'verified public employer contact',
          contacts: [{
            name: 'Ada Lovelace',
            role: 'Engineering Manager',
            email: 'ada@acme.example',
            emailVerified: true,
            sourceUrl: 'https://acme.example/team',
          }],
          sources: ['https://acme.example/team'],
          queries: [],
          errors: [],
          warnings: [],
        };
      },
    });

    assert.deepEqual(calls, [item.id]);
    assert.equal(packet.contactDiscovery.outcome, 'found');
    assert.equal(packet.contactDiscovery.threshold, 4.3);
    assert.equal(packet.contactDiscovery.sendAuthorized, false);
    assert.equal(packet.contactDiscovery.submissionGate, 'confirmed-submission-required');
    assert.match(packet.markdown, /Contact research/);
    assert.match(packet.markdown, /Ada Lovelace/);
    assert.match(packet.markdown, /does not authorize outreach/);
    assert.equal('draft' in packet.contactDiscovery, false);
    assert.equal('message' in packet.contactDiscovery, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet prep below 4.3 does not consume contact discovery', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-contact-below-floor-'));
  const item = contactDiscoveryPacketItem(4.2, 'below-floor');
  let called = false;
  try {
    const packet = await buildApplicationPacket(item, {
      inspection: contactDiscoveryInspection(item),
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
      contactDiscoveryRunner: async () => {
        called = true;
        throw new Error('discovery must not run below the approved floor');
      },
    });

    assert.equal(called, false);
    assert.equal(packet.contactDiscovery.outcome, 'not-eligible');
    assert.equal(packet.contactDiscovery.threshold, 4.3);
    assert.match(packet.contactDiscovery.reason, /below the 4\.3 contact-discovery floor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('contact discovery unavailability never blocks packet completion', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-contact-unavailable-'));
  const item = contactDiscoveryPacketItem(4.7, 'unavailable');
  try {
    const packet = await buildApplicationPacket(item, {
      inspection: contactDiscoveryInspection(item),
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
      contactDiscoveryRunner: async () => {
        throw new Error('provider rate limit');
      },
    });

    assert.equal(packet.ok, true);
    assert.equal(packet.status, 'ready-for-human-review');
    assert.equal(packet.contactDiscovery.outcome, 'unavailable');
    assert.match(packet.contactDiscovery.reason, /provider rate limit/);
    assert.match(packet.markdown, /Unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet prep reuses a valid cached discovery snapshot', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'career-ops-packet-contact-cache-'));
  const item = {
    ...contactDiscoveryPacketItem(4.5, 'cache'),
    outreach: {
      discovery: {
        pipelineVersion: OUTREACH_DISCOVERY_PIPELINE_VERSION,
        status: 'found',
        attemptedAt: '2026-07-29T12:00:00.000Z',
        cacheExpiresAt: '2099-08-01T00:00:00.000Z',
        contacts: [{
          name: 'Grace Hopper',
          role: 'Technical Recruiter',
          email: 'grace@acme.example',
          emailVerified: true,
          sourceUrl: 'https://acme.example/careers',
        }],
        sources: ['https://acme.example/careers'],
        queries: [],
        errors: [],
        warnings: [],
      },
    },
  };
  try {
    const packet = await buildApplicationPacket(item, {
      inspection: contactDiscoveryInspection(item),
      ledgerPath: path.join(root, 'question-ledger.json'),
      outputRoot: root,
      generateArtifacts: false,
    });

    assert.equal(packet.contactDiscovery.outcome, 'found');
    assert.equal(packet.contactDiscovery.cacheReused, true);
    assert.equal(packet.contactDiscovery.contacts[0].name, 'Grace Hopper');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
