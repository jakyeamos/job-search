import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HANDSHAKE_INBOX_SOURCE_LABEL,
  handshakeInboxId,
  isHandshakeInboxUrl,
  normalizeHandshakeInboxThreads,
  normalizeHandshakeInboxUrl,
  readHandshakeInboxStatus,
} from '../handshake-inbox-lib.mjs';
import { READ_INBOX_SCRIPT } from '../handshake.mjs';

test('Handshake inbox URLs normalize list and conversation identity without accepting another host', () => {
  assert.equal(handshakeInboxId('https://app.joinhandshake.com/inbox/807726912?filter=all'), '807726912');
  assert.equal(normalizeHandshakeInboxUrl('https://app.joinhandshake.com/inbox/807726912?filter=all'), 'https://app.joinhandshake.com/inbox/807726912');
  assert.equal(normalizeHandshakeInboxUrl('https://app.joinhandshake.com/inbox?ref=sidebar'), 'https://app.joinhandshake.com/inbox');
  assert.equal(isHandshakeInboxUrl('https://www.joinhandshake.com/inbox/807726912'), true);
  assert.equal(isHandshakeInboxUrl('https://example.com/inbox/807726912'), false);
});

test('list and selected-thread evidence merge into one read-only conversation record', () => {
  const [thread] = normalizeHandshakeInboxThreads([
    {
      conversationId: '807726912',
      threadUrl: 'https://app.joinhandshake.com/inbox/807726912?filter=all',
      participantName: 'Natalie Maxwell',
      dateLabel: 'Aug 7',
      previewText: 'Thank you for reaching out I\'ll fill this out now',
      unread: false,
    },
    {
      conversationId: '807726912',
      threadUrl: 'https://app.joinhandshake.com/inbox/807726912?filter=all',
      participantName: 'Natalie Maxwell',
      company: 'Momentum',
      threadText: 'Recruiter message with a visible role link',
      jobLinks: [{ url: 'https://app.joinhandshake.com/emp/jobs/11190664' }],
      selected: true,
    },
  ], { observedAt: '2026-08-08T12:00:00.000Z', authenticated: true });

  assert.equal(thread.sourceLabel, HANDSHAKE_INBOX_SOURCE_LABEL);
  assert.equal(thread.company, 'Momentum');
  assert.equal(thread.selected, true);
  assert.equal(thread.readOnly, true);
  assert.equal(thread.actionState, 'human-review-required');
  assert.deepEqual(thread.jobUrls, ['https://app.joinhandshake.com/jobs/11190664']);
  assert.equal(thread.sourceEvidence.method, 'authenticated-chrome-dom-read');
  assert.equal(thread.sourceEvidence.authenticated, true);
  assert.equal(thread.sourceEvidence.readOnly, true);
});

test('inbox status parsing fails closed for malformed cache status', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'career-ops-handshake-inbox-'));
  const file = path.join(dir, 'status.json');
  writeFileSync(file, '{not-json');
  const status = readHandshakeInboxStatus(file);
  assert.equal(status.ok, false);
  assert.equal(status.outcome, 'invalid-status');
});

test('the inbox DOM extractor is a visible read-only boundary', () => {
  assert.match(READ_INBOX_SCRIPT, /selectedThread/);
  assert.match(READ_INBOX_SCRIPT, /unreadCount/);
  assert.doesNotMatch(READ_INBOX_SCRIPT, /\b(?:click|fetch|archive|send)\s*\(/i);
});
