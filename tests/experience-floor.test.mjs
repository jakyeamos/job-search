import test from 'node:test';
import assert from 'node:assert/strict';

import { detectExperienceFloor } from '../experience-floor.mjs';
import { scoreCandidate } from '../queue-lib.mjs';

test('detects a real stated experience floor', () => {
  const cases = [
    ['3+ years of industry software engineering experience', 3],
    ['Minimum 3 years of professional software engineering experience', 3],
    ['At least five years of backend experience', 5],
    ['4+ years of backend software engineering experience', 4],
    ['7+ years of experience building distributed systems', 7],
    ['5-8 years of experience as a Design Engineer', 5],
    ["5+ years' commercial Java development experience", 5],
    ['Industry Experience (3+ years) shipping production services', 3],
    ['Requires a minimum of 6 yrs of relevant professional experience', 6],
  ];
  for (const [text, expected] of cases) {
    const result = detectExperienceFloor(text);
    assert.equal(result.floor, expected, text);
    assert.equal(result.required, true, text);
  }
});

test('ignores year counts that are not hiring bars', () => {
  const cases = [
    'Vacation increases to 25 days after five years of service',
    'The vacation accrual rate is 13 days annually for the first three years of employment',
    'Growers see crop yield increases of 5-50%, with payback in one to three years',
    'Equity vests over four years with a one year cliff',
    'Tuition reimbursement is available after three years',
    'We have been building developer tools for over the past eight years',
    'Founded in 2019, we have grown for six years running',
    'A four-year degree in Computer Science or equivalent',
  ];
  for (const text of cases) {
    assert.equal(detectExperienceFloor(text).floor, null, text);
  }
});

test('ranges resolve to their low end', () => {
  assert.equal(detectExperienceFloor('1 to 3 years of professional experience').floor, 1);
  assert.equal(detectExperienceFloor('2-5 years of software development industry experience').floor, 2);
  assert.equal(detectExperienceFloor('3-7 years of experience in backend engineering').floor, 3);
  assert.equal(detectExperienceFloor('0-2 years of experience, new grads welcome').floor, 0);
});

test('preferred-only floors are not treated as required', () => {
  const heading = detectExperienceFloor('Preferred qualifications: 5+ years of experience with Kubernetes');
  assert.equal(heading.floor, 5);
  assert.equal(heading.required, false);

  const trailing = detectExperienceFloor('3+ years of experience with Go is a plus');
  assert.equal(trailing.required, false);

  const strongPreferenceForATool = detectExperienceFloor(
    'We strongly prefer Go - 3+ years of professional development experience required',
  );
  assert.equal(strongPreferenceForATool.required, true, 'a preferred *tool* must not soften the tenure bar');
});

test('a required floor shadows a higher preferred one', () => {
  const result = detectExperienceFloor(
    'Requirements: 2+ years of professional experience. Preferred: 8+ years of experience leading teams.',
  );
  assert.equal(result.floor, 2);
  assert.equal(result.required, true);
});

test('conjunctive requirement bullets resolve to the highest bar', () => {
  const uipath = detectExperienceFloor(
    "What You'll Bring To The Team - 5+ years of Java/Python programming experience - 1+ years experience in B2B software",
  );
  assert.equal(uipath.floor, 5, 'both bullets must be satisfied, so 5 binds');

  const remitly = detectExperienceFloor(
    '- 3+ years of software development experience. - 1+ years of React or React Native development experience.',
  );
  assert.equal(remitly.floor, 3);
});

test('ignores experience attributed to future colleagues', () => {
  const result = detectExperienceFloor(
    '0-2 years of experience required. You will work alongside engineers with 10+ years of experience.',
  );
  assert.equal(result.floor, 0);
});

test('reads through HTML markup', () => {
  const result = detectExperienceFloor(
    '<h2><strong>About You</strong></h2> <ul> <li>3+ years of backend experience</li> </ul>',
  );
  assert.equal(result.floor, 3);
});

/** @param {string} description @param {string} [title] */
function scoreWith(description, title = 'Backend Engineer') {
  return scoreCandidate({ title, description, location: 'Remote US', liveness: 'active' }, {});
}

test('a floor of 6 or more is a hard DQ regardless of substance', () => {
  const result = scoreWith('7+ years of experience building distributed backend systems');
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'excluded');
  assert.ok(result.blockers.includes('posting states a 7+ year experience floor'), result.blockers.join('; '));
});

test('a 4-5 year floor survives when the role substance matches', () => {
  const result = scoreWith('5+ years of experience designing backend APIs and data pipelines');
  const baseline = scoreWith('Design backend APIs and data pipelines');
  assert.equal(result.eligible, true);
  assert.equal(result.blockers.length, 0);
  assert.ok(result.score < baseline.score - 1, `${result.score} should be well below ${baseline.score}`);
});

test('a 4-5 year floor blocks when the role substance also misses', () => {
  const result = scoreWith('5+ years of professional experience in technical writing', 'Technical Writer');
  assert.equal(result.eligible, false);
  assert.ok(
    result.blockers.some((b) => b.includes("5+ year experience floor and the role's substance")),
    result.blockers.join('; '),
  );
});

test('a 3-year floor is a mild downscore, never a blocker', () => {
  const result = scoreWith('3+ years of professional software engineering experience building APIs');
  const baseline = scoreWith('Build and ship APIs on our platform team');
  assert.equal(result.eligible, true);
  assert.equal(result.blockers.length, 0);
  assert.ok(result.score < baseline.score, `${result.score} should be below ${baseline.score}`);
  assert.ok(result.reasons.includes('posting states a 3-year experience floor'), result.reasons.join('; '));

  const offLane = scoreWith('3+ years of professional experience in technical writing', 'Technical Writer');
  assert.equal(offLane.eligible, true, 'substance mismatch must not promote a 3-year floor to a blocker');
});

test('a floor of 2 or less carries no penalty at all', () => {
  const baseline = scoreWith('Build and ship APIs on our platform team');
  for (const description of [
    '2+ years of professional software engineering experience building APIs',
    '1 to 3 years of professional experience building APIs; new grads encouraged to apply',
    'Vacation increases to 25 days after five years of service. Equity vests over four years. Build APIs.',
  ]) {
    const result = scoreWith(description);
    assert.equal(result.eligible, true, description);
    assert.equal(result.blockers.length, 0, description);
    assert.equal(result.score, baseline.score, description);
  }
});
