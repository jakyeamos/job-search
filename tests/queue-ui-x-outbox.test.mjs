import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publicXOutreachOutbox } from '../queue-ui.mjs';
import { hashXOutreachBody, saveXOutreachOutbox } from '../x-outreach-outbox.mjs';
import { prepareOutreachDraft } from '../outreach-draft-quality.mjs';

function outboxState() {
  const prepared = prepareOutreachDraft({
    channel: 'x',
    body: 'Hi Jamie, I applied for Attio’s Product Engineer role. May I ask one question?',
    contactName: 'Jamie Davies',
    company: 'Attio',
  });
  const body = prepared.body;
  return {
    schemaVersion: 2,
    channel: 'x',
    updatedAt: '2026-08-02T19:29:21Z',
    drafts: [{
      id: 'x-attio-product-engineer-viralpickaxe',
      company: 'Attio',
      role: 'Product Engineer',
      contact: {
        name: 'Jamie Davies',
        handle: '@viralpickaxe',
        profileUrl: 'https://x.com/viralpickaxe',
      },
      body,
      bodyHash: hashXOutreachBody(body),
      draftQuality: prepared.receipt,
      status: 'ready_for_review',
      deliveryStatus: 'not_sent',
      savedLocally: true,
      nativeDraftStatus: 'not_saved',
      nativeDraftEvidence: null,
      humanSendRequired: true,
      applicationStatus: 'applied_confirmed',
      source: 'data/valid-outreach-2026-08-02.md',
      evidenceUrls: ['https://x.com/viralpickaxe'],
      createdAt: '2026-08-02T19:29:21Z',
      updatedAt: '2026-08-02T19:29:21Z',
    }],
  };
}

test('X outbox browser payload exposes review copy and truthful local/provider states', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'queue-ui-x-outbox-'));
  const filePath = path.join(directory, 'outbox.json');
  saveXOutreachOutbox(outboxState(), filePath);

  const payload = publicXOutreachOutbox(filePath);
  assert.equal(payload.status, 'ready');
  assert.equal(payload.drafts.length, 1);
  assert.equal(payload.drafts[0].savedLocally, true);
  assert.equal(payload.drafts[0].nativeDraftStatus, 'not_saved');
  assert.equal(payload.drafts[0].deliveryStatus, 'not_sent');
  assert.equal(payload.drafts[0].qualityPassed, true);
  assert.match(payload.drafts[0].body, /Hi Jamie/);
  assert.equal('bodyHash' in payload.drafts[0], false);
  assert.equal('evidenceUrls' in payload.drafts[0], false);
  assert.equal('source' in payload.drafts[0], false);
});

test('invalid X outbox state degrades without exposing draft content', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'queue-ui-x-invalid-'));
  const filePath = path.join(directory, 'outbox.json');
  writeFileSync(filePath, '{not valid json', 'utf8');

  const payload = publicXOutreachOutbox(filePath);
  assert.equal(payload.status, 'unavailable');
  assert.deepEqual(payload.drafts, []);
  assert.match(payload.error, /outbox is unavailable/i);
});

test('archived sent messages stay persisted but leave the active review payload', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'queue-ui-x-archived-'));
  const filePath = path.join(directory, 'outbox.json');
  const state = outboxState();
  state.drafts[0].status = 'archived';
  state.drafts[0].deliveryStatus = 'sent_by_user';
  state.drafts[0].humanConfirmedSentAt = '2026-08-03T15:00:00.000Z';
  state.drafts[0].archivedAt = '2026-08-03T15:00:00.000Z';
  saveXOutreachOutbox(state, filePath);

  const payload = publicXOutreachOutbox(filePath);
  assert.equal(payload.status, 'ready');
  assert.deepEqual(payload.drafts, []);
  assert.equal(payload.archivedCount, 1);
});
