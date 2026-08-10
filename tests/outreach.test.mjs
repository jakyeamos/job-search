import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGmailClient, GMAIL_REQUIRED_SCOPES, GMAIL_SEND_SCOPE, TARGET_GMAIL_ACCOUNT } from '../gmail-client.mjs';
import {
  addBusinessDays,
  authorizeOutreachBatch,
  buildEmailMessage,
  buildLinkedInDraft,
  discoveryCacheTtlMs,
  ensureOutboxEntry,
  hasConfirmedSubmission,
  isOutboxEntryAuthorized,
  iterateRecipientContentCollisions,
  loadOutreachState,
  matchesApplicationConfirmation,
  outboxEntryDue,
  outboxNextAttemptAt,
  outreachMessageId,
  rankContacts,
  refreshSendAuthorization,
  retainDiscoveryContacts,
  recordSubmissionSignal,
  selectContacts,
  summarizeOutbox,
  messageFingerprint,
  messageForSend,
  outreachContentSimilarity,
  followUpSuppressed,
  isProviderGeneratedContactEmail,
  validateMessage,
} from '../outreach-lib.mjs';
import { runRdwArtifactCheck, validateRdwArtifactReceipt } from '../rdw-writing.mjs';
import { prepareOutreachDraft, validateOutreachDraftReceipt } from '../outreach-draft-quality.mjs';

const item = {
  id: 'role-1',
  company: 'Example AI',
  title: 'Backend AI Engineer',
  location: 'Remote US',
  description: 'Build backend APIs, data pipelines, and applied AI workflows.',
  applyUrl: 'https://jobs.example.com/roles/backend-ai',
  lane: 'backend_ai_platform',
  fitScore: 4.5,
};

const profile = {
  candidate: { full_name: 'Jakye Amos', portfolio_url: 'https://jakye.netlify.app/' },
  narrative: {
    proof_points: [
      'Three Amazon SDE internships across Ads and FinTech/business-systems teams',
      'Built Tenure, a LaunchNY cohort organizational-intelligence platform',
    ],
  },
};

function verifiedContact(overrides = {}) {
  return {
    name: 'Taylor Example',
    title: 'Engineering Manager',
    company: 'Example AI',
    email: 'taylor@example.ai',
    emailVerified: true,
    publicProfessional: true,
    sourceType: 'company-site',
    sourceUrl: 'https://example.ai/team/taylor',
    profileUrl: 'https://www.linkedin.com/in/taylor-example',
    roleRelevance: 'high',
    ...overrides,
  };
}

test('live batch preparation persists social drafts while dry runs stay read-only', () => {
  const source = readFileSync(path.resolve('outreach.mjs'), 'utf8');
  assert.match(source, /if \(item\) prepareRecord\(\s*state,\s*item,\s*dryRun,/);
  assert.doesNotMatch(source, /if \(item\) prepareRecord\(\s*state,\s*item,\s*true,/);
});

test('contact ranking keeps public professional emails and rejects guessed/private addresses', () => {
  const contacts = rankContacts([
    verifiedContact(),
    verifiedContact({ name: 'Generic Recruiter', title: 'Recruiter', email: 'generic@example.ai', sourceType: 'public-profile', sourceUrl: 'https://www.linkedin.com/in/generic-recruiter' }),
    verifiedContact({ name: 'Guessed Person', email: 'guessed@example.ai', guessed: true }),
    verifiedContact({ name: 'Private Person', email: 'private@gmail.com', sourceType: 'user-provided', sourceUrl: 'https://www.linkedin.com/in/private-person', profileUrl: 'https://www.linkedin.com/in/private-person' }),
    verifiedContact({ name: 'Peer Example', title: 'Software Engineer', email: 'peer@example.ai', sourceUrl: 'https://example.ai/team/peer', profileUrl: 'https://www.linkedin.com/in/peer-example' }),
    verifiedContact({ name: 'Other Company', company: 'Other Co' }),
  ], item);
  assert.equal(contacts.filter((contact) => contact.emailVerified).length, 3);
  assert.equal(contacts.find((contact) => contact.name === 'Guessed Person')?.email, null);
  assert.equal(contacts.find((contact) => contact.name === 'Private Person')?.email, null);
  assert.equal(contacts.some((contact) => contact.name === 'Other Company'), false);
  assert.equal(rankContacts([verifiedContact({ title: 'Technical Recruitment Manager' })], item)[0].type, 'recruiter');
  assert.equal(selectContacts(contacts, 2).length, 2);
});

test('contact ranking preserves verified X profiles as manual outreach channels', () => {
  const [contact] = rankContacts([verifiedContact({
    email: null,
    emailVerified: false,
    sourceType: 'public-profile',
    sourceUrl: 'https://x.com/taylor_example',
    profileUrl: null,
    xProfileUrl: 'https://x.com/taylor_example',
    xHandle: '@taylor_example',
  })], item);

  assert.equal(contact.emailEligible, false);
  assert.equal(contact.xProfileUrl, 'https://x.com/taylor_example');
  assert.equal(contact.xHandle, '@taylor_example');
});

test('contact ranking treats LinkedIn-only candidates as the weakest outreach fallback', () => {
  const contacts = rankContacts([
    verifiedContact({
      name: 'LinkedIn Manager',
      email: null,
      emailVerified: false,
      sourceType: 'public-profile',
      sourceUrl: 'https://www.linkedin.com/in/linkedin-manager',
      profileUrl: 'https://www.linkedin.com/in/linkedin-manager',
    }),
    verifiedContact({
      name: 'X Manager',
      email: null,
      emailVerified: false,
      sourceType: 'public-profile',
      sourceUrl: 'https://x.com/x_manager',
      profileUrl: null,
      xProfileUrl: 'https://x.com/x_manager',
      xHandle: '@x_manager',
    }),
    verifiedContact({
      name: 'Email Manager',
      profileUrl: null,
    }),
    verifiedContact({
      name: 'Hypothesis Manager',
      email: 'hypothesis@example.ai',
      emailVerified: false,
      emailHypothesis: true,
      guessed: true,
      emailVerificationState: 'unverified-hypothesis',
      conventionSampleCount: 2,
      conventionCoverage: 1,
      conventionEvidenceUrls: ['https://example.ai/team/one', 'https://example.ai/team/two'],
      profileUrl: null,
    }),
  ], item, { allowUnverifiedHypotheses: true });

  assert.deepEqual(
    contacts.map((contact) => [contact.name, contact.primaryOutreachChannel, contact.channelPriority]),
    [
      ['Email Manager', 'email', 4],
      ['X Manager', 'x', 3],
      ['Hypothesis Manager', 'email', 2],
      ['LinkedIn Manager', 'linkedin', 1],
    ],
  );
  assert.deepEqual(
    selectContacts(contacts, 2).map((contact) => contact.name),
    ['Email Manager', 'X Manager'],
  );
});

test('contact selection retains LinkedIn-only candidates when no stronger channel is available', () => {
  const contacts = rankContacts([
    verifiedContact({
      name: 'LinkedIn Recruiter',
      title: 'Recruiter',
      email: null,
      emailVerified: false,
      sourceType: 'public-profile',
      sourceUrl: 'https://www.linkedin.com/in/linkedin-recruiter',
      profileUrl: 'https://www.linkedin.com/in/linkedin-recruiter',
    }),
  ], item);

  assert.equal(selectContacts(contacts, 1)[0].primaryOutreachChannel, 'linkedin');
});

test('contact ranking rejects first-party relationships that lack target-company evidence', () => {
  const contacts = rankContacts([{
    name: 'Taylor Amazon',
    title: 'Existing Amazon connection',
    company: 'Example AI',
    email: 'taylor@amazon.com',
    emailVerified: true,
    emailVerificationType: 'first-party-relationship',
    publicProfessional: true,
    relationshipVerified: true,
    relationshipType: 'existing_amazon_relationship',
    relationshipLabel: 'Existing Amazon connection',
    connection: true,
    sourceType: 'first-party-relationship',
    sourceMessageId: 'gmail-message-1',
    roleRelevance: 'medium',
  }], item);
  assert.deepEqual(contacts, []);
});

test('contact ranking permits a verified first-party relationship at the target company', () => {
  const contact = rankContacts([{
    name: 'Taylor Example',
    title: 'Existing professional relationship',
    company: 'Example AI',
    email: 'taylor@example.ai',
    emailVerified: true,
    emailVerificationType: 'first-party-relationship',
    publicProfessional: true,
    relationshipVerified: true,
    relationshipType: 'existing_target_company_relationship',
    relationshipLabel: 'Existing professional relationship',
    connection: true,
    sourceType: 'first-party-relationship',
    sourceMessageId: 'gmail-message-2',
    roleRelevance: 'high',
  }], item)[0];
  assert.equal(contact.emailEligible, true);
  assert.equal(contact.type, 'connection');
  const message = buildEmailMessage(profile, item, contact);
  assert.match(message.body, /existing professional relationship/i);
  assert.equal(validateMessage(message.subject, message.body).ok, true);
});

test('same-company recipients are automatically rewritten instead of dropping the second draft', () => {
  const first = rankContacts([verifiedContact({ name: 'Taylor One', email: 'one@example.ai' })], item)[0];
  const second = rankContacts([verifiedContact({ name: 'Taylor Two', email: 'two@example.ai', title: 'Engineering Manager' })], item)[0];
  first.initial = { ...buildEmailMessage(profile, item, first), status: 'pending' };
  second.initial = { ...buildEmailMessage(profile, item, second), status: 'pending' };

  assert.ok(outreachContentSimilarity(first.initial.body, second.initial.body) >= 0.9);
  const iterated = iterateRecipientContentCollisions([first, second], (contact, context) => ({
    ...contact,
    outreachVariant: context.attempt,
    initial: { ...buildEmailMessage(profile, item, contact, 'initial', { variant: context.attempt }), status: 'pending' },
  }));
  assert.equal(iterated[0].initial.status, 'pending');
  assert.equal(iterated[1].initial.status, 'pending');
  assert.equal(iterated[1].outreachVariant, 1);
  assert.ok(outreachContentSimilarity(iterated[0].initial.body, iterated[1].initial.body) < 0.9);
  assert.match(iterated[1].initial.body, /Engineering Manager/);
  assert.equal(validateMessage(iterated[0].initial.subject, iterated[0].initial.body).ok, true);
  assert.equal(validateMessage(iterated[1].initial.subject, iterated[1].initial.body).ok, true);
});

test('provider-generated LinkedIn addresses cannot enter the Gmail draft path', () => {
  assert.equal(isProviderGeneratedContactEmail('newsletters-noreply@linkedin.com'), true);
  assert.equal(isProviderGeneratedContactEmail('hit-reply@linkedin.com'), true);
  assert.equal(isProviderGeneratedContactEmail('jing.ma5@case.edu'), false);
  assert.equal(isProviderGeneratedContactEmail(''), false);
  assert.equal(isProviderGeneratedContactEmail(undefined), false);

  const ranked = rankContacts([{
    name: 'Amazon News',
    title: 'Existing professional relationship',
    company: item.company,
    email: 'newsletters-noreply@linkedin.com',
    emailVerified: true,
    publicProfessional: true,
    relationshipVerified: true,
    relationshipType: 'existing_target_company_relationship',
    sourceType: 'first-party-relationship',
    sourceMessageId: 'linkedin-newsletter-message',
    roleRelevance: 'high',
  }], item);
  assert.deepEqual(ranked, []);
});

test('loading outreach state removes legacy provider contacts from active and discovery records', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-provider-state-'));
  const file = path.join(dir, 'outreach-state.json');
  const providerContact = {
    name: 'Jyothika Punujur',
    title: 'Existing professional relationship',
    company: 'Paramount',
    email: 'hit-reply@linkedin.com',
    relationshipType: 'existing_target_company_relationship',
    sourceType: 'first-party-relationship',
  };
  try {
    writeFileSync(file, JSON.stringify({
      records: [{
        key: 'paramount::softwareengineer',
        company: 'Paramount',
        title: 'Software Engineer',
        status: 'drafted',
        submission: { confirmed: true, signals: [] },
        contacts: [providerContact],
        discoveredContacts: [providerContact],
      }],
      outbox: [{ id: 'provider-outbox', to: 'hit-reply@linkedin.com', status: 'pending' }],
      sendAuthorizations: [{
        id: 'provider-authorization',
        status: 'active',
        entries: [{ id: 'provider-outbox', to: 'hit-reply@linkedin.com' }],
      }],
    }));
    const state = loadOutreachState(file);
    assert.deepEqual(state.records[0].contacts, []);
    assert.deepEqual(state.records[0].discoveredContacts, []);
    assert.equal(state.records[0].status, 'awaiting_contacts');
    assert.deepEqual(state.outbox, []);
    assert.deepEqual(state.sendAuthorizations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message generation stays within outreach safety rules', () => {
  const contact = rankContacts([verifiedContact()], item)[0];
  const email = buildEmailMessage(profile, item, contact);
  const linkedin = buildLinkedInDraft(profile, item, contact);
  assert.equal(validateMessage(email.subject, email.body).ok, true);
  assert.ok(email.body.includes('jakye.netlify.app'));
  assert.ok(linkedin.length <= 300);
  assert.doesNotMatch(email.body, /\+?1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  assert.equal(validateMessage('Test', 'Expected May 2026; https://example.com').ok, false);
  assert.equal(email.rdwRequest.schema_version, 'rdw-artifact-request/v1');
  assert.equal(email.rdwRequest.artifact_type, 'outreach_email');
});

test('company-adjacent contacts receive a routing request instead of a role-specific pitch', () => {
  const [contact] = rankContacts([verifiedContact({
    title: 'Financial Analyst',
    email: null,
    emailVerified: false,
    sourceType: 'public-profile',
    sourceUrl: 'https://www.linkedin.com/in/avery-example',
    profileUrl: 'https://www.linkedin.com/in/avery-example',
    roleRelevance: 'company',
    routingContact: true,
  })], item);
  const draft = buildLinkedInDraft(profile, item, contact);
  assert.match(draft, /trying to connect with the right person/i);
  assert.match(draft, /pointing me in the right direction/i);
  assert.doesNotMatch(draft, /building backend APIs|how the team approaches it/i);
  assert.ok(draft.length <= 300);
});

const RDW_ROOT = path.resolve(process.cwd(), '..', 'research-domain-writing');
test('generated outreach clears RDW only for human review and the receipt is content-bound', {
  skip: !existsSync(path.join(RDW_ROOT, 'pyproject.toml')),
}, () => {
  const contact = rankContacts([verifiedContact()], item)[0];
  const rawMessage = buildEmailMessage(profile, item, contact);
  const quality = prepareOutreachDraft({ channel: 'email', subject: rawMessage.subject, body: rawMessage.body, contactName: contact.name, company: item.company });
  const message = {
    ...rawMessage,
    subject: quality.subject,
    body: quality.body,
    hash: messageFingerprint(quality.subject, quality.body),
    draftQuality: quality.receipt,
    rdwRequest: { ...rawMessage.rdwRequest, content: { ...rawMessage.rdwRequest.content, subject: quality.subject, body: quality.body } },
  };
  const rdwReceipt = runRdwArtifactCheck(message.rdwRequest, { rdwRoot: RDW_ROOT });

  assert.equal(rdwReceipt.status, 'approved_for_human_review');
  assert.equal(rdwReceipt.human_approval_required, true);
  const sendable = messageForSend(item, {
    to: contact.email,
    ...message,
    rdwReceipt,
  });
  assert.match(sendable.body, /\n\n/);
  assert.equal(validateOutreachDraftReceipt({ channel: 'email', subject: message.subject, body: message.body, receipt: message.draftQuality }).ok, true);

  const changedRequest = {
    ...message.rdwRequest,
    content: { ...message.rdwRequest.content, body: `${message.body}\nChanged after validation.` },
  };
  const changed = validateRdwArtifactReceipt(changedRequest, rdwReceipt);
  assert.equal(changed.ok, false);
  assert.ok(changed.reasons.some((reason) => /hash mismatch/i.test(reason)));
});

test('changed email copy is blocked after Humanizer and quality approval', () => {
  const contact = rankContacts([verifiedContact()], item)[0];
  const raw = buildEmailMessage(profile, item, contact);
  const quality = prepareOutreachDraft({ channel: 'email', subject: raw.subject, body: raw.body, contactName: contact.name, company: item.company });
  assert.equal(quality.receipt.passed, true);
  const changed = validateOutreachDraftReceipt({
    channel: 'email',
    subject: quality.subject,
    body: `${quality.body}\nChanged after approval.`,
    receipt: quality.receipt,
  });
  assert.equal(changed.ok, false);
  assert.match(changed.reasons.join('\n'), /hash does not match/);
});

test('message generation turns resume-style proof fragments into complete prose', () => {
  const contact = rankContacts([verifiedContact({ company: 'Glean', connection: true, relationshipLabel: 'Existing Case Western Reserve University connection' })], { ...item, company: 'Glean', title: 'Software Engineer' })[0];
  const message = buildEmailMessage({
    ...profile,
    narrative: { proof_points: ['Three Amazon SDE internships across Ads and FinTech/business-systems teams'] },
  }, { ...item, company: 'Glean', title: 'Software Engineer' }, contact);
  assert.match(message.body, /My background includes three Amazon SDE internships across Ads and FinTech\/business-systems teams\./);
  assert.match(message.body, /both attended Case Western Reserve University/);
  assert.doesNotMatch(message.body, /case western reserve university/);
  assert.doesNotMatch(message.body, /directly\. Three Amazon/);
  assert.equal(validateMessage(message.subject, message.body).ok, true);
  assert.doesNotMatch(buildLinkedInDraft(profile, { ...item, company: 'Glean', title: 'Software Engineer' }, contact), /existing existing/i);
  assert.equal(validateMessage(
    message.subject,
    message.body.replace('My background includes three Amazon SDE internships across Ads and FinTech/business-systems teams.', 'Three Amazon SDE internships across Ads and FinTech/business-systems teams.'),
  ).ok, false);
});

test('submission signals are idempotent and confirmation emails must match the role', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'career-ops-outreach-'));
  const file = path.join(directory, 'outreach-state.json');
  try {
    recordSubmissionSignal(file, item, { source: 'queue_applied', at: '2026-07-18T12:00:00.000Z' });
    const draftState = loadOutreachState(file);
    assert.equal(hasConfirmedSubmission(draftState.records[0]), false);
    recordSubmissionSignal(file, item, { source: 'browser_confirmation', at: '2026-07-18T12:01:00.000Z', confirmed: true, submissionId: 'run-1' });
    recordSubmissionSignal(file, item, { source: 'gmail_confirmation', at: '2026-07-18T12:02:00.000Z', messageId: 'confirmation-1', confirmed: true });
    const state = loadOutreachState(file);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].submission.signals.length, 3);
    assert.equal(hasConfirmedSubmission(state.records[0]), true);
    assert.equal(state.records[0].submission.confirmedSource, 'browser_confirmation');
    assert.equal(matchesApplicationConfirmation('Thank you for applying to Backend AI Engineer', 'Recruiting <jobs@example.ai>', 'Example AI received your application.', item), true);
    assert.equal(matchesApplicationConfirmation('Thank you for applying', 'Recruiting <jobs@other.ai>', 'Other Co received your application.', item), false);
    assert.equal(matchesApplicationConfirmation(
      'Thank you for applying!',
      'Utah Jazz <do-not-reply@mail.paylocity.com>',
      'Thank you for your interest in the AI & Innovation Intern role with Utah Jazz.',
      { ...item, company: 'Triplenet Pricing and 7 more jobs in New York, NY for you. Apply Now.', title: 'ASP.NET Developer' },
    ), false);
    assert.equal(matchesApplicationConfirmation(
      'Application received',
      'Recruiting <jobs@example.ai>',
      'We received your application. Reference: backend-ai.',
      { ...item, title: 'Role not included in subject' },
      { applicationUrl: item.applyUrl },
    ), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy confirmation sources remain untrusted without explicit evidence', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'career-ops-outreach-legacy-'));
  const file = path.join(directory, 'outreach-state.json');
  try {
    recordSubmissionSignal(file, item, { source: 'gmail_confirmation', at: '2026-07-18T12:00:00.000Z', messageId: 'legacy-1' });
    const state = loadOutreachState(file);
    assert.equal(hasConfirmedSubmission(state.records[0]), false);
    assert.equal(state.records[0].status, 'awaiting_submission_confirmation');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('outbox IDs are deterministic and accepted entries are not recreated', () => {
  const state = { records: [], outbox: [] };
  const payload = {
    recordKey: 'example-ai::backend-ai-engineer',
    contactId: 'contact-1',
    kind: 'initial',
    to: 'taylor@example.ai',
    subject: 'Applied for Backend AI Engineer',
    body: 'Hello\n\nhttps://jakye.netlify.app/',
    hash: 'message-hash',
    now: '2026-07-18T12:00:00.000Z',
  };
  const first = ensureOutboxEntry(state, payload);
  const second = ensureOutboxEntry(state, payload);
  assert.equal(first.id, outreachMessageId(payload.recordKey, payload.contactId, payload.kind, payload.hash));
  assert.equal(first.id, second.id);
  assert.equal(state.outbox.length, 1);
  assert.equal(outboxEntryDue(first, '2026-07-18T12:00:01.000Z'), true);
  first.status = 'accepted';
  first.providerStatus = 'accepted_by_gmail';
  assert.equal(ensureOutboxEntry(state, payload).status, 'accepted');
  assert.deepEqual(summarizeOutbox(state), { total: 1, pending: 0, sending: 0, drafting: 0, draft_created: 0, accepted: 1, unknown: 0, failed: 0, blocked: 0 });
  assert.equal(outboxNextAttemptAt('2026-07-18T12:00:00.000Z', 1), '2026-07-18T12:15:00.000Z');
  assert.equal(discoveryCacheTtlMs('no_contacts') < discoveryCacheTtlMs('found'), true);
  assert.equal(discoveryCacheTtlMs('error', 2), discoveryCacheTtlMs('error'));
});

test('explicit send authorization snapshots the reviewed batch and rejects changed or unverified recipients', () => {
  const entry = {
    id: 'outbox-1',
    recordKey: 'example-ai::backend-ai-engineer',
    contactId: 'contact-1',
    kind: 'initial',
    to: 'taylor@example.ai',
    subject: 'Applied for Backend AI Engineer at Example AI',
    body: 'Hello\n\nhttps://jakye.netlify.app/',
    hash: messageFingerprint('Applied for Backend AI Engineer at Example AI', 'Hello\n\nhttps://jakye.netlify.app/'),
    status: 'pending',
  };
  const state = {
    records: [{
      key: entry.recordKey,
      contacts: [{ id: entry.contactId, email: entry.to, emailEligible: true, emailVerified: true }],
    }],
    outbox: [entry],
    sendAuthorizations: [],
  };
  const authorization = authorizeOutreachBatch(state, {
    entryIds: [entry.id],
    account: TARGET_GMAIL_ACCOUNT,
    now: '2026-07-29T12:00:00.000Z',
  });
  assert.equal(authorization.entryIds.length, 1);
  assert.equal(isOutboxEntryAuthorized(state, entry, '2026-07-29T12:01:00.000Z'), true);
  entry.body = 'Changed after review\n\nhttps://jakye.netlify.app/';
  assert.equal(isOutboxEntryAuthorized(state, entry, '2026-07-29T12:01:00.000Z'), false);

  const unsafeState = {
    records: [{ key: entry.recordKey, contacts: [{ id: entry.contactId, email: entry.to, emailEligible: true, emailVerified: false }] }],
    outbox: [{ ...entry, body: 'Hello\n\nhttps://jakye.netlify.app/', status: 'pending' }],
    sendAuthorizations: [],
  };
  assert.throws(
    () => authorizeOutreachBatch(unsafeState, { entryIds: [entry.id], account: TARGET_GMAIL_ACCOUNT }),
    /verified public recipient/,
  );
});

test('send authorization is consumed only after every authorized entry reaches a terminal state', () => {
  const entry = {
    id: 'outbox-2',
    recordKey: 'example-ai::backend-ai-engineer',
    contactId: 'contact-2',
    kind: 'initial',
    to: 'taylor@example.ai',
    subject: 'Applied',
    body: 'Hello\n\nhttps://jakye.netlify.app/',
    hash: messageFingerprint('Applied', 'Hello\n\nhttps://jakye.netlify.app/'),
    status: 'pending',
  };
  const state = {
    records: [{ key: entry.recordKey, contacts: [{ id: entry.contactId, emailEligible: true, emailVerified: true, email: entry.to }] }],
    outbox: [entry],
    sendAuthorizations: [],
  };
  authorizeOutreachBatch(state, { entryIds: [entry.id], now: '2026-07-29T12:00:00.000Z' });
  assert.equal(refreshSendAuthorization(state, '2026-07-29T12:01:00.000Z').status, 'active');
  entry.status = 'accepted';
  assert.equal(refreshSendAuthorization(state, '2026-07-29T12:02:00.000Z').status, 'consumed');
});

test('discovery retains prior candidates when a provider fails', () => {
  const previous = [verifiedContact({ name: 'Existing Manager', email: null, profileUrl: 'https://example.ai/team/existing' })];
  const fresh = [verifiedContact({ name: 'Taylor Example', profileUrl: 'https://example.ai/team/taylor' })];
  assert.equal(retainDiscoveryContacts(previous, [], true).length, 1);
  assert.equal(retainDiscoveryContacts(previous, fresh, true).length, 2);
  assert.equal(retainDiscoveryContacts(previous, [], false).length, 0);
});

test('follow-up date skips weekends', () => {
  assert.equal(addBusinessDays('2026-07-17T12:00:00.000Z', 1), '2026-07-20T12:00:00.000Z');
});

test('follow-ups are suppressed by replies, opt-outs, rejections, bounces, and closed roles', () => {
  const record = { status: 'followup_scheduled', roleClosed: false };
  const contact = { replied: false, optedOut: false, rejected: false, bounced: false };
  assert.equal(followUpSuppressed(record, contact), false);
  assert.equal(followUpSuppressed(record, { ...contact, replied: true }), true);
  assert.equal(followUpSuppressed(record, { ...contact, optedOut: true }), true);
  assert.equal(followUpSuppressed(record, { ...contact, rejected: true }), true);
  assert.equal(followUpSuppressed(record, { ...contact, bounced: true }), true);
  assert.equal(followUpSuppressed({ ...record, roleClosed: true }, contact), true);
});

test('Gmail send verifies the target account and posts an encoded message', async () => {
  assert.ok(GMAIL_REQUIRED_SCOPES.includes(GMAIL_SEND_SCOPE));
  const calls = [];
  const client = await createGmailClient({
    expectedAccount: TARGET_GMAIL_ACCOUNT,
    env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'refresh' },
    fetchFn: async (input, init = {}) => {
      calls.push({ input, init });
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access' }), { status: 200 });
      }
      if (String(input).endsWith('/profile')) {
        return new Response(JSON.stringify({ emailAddress: TARGET_GMAIL_ACCOUNT }), { status: 200 });
      }
      if (String(input).endsWith('/messages/send')) {
        return new Response(JSON.stringify({ id: 'sent-1', threadId: 'thread-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    },
  });
  const result = await client.sendMessage({
    to: 'recruiter@example.ai',
    subject: 'Applied for Backend AI Engineer',
    body: 'Hello\n\nThanks.',
    headers: { 'X-Career-Ops-Outreach-ID': 'career-ops-test' },
  });
  assert.equal(result.id, 'sent-1');
  const send = calls.find((call) => String(call.input).endsWith('/messages/send'));
  assert.ok(send);
  const body = JSON.parse(String(send.init.body));
  assert.equal(typeof body.raw, 'string');
  const raw = Buffer.from(body.raw, 'base64url').toString('utf8');
  assert.match(raw, /To: recruiter@example\.ai/);
  assert.match(raw, /X-Career-Ops-Outreach-ID: career-ops-test/);
});

test('Gmail draft verifies the target account and posts an encoded draft without sending', async () => {
  const calls = [];
  const client = await createGmailClient({
    expectedAccount: TARGET_GMAIL_ACCOUNT,
    env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'refresh' },
    fetchFn: async (input, init = {}) => {
      calls.push({ input, init });
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'access' }), { status: 200 });
      }
      if (String(input).endsWith('/profile')) {
        return new Response(JSON.stringify({ emailAddress: TARGET_GMAIL_ACCOUNT }), { status: 200 });
      }
      if (String(input).endsWith('/drafts')) {
        return new Response(JSON.stringify({ id: 'draft-1', message: { id: 'draft-message-1', threadId: 'thread-1' } }), { status: 200 });
      }
      if (String(input).endsWith('/messages/send')) {
        throw new Error('draft creation must not call the send endpoint');
      }
      return new Response('{}', { status: 200 });
    },
  });
  const result = await client.createDraft({
    to: 'recruiter@example.ai',
    subject: 'Applied for Backend AI Engineer',
    body: 'Hello\n\nThanks.',
    headers: { 'X-Career-Ops-Outreach-ID': 'career-ops-draft-test' },
  });
  assert.equal(result.id, 'draft-1');
  assert.equal(calls.some((call) => String(call.input).endsWith('/messages/send')), false);
  const draft = calls.find((call) => String(call.input).endsWith('/drafts'));
  assert.ok(draft);
  const body = JSON.parse(String(draft.init.body));
  const raw = Buffer.from(body.message.raw, 'base64url').toString('utf8');
  assert.match(raw, /To: recruiter@example\.ai/);
  assert.match(raw, /X-Career-Ops-Outreach-ID: career-ops-draft-test/);
});

test('Gmail draft quality revisions update the durable draft instead of creating a duplicate', async () => {
  const calls = [];
  const client = await createGmailClient({
    expectedAccount: TARGET_GMAIL_ACCOUNT,
    env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'refresh' },
    fetchFn: async (input, init = {}) => {
      calls.push({ input, init });
      if (String(input).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access' }), { status: 200 });
      if (String(input).endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: TARGET_GMAIL_ACCOUNT }), { status: 200 });
      if (String(input).endsWith('/drafts/draft-1')) return new Response(JSON.stringify({ id: 'draft-1', message: { id: 'draft-message-2' } }), { status: 200 });
      if (String(input).endsWith('/drafts')) throw new Error('quality revision must not create a second draft');
      return new Response('{}', { status: 200 });
    },
  });

  const result = await client.updateDraft('draft-1', {
    to: 'recruiter@example.ai',
    subject: 'Revised application note',
    body: 'Hi Taylor,\n\nUpdated copy.',
    headers: { 'X-Career-Ops-Outreach-ID': 'career-ops-draft-test' },
  });
  assert.equal(result.id, 'draft-1');
  const update = calls.find((call) => String(call.input).endsWith('/drafts/draft-1'));
  assert.equal(update.init.method, 'PUT');
  assert.equal(calls.some((call) => String(call.input).endsWith('/messages/send')), false);
});

test('Gmail send blocks an OAuth token verified for another account', async () => {
  const client = await createGmailClient({
    expectedAccount: TARGET_GMAIL_ACCOUNT,
    env: { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: 'refresh' },
    fetchFn: async (input) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access' }), { status: 200 });
      if (String(input).endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: 'other@example.com' }), { status: 200 });
      return new Response('{}', { status: 200 });
    },
  });
  await assert.rejects(
    client.sendMessage({ to: 'recruiter@example.ai', subject: 'Applied', body: 'Hello\n\nhttps://jakye.netlify.app/' }),
    /Gmail account mismatch/,
  );
});
