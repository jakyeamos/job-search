import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyLocationFit, scoreCandidate } from '../queue-lib.mjs';

const PROFILE = {
  location_strategy: {
    preferred_regions: [
      {
        id: 'buffalo_western_new_york',
        label: 'Buffalo / Western New York',
        terms: ['Buffalo', 'Erie County', 'Western New York', 'WNY'],
        score_adjustment: 0.5,
      },
      {
        id: 'cleveland_northeast_ohio',
        label: 'Cleveland / Northeast Ohio',
        terms: ['Cleveland', 'Cuyahoga County', 'Northeast Ohio'],
        score_adjustment: 0.35,
      },
    ],
    remote_us: { label: 'National US remote', score_adjustment: 0.2 },
    other_us: { label: 'Other US location', score_adjustment: -0.15 },
    unknown: { label: 'Location not listed', score_adjustment: -0.1 },
    international_allowed: { label: 'International / relocation lane', score_adjustment: 0 },
  },
};

function role(location) {
  return scoreCandidate({
    title: 'Software Engineer',
    company: 'Example Systems',
    location,
    liveness: 'active',
  }, PROFILE);
}

test('location is an additive ranking signal for Buffalo, Cleveland, and national remote', () => {
  const buffalo = role('Buffalo, NY');
  const cleveland = role('Cleveland, OH');
  const remote = role('Remote US');
  const otherUs = role('Atlanta, GA');

  assert.equal(buffalo.locationFit.id, 'buffalo_western_new_york');
  assert.equal(buffalo.locationFit.scoreAdjustment, 0.5);
  assert.equal(cleveland.locationFit.id, 'cleveland_northeast_ohio');
  assert.equal(remote.locationFit.id, 'national_remote_us');
  assert.equal(otherUs.locationFit.id, 'other_us');
  assert.ok(buffalo.score > cleveland.score);
  assert.ok(cleveland.score > remote.score);
  assert.ok(remote.score > otherUs.score);
  assert.equal(otherUs.eligible, true, 'other US roles remain in the pool rather than being filtered out');
  assert.ok(buffalo.reasons.some((reason) => reason.includes('Buffalo / Western New York')));
  assert.ok(otherUs.reasons.some((reason) => reason.includes('Other US location')));
});

test('unknown locations use the configured deduction and remain explainable', () => {
  const missing = role('Location not listed');

  assert.equal(missing.locationFit.id, 'unknown');
  assert.equal(missing.locationFit.scoreAdjustment, -0.1);
  assert.ok(missing.reasons.some((reason) => reason.includes('Location not listed')));
});

test('an explicit remote designation in the role context beats a generic United States location', () => {
  const remoteTitle = scoreCandidate({
    title: 'Software Engineer (USA Only - 100% Remote)',
    company: 'Example Systems',
    location: 'United States',
    liveness: 'active',
  }, PROFILE);

  assert.equal(remoteTitle.locationFit.id, 'national_remote_us');
  assert.equal(remoteTitle.locationFit.scoreAdjustment, 0.2);
});

test('international lanes keep their separate zero-adjustment policy', () => {
  const international = classifyLocationFit('Toronto, Canada', PROFILE);

  assert.equal(international.id, 'international_allowed');
  assert.equal(international.scoreAdjustment, 0);
  assert.match(international.reason, /no score adjustment/);
});
