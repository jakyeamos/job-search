import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  X_OUTREACH_OUTBOX_PATH,
  hashXOutreachBody,
  loadXOutreachOutbox,
  markXOutreachDraftSentAndArchived,
  saveXOutreachOutbox,
  syncPreparedXOutreachDrafts,
  validateXOutreachOutbox,
} from '../x-outreach-outbox.mjs';
import { prepareOutreachDraft } from '../outreach-draft-quality.mjs';

function validDraft(overrides = {}) {
  const contact = overrides.contact || {
    name: 'Jamie Davies',
    handle: '@viralpickaxe',
    profileUrl: 'https://x.com/viralpickaxe',
  };
  const rawBody = overrides.body || 'Hi Jamie, I applied for Attio’s Product Engineer role. May I ask one question?';
  const quality = prepareOutreachDraft({ channel: 'x', body: rawBody, contactName: contact.name, company: overrides.company || 'Attio' });
  const body = quality.body;
  return {
    id: 'x-attio-product-engineer-viralpickaxe',
    company: 'Attio',
    role: 'Product Engineer',
    contact,
    body,
    bodyHash: hashXOutreachBody(body),
    draftQuality: quality.receipt,
    status: 'ready_for_review',
    deliveryStatus: 'not_sent',
    savedLocally: true,
    nativeDraftStatus: 'not_saved',
    nativeDraftEvidence: null,
    humanSendRequired: true,
    applicationStatus: 'applied_confirmed',
    source: 'data/valid-outreach-2026-08-02.md',
    createdAt: '2026-08-02T19:29:21Z',
    updatedAt: '2026-08-02T19:29:21Z',
    ...overrides,
    contact,
    body,
    bodyHash: hashXOutreachBody(body),
    draftQuality: quality.receipt,
  };
}

function validState(drafts = [validDraft()]) {
  return {
    schemaVersion: 2,
    channel: 'x',
    updatedAt: '2026-08-02T19:29:21Z',
    drafts,
  };
}

test('repository X outbox contains the restored Jamie and Kyle messages', () => {
  const state = loadXOutreachOutbox(X_OUTREACH_OUTBOX_PATH);
  const validation = validateXOutreachOutbox(state);
  assert.deepEqual(validation.errors, []);

  const ids = new Set(state.drafts.map((draft) => draft.id));
  assert.equal(ids.has('x-attio-product-engineer-viralpickaxe'), true);
  assert.equal(ids.has('x-sentry-solutions-engineer-techsquidtv'), true);
  for (const draft of state.drafts) {
    assert.equal(draft.nativeDraftStatus, 'not_saved');
    assert.equal(draft.humanSendRequired, true);
    if (draft.deliveryStatus === 'sent_by_user') {
      assert.equal(draft.status, 'archived');
      assert.match(draft.humanConfirmedSentAt, /^\d{4}-\d{2}-\d{2}T/);
    } else {
      assert.equal(draft.deliveryStatus, 'not_sent');
      assert.notEqual(draft.status, 'archived');
      assert.equal('humanConfirmedSentAt' in draft, false);
    }
  }
});

test('an open composer cannot be promoted to a verified native draft without durable evidence', () => {
  const draft = validDraft({ nativeDraftStatus: 'verified_saved' });
  const validation = validateXOutreachOutbox(validState([draft]));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /cannot claim verified_saved/);
});

test('same-company similarity asks for iteration without blocking either message', () => {
  const sharedBody =
    'I applied for Attio’s Product Engineer role and would value your perspective on the engineering team.';
  const first = validDraft({
    body: `Hi Jamie, ${sharedBody}`,
  });
  const second = validDraft({
    id: 'x-attio-product-engineer-taylor',
    contact: {
      name: 'Taylor Example',
      handle: '@taylorexample',
      profileUrl: 'https://x.com/taylorexample',
    },
    body: `Hi Taylor, ${sharedBody}`,
  });
  const validation = validateXOutreachOutbox(validState([first, second]));
  assert.equal(validation.ok, true);
  assert.match(validation.warnings.join('\n'), /iterate both messages/);
});

test('save is validated and round-trips through the local file', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-outreach-outbox-'));
  const filePath = path.join(directory, 'outbox.json');
  const state = validState();

  saveXOutreachOutbox(state, filePath);
  assert.deepEqual(loadXOutreachOutbox(filePath), state);
  assert.equal(readFileSync(filePath, 'utf8').endsWith('\n'), true);
});

test('mark sent records human delivery and archives without deleting the local record', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-outreach-mark-sent-'));
  const filePath = path.join(directory, 'outbox.json');
  saveXOutreachOutbox(validState(), filePath);

  const result = markXOutreachDraftSentAndArchived('x-attio-product-engineer-viralpickaxe', {
    now: '2026-08-03T15:00:00.000Z',
  }, filePath);
  assert.equal(result.changed, true);
  assert.equal(result.draft.status, 'archived');
  assert.equal(result.draft.deliveryStatus, 'sent_by_user');
  assert.equal(result.draft.humanConfirmedSentAt, '2026-08-03T15:00:00.000Z');
  assert.equal(result.draft.archivedAt, '2026-08-03T15:00:00.000Z');
  assert.equal(result.draft.nativeDraftStatus, 'not_saved');

  const saved = loadXOutreachOutbox(filePath);
  assert.equal(saved.drafts.length, 1);
  assert.equal(saved.drafts[0].id, 'x-attio-product-engineer-viralpickaxe');

  const repeat = markXOutreachDraftSentAndArchived('x-attio-product-engineer-viralpickaxe', {
    now: '2026-08-03T16:00:00.000Z',
  }, filePath);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.draft.humanConfirmedSentAt, '2026-08-03T15:00:00.000Z');
});

test('prepared X messages are saved locally before any composer is opened', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-outreach-sync-'));
  const filePath = path.join(directory, 'outbox.json');
  const body = 'Hi Jamie, I applied for Attio’s Product Engineer role. May I ask one question?';

  const result = syncPreparedXOutreachDrafts({
    company: 'Attio',
    role: 'Product Engineer',
    now: '2026-08-02T19:29:21Z',
    contacts: [{
      name: 'Jamie Davies',
      xHandle: '@viralpickaxe',
      xProfileUrl: 'https://x.com/viralpickaxe',
      xDraft: body,
    }],
  }, filePath);

  assert.equal(result.validation.ok, true);
  const saved = loadXOutreachOutbox(filePath).drafts[0];
  assert.equal(saved.body, body);
  assert.equal(saved.deliveryStatus, 'not_sent');
  assert.equal(saved.nativeDraftStatus, 'not_saved');
});

test('automatic preparation preserves reviewed copy and queues changed copy for review', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-outreach-revision-'));
  const filePath = path.join(directory, 'outbox.json');
  const reviewed = validState();
  saveXOutreachOutbox(reviewed, filePath);
  const generated = 'Hi Jamie, I applied for Attio’s Product Engineer role. Here is revised copy.';

  syncPreparedXOutreachDrafts({
    company: 'Attio',
    role: 'Product Engineer',
    now: '2026-08-02T20:00:00Z',
    contacts: [{
      name: 'Jamie Davies',
      xHandle: '@viralpickaxe',
      xProfileUrl: 'https://x.com/viralpickaxe',
      xDraft: generated,
    }],
  }, filePath);

  const saved = loadXOutreachOutbox(filePath).drafts[0];
  assert.equal(saved.body, reviewed.drafts[0].body);
  assert.equal(saved.pendingRevision.body, generated);
  assert.equal(saved.status, 'ready_for_review');
});
