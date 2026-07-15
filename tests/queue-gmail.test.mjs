import test from 'node:test';
import assert from 'node:assert/strict';

import { assertTargetAccount, buildFilterPlan, classifyAlert } from '../gmail.mjs';
import { buildLaunchdPlist, buildUiServerPlist, checkPublicLiveness } from '../queue.mjs';
import {
  buildQueue,
  parsePipeline,
  scoreCandidate,
  stableQueueId,
} from '../queue-lib.mjs';
import { extractJobUrls } from '../plugins/gmail/_helpers.mjs';

test('known TeamWork Online alert is high confidence and source labeled', () => {
  const result = classifyAlert({
    headers: [
      { name: 'From', value: 'alerts@teamworkonline.com' },
      { name: 'Subject', value: 'New job alert: Backend Engineer' },
    ],
    body: 'View job opportunity and apply now: https://www.teamworkonline.com/jobs/123',
  });
  assert.equal(result.source, 'teamwork-online');
  assert.equal(result.label, 'Job Leads/TeamWork Online');
  assert.equal(result.confidence, 'high');
});

test('uncertain email is not promoted to the queue label', () => {
  const result = classifyAlert({
    headers: [{ name: 'From', value: 'friend@example.com' }, { name: 'Subject', value: 'Checking in' }],
    body: 'Hope you are doing well.',
  });
  assert.equal(result.source, 'unknown');
  assert.equal(result.confidence, 'uncertain');
});

test('Gmail intake keeps job links and drops HTML assets and account links', () => {
  const urls = extractJobUrls([
    '<a href="https://www.linkedin.com/jobs/view/123">View job</a>',
    '<a href="https://www.linkedin.com/comm/jobs/search?originToLandingJobPostings=123&otpToken=secret">Search jobs</a>',
    '<img src="https://scontent.cdninstagram.com/image.jpg">',
    '<a href="https://accounts.google.com/AccountChooser?Email=jakyejobs@gmail.com">Manage account</a>',
    '<a href="https://www.teamworkonline.com/">TeamWork Online</a>',
    '<a href="https://www.teamworkonline.com/jobs-in-sports">Jobs in Sports</a>',
    '<a href="https://www.teamworkonline.com/jobs/2179445">View job</a>',
    '<a href="https://www.linkedin.com/comm/feed/">Open LinkedIn</a>',
    '<a href="https://www.teamworkonline.com/dashboard">Dashboard</a>',
    '<a href="https://www.glassdoor.com/partner/jobListing.htm?jobListingId=123&src=GD_JOB_AD&utm_campaign=jobs">Apply</a>',
    '<a href="https://www.glassdoor.com/Job/new-york-ny-software-engineer-jobs-SRCH.htm">Search jobs</a>',
    '<a href="https://email.supabase.com/e/c/encoded-tracking-id">View jobs</a>',
    '<a href="https://career41.sapsf.com/careers?company=example">Careers</a>',
  ].join(' '));
  assert.deepEqual(urls, [
    'https://www.linkedin.com/jobs/view/123',
    'https://www.teamworkonline.com/jobs/2179445',
    'https://www.glassdoor.com/partner/jobListing.htm?jobListingId=123',
  ]);
});

test('Gmail organizer rejects a different configured account', () => {
  assert.throws(() => assertTargetAccount('someone-else@example.com'), /jakyejobs@gmail\.com/);
  assert.doesNotThrow(() => assertTargetAccount('jakyejobs@gmail.com'));
});

test('filter plan applies parent/source labels and archives alerts', () => {
  const plan = buildFilterPlan({
    'Job Leads': 'parent',
    'Job Leads/LinkedIn': 'linkedin',
    'Job Leads/Handshake': 'handshake',
    'Job Leads/Wellfound': 'wellfound',
    'Job Leads/Built In': 'builtin',
    'Job Leads/TeamWork Online': 'teamwork',
  });
  assert.equal(plan.length, 10);
  assert.deepEqual(plan[0].action.removeLabelIds, ['INBOX', 'UNREAD']);
  assert.deepEqual(plan[0].action.addLabelIds, ['parent']);
  assert.deepEqual(plan[1].action.addLabelIds, ['linkedin']);
});

test('source filter queries use Gmail OR braces for multi-domain senders', () => {
  const plan = buildFilterPlan({ 'Job Leads': 'parent' });
  assert.match(plan.find((item) => item.source === 'handshake').criteria.query, /from:\{joinhandshake\.com handshake\.com\}/);
  assert.match(plan.find((item) => item.source === 'wellfound').criteria.query, /from:\{wellfound\.com angel\.co angellist\.com\}/);
});

test('launchd schedule is local 8 AM and never auto-submits', () => {
  const plist = buildLaunchdPlist('/tmp/career-ops', '/tmp/career-ops-logs');
  assert.match(plist, /<key>Hour<\/key><integer>8<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/);
  assert.match(plist, /queue-ui-launch\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(plist, /submit|apply --auto|captcha/i);
});

test('queue UI server plist stays local and persistent', () => {
  const plist = buildUiServerPlist('/tmp/career-ops', '/tmp/career-ops-logs');
  assert.match(plist, /queue-ui\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /queue-ui\.log/);
});

test('public liveness treats redirects as active without following them', async () => {
  let calls = 0;
  const result = await checkPublicLiveness('https://jobs.example.com/role/1', async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://elsewhere.example.com' } });
  });
  assert.equal(result, 'active');
  assert.equal(calls, 1);
});

test('queue scoring excludes senior and defense roles', () => {
  const senior = scoreCandidate({ title: 'Senior Backend Engineer', location: 'Remote US', liveness: 'active' }, {});
  const defense = scoreCandidate({ title: 'Software Engineer', description: 'Requires active security clearance', location: 'Remote US', liveness: 'active' }, {});
  assert.equal(senior.eligible, false);
  assert.equal(defense.eligible, false);
});

test('queue selection is capped and preserves applied state', () => {
  const candidates = Array.from({ length: 4 }, (_, index) => ({
    id: stableQueueId({ url: `https://example.com/${index}`, company: 'Example', title: `Backend Engineer ${index}` }),
    source: 'greenhouse',
    title: `Backend Engineer ${index}`,
    company: 'Example',
    location: 'Remote US',
    canonicalUrl: `https://example.com/${index}`,
    applyUrl: `https://example.com/${index}`,
    liveness: 'active',
    fitScore: 4.5 - index / 10,
    fitConfidence: 'high',
    fitReasons: ['test'],
    blockers: [],
    lane: 'backend_ai_platform',
    status: 'ready',
  }));
  const previous = { items: [{ ...candidates[0], status: 'applied', selectedForToday: false }] };
  const state = buildQueue(candidates, previous, { limit: 2 });
  assert.equal(state.items.filter((item) => item.selectedForToday).length, 2);
  assert.equal(state.items.find((item) => item.id === candidates[0].id).status, 'applied');
});

test('pipeline parser preserves URL and source note', () => {
  const [job] = parsePipeline('- [ ] https://jobs.lever.co/acme/123 | Acme | Backend Engineer | Remote US | note: source: teamwork-online; alert\n');
  assert.equal(job.company, 'Acme');
  assert.equal(job.title, 'Backend Engineer');
  assert.equal(job.source, 'teamwork-online');
});
