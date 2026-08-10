import test from 'node:test';
import assert from 'node:assert/strict';

import { archiveStub } from '../queue-archive.mjs';
import { questionId } from '../apply/question-ledger.mjs';
import { handoffSessionPayload, isCheckboxQuestion, publicCivicDiscovery, questionPayload, queuePayload } from '../queue-ui.mjs';

/** @param {Record<string, unknown>} overrides */
function item(overrides) {
  return {
    id: 'x',
    company: 'Acme',
    title: 'Backend Engineer',
    applyUrl: 'https://example.com/jobs/1',
    canonicalUrl: 'https://example.com/jobs/1',
    status: 'ready',
    fitScore: 4.5,
    freshness: 'fresh',
    ...overrides,
  };
}

test('dead-end counts come from the archived index, not from live items', () => {
  const payload = queuePayload({
    items: [
      item({ id: 'a', status: 'ready' }),
      item({ id: 'b', status: 'in_review' }),
      item({ id: 'c', status: 'stale' }),
      item({ id: 'd', status: 'skipped' }),
    ],
    archivedIndex: [
      archiveStub(item({ id: 'e', status: 'excluded' }), '2026-07-10T00:00:00.000Z'),
      archiveStub(item({ id: 'f', status: 'excluded' }), '2026-07-10T00:00:00.000Z'),
      archiveStub(item({ id: 'g', status: 'archived' }), '2026-07-10T00:00:00.000Z'),
    ],
  });
  assert.equal(payload.totals.excluded, 2);
  assert.equal(payload.totals.archived, 1);
  assert.equal(payload.totals.stale, 1);
  assert.equal(payload.totals.skipped, 1);
  assert.equal(payload.totals.filtered, 5);
  assert.equal(payload.totals.retained, 7);
});

test('the payload does not ship the archived stub array to the browser', () => {
  const payload = queuePayload({
    items: [],
    archivedIndex: [archiveStub(item({ id: 'e', status: 'excluded' }), '2026-07-10T00:00:00.000Z')],
  });
  assert.equal(payload.archivedIndex, undefined);
});

test('a queue with no archived index reports zero filtered', () => {
  const payload = queuePayload({ items: [item({ id: 'a', status: 'ready' })] });
  assert.equal(payload.totals.filtered, 0);
  assert.equal(payload.totals.retained, 1);
});

test('queue payload exposes civic discovery as a separate additive surface', () => {
  const civic = {
    status: 'ready',
    counts: { currentRoles: 1, outreachTargets: 1, staleLeads: 1, total: 3 },
    currentRoles: [{ id: 'role', lane: 'current-role' }],
    outreachTargets: [{ id: 'target', lane: 'outreach-target' }],
    staleLeads: [{ id: 'stale', lane: 'stale-lead' }],
    rules: { applicationTracker: false, autoContact: false, autoSubmit: false, verifyBeforeAction: true },
  };
  const payload = queuePayload({ items: [] }, { records: [], outbox: [], settings: {}, lastProcess: null }, civic);

  assert.deepEqual(payload.civic, civic);
  assert.equal(payload.selected.length, 0);
  assert.equal(payload.totals.retained, 0);
});

test('live civic discovery is available to the queue UI without tracker records', () => {
  const civic = publicCivicDiscovery();

  assert.equal(civic.status, 'ready');
  assert.equal(civic.rules.applicationTracker, false);
  assert.equal(civic.rules.autoContact, false);
  assert.equal(civic.rules.autoSubmit, false);
  assert.equal(civic.counts.currentRoles, civic.currentRoles.length);
  assert.equal(civic.counts.outreachTargets, civic.outreachTargets.length);
  assert.equal(civic.counts.staleLeads, civic.staleLeads.length);
  assert.equal(civic.counts.dismissed, civic.dismissed.length);
  assert.ok(civic.currentRoles.every((record) => record.civicKey));
});

test('queue payload preserves Handshake source health for the visible queue status', () => {
  const payload = queuePayload({
    items: [],
    lastRun: {
      sources: {
        handshake: { candidates: 2, errors: 1, status: 'cache-only-or-unavailable', observedAt: '2026-08-07T12:00:00.000Z' },
      },
    },
  });
  assert.deepEqual(payload.lastRun.sources.handshake, {
    candidates: 2,
    errors: 1,
    status: 'cache-only-or-unavailable',
    observedAt: '2026-08-07T12:00:00.000Z',
  });
});

test('handoff payload preserves a producer failure instead of presenting a false empty state', () => {
  const payload = handoffSessionPayload({
    status: 'failed',
    error: 'Chrome could not be started',
    preparation: [{ id: 'one', company: 'Acme', title: 'Backend Engineer', ok: false, reason: 'Chrome could not be started' }],
    pages: [],
  });

  assert.equal(payload.status, 'failed');
  assert.equal(payload.error, 'Chrome could not be started');
  assert.deepEqual(payload.preparation, [{
    id: 'one',
    company: 'Acme',
    title: 'Backend Engineer',
    state: null,
    ok: false,
    reason: 'Chrome could not be started',
  }]);
  assert.deepEqual(payload.pages, []);
});

test('outreach browser payload exposes Gmail routing status without email bodies', () => {
  const payload = queuePayload({ items: [] });
  for (const record of payload.outreach || []) {
    for (const contact of record.contacts || []) {
      assert.equal('initialBody' in contact, false);
      assert.equal('initialSubject' in contact, false);
      if (contact.emailVerificationState === 'blocked-provider-address') {
        assert.equal(contact.email, null);
        assert.equal(contact.emailEligible, false);
      }
      if (contact.initialEmailNotification) {
        assert.equal(typeof contact.initialEmailNotification.recipient, 'string');
        assert.equal(typeof contact.initialEmailNotification.subject, 'string');
      }
      if (!record.submissionConfirmed || ['paused', 'suppressed'].includes(record.status)) {
        assert.equal(contact.linkedinDraft, '');
        assert.equal(contact.linkedinDraftQualityPassed, false);
        assert.equal(contact.xDraft, '');
        assert.equal(contact.xDraftQualityPassed, false);
      }
    }
  }
});

test('unconfirmed outreach contacts never enter the browser payload', () => {
  const payload = queuePayload({ items: [] }, {
    records: [
      {
        key: 'pending',
        company: 'Pending Co',
        title: 'Backend Engineer',
        status: 'awaiting_submission_confirmation',
        submission: { confirmed: false },
        contacts: [{ name: 'Pending Contact', email: 'pending@example.com' }],
      },
      {
        key: 'confirmed',
        company: 'Confirmed Co',
        title: 'Backend Engineer',
        status: 'awaiting_contacts',
        submission: { confirmed: true },
        contacts: [{ name: 'Confirmed Contact', email: 'confirmed@example.com' }],
      },
    ],
    outbox: [],
    settings: {},
    lastProcess: null,
  });

  assert.deepEqual(payload.outreach.map((record) => record.key), ['confirmed']);
  assert.deepEqual(payload.outreach[0].contacts.map((contact) => contact.name), ['Confirmed Contact']);
});

test('privacy acknowledgements remain in handoff review but stay out of the answer queue', () => {
  const payload = queuePayload({
    items: [item({
      id: 'privacy-review',
      applicationState: 'blocked_by_question',
      applicationResult: {
        needsReview: [
          {
            label: "Legal: I understand the information I submit will be used in accordance with Sentry's Applicant Privacy Policy.",
            reason: 'legal attestation or background question — answer manually',
          },
          {
            label: 'Why do you want to join Sentry?',
            reason: 'required field needs an answer',
          },
        ],
      },
    })],
  });

  assert.deepEqual(payload.questions.map((question) => question.question), ['Why do you want to join Sentry?']);
  assert.equal(payload.totals.handoffs, 1);
});

test('EEO demographic blockers remain human-only and never enter the answer queue', () => {
  const payload = queuePayload({
    items: [item({
      id: 'eeo-review',
      applicationState: 'blocked_by_human',
      applicationResult: {
        needsReview: [{
          label: 'EEO: Race',
          reason: 'voluntary self-identification — fill it yourself',
        }],
      },
    })],
  });

  assert.deepEqual(payload.questions, []);
  assert.equal(payload.totals.questions, 0);
  assert.equal(payload.totals.handoffs, 1);
});

test('answerable questions propagate even when a legal field makes the handoff human-blocked', () => {
  const payload = queuePayload({
    items: [item({
      id: 'mixed-review',
      status: 'in_review',
      applicationState: 'blocked_by_human',
      applicationResult: {
        needsReview: [
          {
            label: 'Legal: Background Check Consent',
            reason: 'legal attestation or background question — answer manually',
          },
          {
            label: 'Text message consent',
            reason: 'consent choice requires human review',
          },
          {
            label: 'In what cities are you available to work?',
            reason: 'required field needs an answer',
            required: true,
          },
        ],
      },
    })],
  });

  assert.deepEqual(payload.questions.map((question) => question.question), ['In what cities are you available to work?']);
  assert.equal(payload.totals.questions, 1);
});

test('confirmed ledger answers disappear from the question payload immediately', () => {
  const question = 'Why do you want to join Acme?';
  const id = questionId(question);
  const answeredLedger = {
    entries: [{
      id,
      question,
      pattern: question,
      answer: 'I value the product and the engineering problems.',
      status: 'answered',
      scope: 'question',
      sensitivity: 'normal',
      answerStatus: 'confirmed',
      answerSource: 'user',
      answerVersion: 1,
      fieldKind: 'textarea',
      options: [],
      answerVariants: [
        {
          answer: 'An older evidence-backed draft.',
          answerStatus: 'evidence-backed',
          answerSource: 'career-ops-evidence',
          answerVersion: 1,
          scope: 'question',
        },
        {
          answer: 'I value the product and the engineering problems.',
          answerStatus: 'confirmed',
          answerSource: 'user',
          answerVersion: 2,
          scope: 'question',
        },
      ],
    }],
  };
  const blockedItem = item({
    id: 'answered-question',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{ label: question, kind: 'textarea', reason: 'required field needs an answer' }],
    },
  });

  assert.deepEqual(questionPayload([blockedItem], answeredLedger), []);
});

test('captured checkbox questions are exposed as multi-answer controls', () => {
  const payload = questionPayload([item({
    id: 'multi-question',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{
        label: 'Which authentication methods have you worked with?',
        kind: 'checkbox',
        options: ['API keys', 'OAuth 2.0', 'JWT', 'Basic auth', 'Webhooks', 'Other', 'None'],
        required: true,
      }],
    },
  })], { entries: [] }, {});

  assert.equal(payload[0].kind, 'checkbox');
  assert.equal(payload[0].multiple, true);
  assert.equal(isCheckboxQuestion('radio', ['Yes', 'No']), false);
});

test('select wording infers a choice control when an adapter omitted the field kind', () => {
  const payload = questionPayload([item({
    id: 'select-wording-question',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{
        label: "Which campus event did you attend? (Select 'Not applicable' if you haven't attended one yet)",
        options: [],
        required: true,
      }],
    },
  })], { entries: [] }, {});

  assert.equal(payload[0].kind, 'select');
  assert.equal(payload[0].multiple, false);
});

test('combobox questions remain choice-shaped when option capture is temporarily empty', () => {
  const payload = questionPayload([item({
    id: 'empty-combobox-question',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{
        label: 'Which campus event did you attend?',
        kind: 'combobox',
        options: [],
        required: true,
      }],
    },
  })], { entries: [] }, {});

  assert.equal(payload[0].kind, 'combobox');
  assert.equal(payload[0].multiple, false);
});

test('required-marker reconciliation cannot downgrade a duplicated choice question', () => {
  const payload = questionPayload([item({
    id: 'required-marker-duplicate',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [
        {
          label: 'Degree',
          kind: 'combobox',
          options: [],
          required: true,
        },
        {
          label: 'Degree*',
          reason: 'required field needs an answer',
          options: [],
          required: true,
        },
      ],
    },
  })], { entries: [] });

  assert.equal(payload.length, 1);
  assert.equal(payload[0].question, 'Degree');
  assert.equal(payload[0].kind, 'combobox');
  assert.equal(payload[0].multiple, false);
});

test('checkbox-backed Yes/No questions are single-choice and omit the browser transport value', () => {
  const payload = questionPayload([item({
    id: 'binary-question',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{
        label: 'Have you contributed to open-source projects before?',
        kind: 'checkbox',
        options: ['on', 'Yes', 'No', 'Yes'],
        required: true,
      }],
    },
  })], { entries: [] }, {});

  assert.deepEqual(payload[0].options, ['Yes', 'No']);
  assert.equal(payload[0].kind, 'checkbox');
  assert.equal(payload[0].multiple, false);
  assert.equal(isCheckboxQuestion('checkbox', ['on', 'Yes', 'No']), false);
});

test('conditional Yes follow-ups render as one binary question with a dependent short answer', () => {
  const compound = 'Have you contributed to open-source projects before? Multiple choice: Yes / No Yes Share an example of an open-source contribution.';
  const payload = questionPayload([item({
    id: 'conditional-follow-up',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [
        {
          label: compound,
          kind: 'textarea',
          required: true,
        },
        {
          label: 'Have you contributed to open-source projects before?',
          kind: 'checkbox',
          options: ['on', 'Yes', 'No'],
          required: true,
        },
      ],
    },
  })], { entries: [] }, {});

  assert.equal(payload.length, 1);
  assert.equal(payload[0].question, 'Have you contributed to open-source projects before?');
  assert.deepEqual(payload[0].options, ['Yes', 'No']);
  assert.equal(payload[0].multiple, false);
  assert.deepEqual(payload[0].followUp, {
    id: questionId(compound),
    question: 'Share an example of an open-source contribution.',
    trigger: 'Yes',
    required: true,
    queueId: 'conditional-follow-up',
    queueIds: ['conditional-follow-up'],
  });
});

test('a bare Greenhouse country blocker explains that it is the phone-country selector', () => {
  const payload = questionPayload([item({
    id: 'greenhouse-country',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{ label: 'Country*', kind: 'combobox', required: true }],
    },
  })], { entries: [] }, {});

  assert.equal(payload[0].context, 'Phone-number country code — not nationality or country of origin.');
});

test('company-motivation questions are always posting scoped', () => {
  const payload = questionPayload([item({
    id: 'motivation',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{ label: 'Why do you want to join Acme?', kind: 'textarea', required: true }],
    },
  })], { entries: [] });

  assert.equal(payload[0].scope, 'posting');
});

test('job-aware motivation answers remove a bare company question from the queue', () => {
  const payload = questionPayload([item({
    company: 'Acme AI',
    title: 'Safety Engineer',
    description: 'Our mission is to build reliable and interpretable AI. This role develops classifiers to detect misuse, evaluates agentic risks, and deploys mitigations for prompt injection attacks.',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{ label: 'Why Acme AI?', kind: 'textarea', required: true }],
    },
  })], { entries: [] }, {
    application_answers: {
      llm_evaluation: {
        answer: 'I built LLM evaluation, observability, and guardrail workflows using benchmarks and human review.',
        evidenceBacked: true,
        evidenceRefs: ['cv.md'],
      },
    },
  });

  assert.deepEqual(payload, []);
});

test('weak or missing job evidence leaves the bare company question visible', () => {
  const payload = questionPayload([item({
    company: 'Acme Payroll',
    title: 'Office Coordinator',
    description: 'We support a friendly office and value organization, punctuality, and clear communication. The coordinator keeps calendars current, welcomes visitors, and helps the team stay organized each day.',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{ label: 'Why Acme Payroll?', kind: 'textarea', required: true }],
    },
  })], { entries: [] }, {
    application_answers: {
      llm_evaluation: {
        answer: 'I built LLM evaluation, observability, and guardrail workflows using benchmarks and human review.',
        evidenceBacked: true,
        evidenceRefs: ['cv.md'],
      },
    },
  });

  assert.equal(payload.length, 1);
  assert.equal(payload[0].question, 'Why Acme Payroll?');
});

test('unresolved review questions never expose a draft as a prefilled answer', () => {
  const question = 'Tell us about a difficult production incident.';
  const payload = questionPayload([item({
    id: 'unresolved-draft',
    applicationState: 'blocked_by_question',
    applicationResult: {
      needsReview: [{ label: question, kind: 'textarea', required: true }],
    },
  })], {
    entries: [{
      id: questionId(question),
      question,
      pattern: question,
      answer: 'An unconfirmed draft.',
      answerStatus: 'unconfirmed',
      scope: 'question',
      sensitivity: 'normal',
      fieldKind: 'textarea',
      answerVariants: [{
        answer: 'An unconfirmed draft.',
        answerStatus: 'unconfirmed',
        scope: 'question',
      }],
    }],
  });

  assert.equal(payload.length, 1);
  assert.equal('answer' in payload[0], false);
  assert.equal('suggestedAnswer' in payload[0], false);
});

test('evidence-backed experience answers are removed from the queue while unknown prompts remain', () => {
  const safetyQuestion = 'Please write a few sentences about your most impactful AI Safety focused work that is relevant for this role.';
  const profile = {
    application_answers: {
      llm_evaluation: {
        answer: 'I have hands-on experience with LLM evaluation, observability, and guardrails.',
        evidenceBacked: true,
      },
    },
  };
  const known = questionPayload([item({
    id: 'known-safety-work',
    company: 'Anthropic',
    title: 'ML/Research Engineer, Safeguards',
    lane: 'backend_ai_platform',
    applicationState: 'blocked_by_human',
    applicationResult: { needsReview: [{ label: safetyQuestion, kind: 'textarea', required: true }] },
  })], { entries: [] }, profile);
  assert.deepEqual(known, []);

  const unknownQuestion = 'Tell us about a difficult production incident.';
  const unknown = questionPayload([item({
    id: 'unknown-experience',
    applicationState: 'blocked_by_question',
    applicationResult: { needsReview: [{ label: unknownQuestion, kind: 'textarea', required: true }] },
  })], { entries: [] }, profile);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].question, unknownQuestion);
});
