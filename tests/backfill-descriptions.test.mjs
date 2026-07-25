import test from 'node:test';
import assert from 'node:assert/strict';

import { rescoreItem } from '../backfill-descriptions.mjs';

test('rescoring preserves item identity and history while applying the fetched posting', () => {
  const item = {
    id: 'preserved-id',
    source: 'gmail:linkedin',
    sourceLabel: 'LinkedIn alert',
    sourceMessageId: 'msg-1',
    sourceUrl: 'https://www.linkedin.com/comm/jobs/view/4430806173',
    canonicalUrl: 'https://www.linkedin.com/comm/jobs/view/4430806173',
    // Alert ingestion writes the email subject line into `company`.
    company: 'F-ADA and 7 more jobs in New York, NY for you. Apply Now.',
    title: 'Software Engineer',
    location: '',
    description: '',
    status: 'in_review',
    fitScore: 3.7,
    discoveredAt: '2026-07-01T00:00:00.000Z',
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    selectedForToday: true,
    queueRank: 3,
    outreach: { suggested: false, discovery: { status: 'found', contacts: [{ email: 'a@acme.test' }] } },
  };
  const fields = {
    title: 'Backend Engineer',
    company: 'Acme Corp',
    location: 'New York, NY',
    description: 'We build payment systems in Python and Go. Great for early-career engineers.',
  };

  const rescored = rescoreItem(item, fields, 'active', {});

  assert.equal(rescored.id, 'preserved-id', 'id must survive so history is not orphaned');
  assert.equal(rescored.source, 'gmail:linkedin');
  assert.equal(rescored.sourceMessageId, 'msg-1');
  assert.equal(rescored.discoveredAt, '2026-07-01T00:00:00.000Z');
  assert.equal(rescored.firstSeenAt, '2026-07-01T00:00:00.000Z');
  assert.equal(rescored.company, 'Acme Corp', 'the posting overwrites the email-subject company');
  assert.equal(rescored.description, fields.description);
  assert.ok(rescored.fitScore > 3.7);
  assert.deepEqual(rescored.outreach.discovery, item.outreach.discovery, 'discovered contacts must not be wiped');
  assert.ok(rescored.descriptionFetchedAt);
});

test('a rescore that excludes an item pulls it out of the daily slate', () => {
  const item = {
    id: 'blocked-id',
    source: 'gmail:linkedin',
    canonicalUrl: 'https://www.linkedin.com/comm/jobs/view/1',
    company: 'Acme',
    title: 'Software Engineer',
    description: '',
    status: 'in_review',
    fitScore: 3.7,
    selectedForToday: true,
    queueRank: 1,
  };
  const rescored = rescoreItem(item, {
    title: 'Software Engineer',
    company: 'Acme',
    location: 'New York, NY',
    description: 'Requires 7+ years of professional software engineering experience.',
  }, 'active', {});

  assert.equal(rescored.status, 'excluded');
  assert.equal(rescored.selectedForToday, false);
  assert.equal(rescored.queueRank, null);
});
