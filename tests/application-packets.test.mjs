import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPacketMarkdown, packetFreshnessGate, packetPathsForItem } from '../apply/application-packets.mjs';

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
