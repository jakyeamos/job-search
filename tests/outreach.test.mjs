import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGmailClient, GMAIL_REQUIRED_SCOPES, GMAIL_SEND_SCOPE, TARGET_GMAIL_ACCOUNT } from '../gmail-client.mjs';
import {
  addBusinessDays,
  buildEmailMessage,
  buildLinkedInDraft,
  loadOutreachState,
  matchesApplicationConfirmation,
  rankContacts,
  recordSubmissionSignal,
  selectContacts,
  followUpSuppressed,
  validateMessage,
} from '../outreach-lib.mjs';

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

test('contact ranking permits a verified first-party Amazon relationship without a public URL', () => {
  const contact = rankContacts([{
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
  }], item)[0];
  assert.equal(contact.emailEligible, true);
  assert.equal(contact.type, 'connection');
  const message = buildEmailMessage(profile, item, contact);
  assert.match(message.body, /existing amazon connection/i);
  assert.equal(validateMessage(message.subject, message.body).ok, true);
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
});

test('submission signals are idempotent and confirmation emails must match the role', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'career-ops-outreach-'));
  const file = path.join(directory, 'outreach-state.json');
  try {
    recordSubmissionSignal(file, item, { source: 'queue_applied', at: '2026-07-18T12:00:00.000Z' });
    recordSubmissionSignal(file, item, { source: 'browser_confirmation', at: '2026-07-18T12:01:00.000Z' });
    recordSubmissionSignal(file, item, { source: 'gmail_confirmation', at: '2026-07-18T12:02:00.000Z', messageId: 'confirmation-1' });
    const state = loadOutreachState(file);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].submission.signals.length, 3);
    assert.equal(matchesApplicationConfirmation('Thank you for applying to Backend AI Engineer', 'Recruiting <jobs@example.ai>', 'Example AI received your application.', item), true);
    assert.equal(matchesApplicationConfirmation('Thank you for applying', 'Recruiting <jobs@other.ai>', 'Other Co received your application.', item), false);
    assert.equal(matchesApplicationConfirmation(
      'Thank you for applying!',
      'Utah Jazz <do-not-reply@mail.paylocity.com>',
      'Thank you for your interest in the AI & Innovation Intern role with Utah Jazz.',
      { ...item, company: 'Triplenet Pricing and 7 more jobs in New York, NY for you. Apply Now.', title: 'ASP.NET Developer' },
    ), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  const result = await client.sendMessage({ to: 'recruiter@example.ai', subject: 'Applied for Backend AI Engineer', body: 'Hello\n\nThanks.' });
  assert.equal(result.id, 'sent-1');
  const send = calls.find((call) => String(call.input).endsWith('/messages/send'));
  assert.ok(send);
  const body = JSON.parse(String(send.init.body));
  assert.equal(typeof body.raw, 'string');
  assert.match(Buffer.from(body.raw, 'base64url').toString('utf8'), /To: recruiter@example\.ai/);
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
