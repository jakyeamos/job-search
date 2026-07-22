import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQueue, buildQueueItem, renderQueueMarkdown, stableQueueId } from '../queue-lib.mjs';
import { buildContactDiscoveryArgs, normalizeContactDiscoveryLimit } from '../queue.mjs';

const ROOT = process.cwd();

test('contact discovery has an independent bounded batch limit', () => {
  assert.equal(normalizeContactDiscoveryLimit(6), 6);
  assert.equal(normalizeContactDiscoveryLimit(999), 20);
  assert.deepEqual(buildContactDiscoveryArgs(6), ['discover-queue', '--limit', '6']);
  assert.deepEqual(buildContactDiscoveryArgs(999, true), ['discover-queue', '--limit', '20', '--dry-run']);
});

test('queue refresh carries employer domain metadata into contact discovery', () => {
  const item = buildQueueItem({
    url: 'https://jobs.example.com/roles/data-engineer',
    company: 'Example AI',
    title: 'Data Engineer',
    location: 'Remote US',
    careersUrlDomain: 'example.ai',
    liveness: 'active',
  }, {}, ROOT);

  assert.equal(item.companyWebsite, 'https://example.ai');
});

test('queue refresh preserves imported discovery evidence and renders email candidates', () => {
  const id = stableQueueId({
    url: 'https://jobs.example.com/roles/backend',
    company: 'Example AI',
    title: 'Backend Engineer',
  });
  const discovery = {
    pipelineVersion: 10,
    status: 'found',
    cacheExpiresAt: '2026-08-01T00:00:00.000Z',
    contacts: [{ name: 'Ada Lovelace', email: 'ada@example.ai' }],
    emailHypotheses: [{ name: 'Grace Hopper', email: 'ghopper@example.ai' }],
  };
  const state = buildQueue([{
    id,
    source: 'greenhouse',
    title: 'Backend Engineer',
    company: 'Example AI',
    location: 'Remote US',
    canonicalUrl: 'https://jobs.example.com/roles/backend',
    applyUrl: 'https://jobs.example.com/roles/backend',
    liveness: 'active',
    fitScore: 4.4,
    fitConfidence: 'high',
    fitReasons: ['test'],
    blockers: [],
    lane: 'backend_ai_platform',
    status: 'ready',
    outreach: { suggested: true, searchQuery: 'Example AI Backend Engineer recruiter', },
  }], {
    items: [{
      id,
      status: 'ready',
      company: 'Example AI',
      title: 'Backend Engineer',
      companyWebsite: 'https://example.ai',
      outreach: { suggested: true, discovery },
    }],
  }, { limit: 1 });

  assert.deepEqual(state.items[0].outreach.discovery, discovery);
  assert.equal(state.items[0].companyWebsite, 'https://example.ai');
  const markdown = renderQueueMarkdown({ ...state, items: [{ ...state.items[0], selectedForToday: true, queueRank: 1 }] });
  assert.match(markdown, /ada@example\.ai/);
  assert.match(markdown, /review-only hypothesis/);
});
