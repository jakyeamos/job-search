import test from 'node:test';
import assert from 'node:assert/strict';

import teamworkOnline, { parseTeamworkOnlinePage } from '../providers/teamworkonline.mjs';

const PAGE_ONE = `
<div class="organization-portal__job-details">
  <h3 class="organization-portal__job-title"><a href="/sports-technology-jobs/swish-analytics-jobs/swish-analytics-jobs/data-engineer-2181132">Data Engineer &amp; AI</a></h3>
  <p class="organization-portal__job-category">Swish Analytics</p>
  <p class="organization-portal__job-location">San Francisco · Remote</p>
  <span class="organization-portal__job__career-level">Senior</span>
</div>
<div class="organization-portal__job-details">
  <h3 class="organization-portal__job-title"><a href="/sports-technology-jobs/prize-picks/prizepicks-jobs/partnerships-coordinator-2179005">Partnerships Coordinator</a></h3>
  <p class="organization-portal__job-category">PrizePicks</p>
  <p class="organization-portal__job-location">Atlanta · GA</p>
  <span class="organization-portal__job__career-level">Entry Level</span>
</div>
<a rel="next" href="?page=2">Next</a>
`;

test('TeamWork Online parser normalizes public category cards and host-locks job links', () => {
  const jobs = parseTeamworkOnlinePage(PAGE_ONE, 'https://www.teamworkonline.com/sports-technology-jobs/sports-technology-careers/sports-technology-jobs');
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    title: 'Data Engineer & AI',
    url: 'https://www.teamworkonline.com/sports-technology-jobs/swish-analytics-jobs/swish-analytics-jobs/data-engineer-2181132',
    company: 'Swish Analytics',
    location: 'San Francisco · Remote',
    careerLevel: 'Senior',
  });
  assert.equal(jobs[1].company, 'PrizePicks');
});

test('TeamWork Online parser can exclude source career levels before queue filtering', () => {
  const jobs = parseTeamworkOnlinePage(PAGE_ONE, undefined, { excludedCareerLevels: ['Senior'] });
  assert.deepEqual(jobs.map((job) => job.title), ['Partnerships Coordinator']);
});

test('TeamWork Online provider fetches a bounded paginated category', async () => {
  const calls = [];
  const pageTwo = PAGE_ONE.replace(/<a rel="next"[\s\S]*?<\/a>/, '');
  const result = await teamworkOnline.fetch({
    provider: 'teamworkonline',
    careers_url: 'https://www.teamworkonline.com/sports-technology-jobs/sports-technology-careers/sports-technology-jobs',
    max_pages: 2,
  }, {
    fetchText: async (url) => {
      calls.push(url);
      return calls.length === 1 ? PAGE_ONE : pageTwo;
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /[?&]page=2/);
  assert.equal(result.length, 2);
});
