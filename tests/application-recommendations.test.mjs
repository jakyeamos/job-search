import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jobFamilyKey,
  recommendationGroupKey,
  selectApplicationRecommendations,
} from '../apply/application-recommendations.mjs';

test('country variants normalize into one company and role-family group', () => {
  const belgium = {
    id: 'belgium',
    company: 'ElevenLabs',
    title: 'Enterprise Solutions Engineer - Belgium',
    location: 'Belgium',
  };
  const france = {
    id: 'france',
    company: 'ElevenLabs',
    title: 'Enterprise Solutions Engineer - France',
    location: 'France',
  };

  assert.equal(jobFamilyKey(belgium), 'enterprise_solutions_engineer');
  assert.equal(jobFamilyKey(france), 'enterprise_solutions_engineer');
  assert.equal(recommendationGroupKey(belgium), recommendationGroupKey(france));
});

test('role-family matching keeps distinct application families separate', () => {
  assert.equal(jobFamilyKey({ title: 'Forward Deployed Creative' }), 'forward_deployed_creative');
  assert.equal(jobFamilyKey({ title: 'Forward Deployed Engineer - Software Engineer - Spain' }), 'forward_deployed_engineer');
  assert.equal(jobFamilyKey({ title: 'Full-Stack Engineer (Front-End Leaning)' }), 'full_stack_engineer');
});

test('recommendations select the strongest role per company by default', () => {
  const selected = selectApplicationRecommendations([
    { id: 'elevenlabs-enterprise', company: 'ElevenLabs', title: 'Enterprise Solutions Engineer - Belgium', fitScore: 4.8 },
    { id: 'elevenlabs-data', company: 'ElevenLabs', title: 'Data Engineer - United Kingdom', fitScore: 4.7 },
    { id: 'other-company', company: 'Other Company', title: 'Software Engineer', fitScore: 4.6 },
  ]);

  assert.deepEqual(selected.map((item) => item.id), ['elevenlabs-enterprise', 'other-company']);
});

test('higher company limits still avoid repeating the same role family', () => {
  const selected = selectApplicationRecommendations([
    { id: 'backend-best', company: 'Acme', title: 'Backend Engineer', fitScore: 5 },
    { id: 'data', company: 'Acme', title: 'Data Engineer', fitScore: 4.9 },
    { id: 'backend-alternate', company: 'Acme', title: 'Backend Engineer II', fitScore: 4.8 },
    { id: 'beta', company: 'Beta', title: 'Full-Stack Engineer', fitScore: 4.7 },
  ], { limit: 5, maxPerCompany: 2, maxPerJobFamily: 1 });

  assert.deepEqual(selected.map((item) => item.id), ['backend-best', 'data', 'beta']);
});

test('pinned items lead the result and seed the company cap', () => {
  const incumbent = { id: 'pin-1', company: 'Acme', title: 'Backend Engineer', fitScore: 4.1 };
  const items = [
    { id: 'a', company: 'Acme', title: 'Platform Engineer', fitScore: 4.9 },
    { id: 'b', company: 'Globex', title: 'Data Engineer', fitScore: 4.2 },
  ];
  const selected = selectApplicationRecommendations(items, { limit: 3, pinned: [incumbent] });
  assert.deepEqual(selected.map((item) => item.id), ['pin-1', 'b']);
});

test('pinned items keep their given order ahead of higher scorers', () => {
  const pinned = [
    { id: 'pin-low', company: 'Acme', title: 'Backend Engineer', fitScore: 4.0 },
    { id: 'pin-high', company: 'Globex', title: 'Data Engineer', fitScore: 4.8 },
  ];
  const items = [{ id: 'c', company: 'Initech', title: 'Site Reliability Engineer', fitScore: 4.9 }];
  const selected = selectApplicationRecommendations(items, { limit: 3, pinned });
  assert.deepEqual(selected.map((item) => item.id), ['pin-low', 'pin-high', 'c']);
});

test('an item repeated in pinned and items is emitted once', () => {
  const shared = { id: 'dup', company: 'Acme', title: 'Backend Engineer', fitScore: 4.4 };
  const selected = selectApplicationRecommendations([shared], { limit: 5, pinned: [shared] });
  assert.deepEqual(selected.map((item) => item.id), ['dup']);
});

test('pinned items are never dropped to honour the limit', () => {
  const pinned = [
    { id: 'p1', company: 'Acme', title: 'Backend Engineer', fitScore: 4.1 },
    { id: 'p2', company: 'Globex', title: 'Data Engineer', fitScore: 4.2 },
  ];
  const items = [{ id: 'c', company: 'Initech', title: 'Site Reliability Engineer', fitScore: 4.9 }];
  const selected = selectApplicationRecommendations(items, { limit: 1, pinned });
  assert.deepEqual(selected.map((item) => item.id), ['p1', 'p2']);
});
