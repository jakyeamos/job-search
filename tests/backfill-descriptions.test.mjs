import test from 'node:test';
import assert from 'node:assert/strict';

import {
  htmlToText,
  linkedinJobId,
  parseLinkedinPosting,
  rescoreItem,
  resolveEmbeddedGreenhouse,
} from '../backfill-descriptions.mjs';

test('LinkedIn job ids are extracted from alert, canonical, and query URL shapes', () => {
  assert.equal(linkedinJobId('https://www.linkedin.com/comm/jobs/view/4430806173'), '4430806173');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/view/backend-engineer-at-acme-4430806173'), '4430806173');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/search?currentJobId=4430806173'), '4430806173');
});

test('LinkedIn job id extraction rejects other hosts and lookalike domains', () => {
  assert.equal(linkedinJobId('https://notlinkedin.com/comm/jobs/view/4430806173'), null);
  assert.equal(linkedinJobId('https://linkedin.com.evil.test/jobs/view/4430806173'), null);
  assert.equal(linkedinJobId('https://jobs.lever.co/acme/abc'), null);
  assert.equal(linkedinJobId('not a url'), null);
});

test('posting HTML is flattened to text with entities and list markers resolved', () => {
  const text = htmlToText('<p>Build&nbsp;APIs</p><ul><li>Python &amp; Go</li><li>3+ years</li></ul>');
  assert.equal(text, 'Build APIs\n- Python & Go\n- 3+ years');
});

test('LinkedIn posting parse appends job criteria so blocker rules can see seniority', () => {
  const html = `
    <h2 class="top-card-layout__title">Backend Engineer</h2>
    <a class="topcard__org-name-link" href="#">Acme Corp</a>
    <span class="topcard__flavor topcard__flavor--bullet">New York, NY</span>
    <div class="show-more-less-html__markup">We build <b>payment</b> systems.</div>
    <h3 class="description__job-criteria-subheader">Seniority level</h3>
    <span class="description__job-criteria-text">Mid-Senior level</span>
  `;
  const parsed = parseLinkedinPosting(html);
  assert.equal(parsed.title, 'Backend Engineer');
  assert.equal(parsed.company, 'Acme Corp');
  assert.equal(parsed.location, 'New York, NY');
  assert.match(parsed.description, /We build payment systems\./);
  assert.match(parsed.description, /Seniority level: Mid-Senior level/);
});

test('embedded Greenhouse boards are resolved from gh_jid on a company domain', () => {
  const resolved = resolveEmbeddedGreenhouse('https://nuro.ai/careersitem?gh_jid=7896063');
  assert.equal(resolved.ats, 'greenhouse');
  assert.equal(resolved.apiUrl, 'https://boards-api.greenhouse.io/v1/boards/nuro/jobs/7896063');
  // The board name is a guess, so callers must not read a 404 as a dead posting.
  assert.equal(resolved.guessedBoard, true);
});

test('embedded Greenhouse resolution rejects non-https and missing or malformed gh_jid', () => {
  assert.equal(resolveEmbeddedGreenhouse('http://nuro.ai/careersitem?gh_jid=7896063'), null);
  assert.equal(resolveEmbeddedGreenhouse('https://nuro.ai/careersitem'), null);
  assert.equal(resolveEmbeddedGreenhouse('https://nuro.ai/careersitem?gh_jid=../../etc'), null);
});

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
    description: 'Requires 5+ years of professional software engineering experience.',
  }, 'active', {});

  assert.equal(rescored.status, 'excluded');
  assert.equal(rescored.selectedForToday, false);
  assert.equal(rescored.queueRank, null);
});
