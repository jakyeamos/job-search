import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateSocialRegistry } from './social.mjs';

const registryPath = resolve(process.cwd(), 'config/social.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

const failures = [];
try {
  validateSocialRegistry(registry);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}
const requiredLanes = ['tenure', 'engineering-systems', 'data-product-systems', 'client-delivery'];
const requiredProjects = ['tenure', 'aios', 'pre-cr-suite', 'quality-runner', 'bbdse-courtiq', 'signal-lab', 'forward-automations', 'bidcamp', 'crimclock', 'remodelvision', 'soundscape', 'github-issue-resolution-modeling', 'frmwrk-labs', 'chirons-forge'];

if (registry.schemaVersion !== 1) failures.push('config/social.json must use schemaVersion 1');
if (registry.identity?.graduationStatusPolicy?.includes('Do not include') !== true) failures.push('LinkedIn graduation-status policy is missing');
if (registry.publishing?.approval !== 'manual') failures.push('Publishing approval must remain manual');
if (registry.publishing?.linkedinAutomation !== false) failures.push('LinkedIn automation must remain disabled');
if (registry.publishing?.xLivePosting !== false) failures.push('X live posting must remain disabled');
const blockedGraduationPattern = /May 2026|Spring 2027|Expected|two course|two class|remaining course/i;
if (blockedGraduationPattern.test(registry.profiles?.linkedin?.headline ?? '') || blockedGraduationPattern.test(registry.profiles?.linkedin?.about ?? '') || blockedGraduationPattern.test(registry.profiles?.linkedin?.educationLabel ?? '')) failures.push('LinkedIn-facing profile copy contains graduation-status wording');
if (/Current work:|Projects and longer notes:|Proof:|Sources:/i.test(registry.profiles?.x?.pinnedPost ?? '')) failures.push('X pinned post contains inventory or metadata labels');
if ((registry.profiles?.x?.pinnedPost ?? '').length > 280) failures.push('X pinned post exceeds 280 characters');
const requiredWritingProfiles = ['linkedin', 'x', 'instagram', 'native-video', 'portfolio', 'frmwrk-labs'];
for (const profile of requiredWritingProfiles) if (!registry.writing?.profiles?.[profile]) failures.push(`Missing writing profile: ${profile}`);
const requiredPlatformStrategies = ['linkedin', 'x', 'instagram', 'native-video', 'portfolio', 'frmwrk-labs'];
for (const platform of requiredPlatformStrategies) {
  const strategy = registry.platformStrategy?.[platform];
  if (!strategy?.purpose || !strategy?.formats?.length || !strategy?.rules?.length || !strategy?.successMetrics?.length) {
    failures.push(`Missing platform strategy: ${platform}`);
  }
}
if (!existsSync(resolve(process.cwd(), 'social/platform-research.md'))) failures.push('Missing platform-wide social research artifact');
if (!registry.writing?.general?.avoid?.includes('Current work:')) failures.push('General humanizer must block Current work labels');
const requiredAtomFields = ['sourceProject', 'claimRefs', 'proofArtifact', 'platforms', 'audience', 'asset', 'status', 'context', 'personalAngle', 'nextStep', 'voiceProfile'];
const requiredOutcomeFields = ['publicationOutcome', 'impressions', 'profileVisits', 'projectClicks', 'recruiterReplies', 'conversations', 'referrals', 'interviews', 'notes'];
for (const field of requiredAtomFields) if (!registry.contentModel?.atomFields?.includes(field)) failures.push(`Missing social atom field: ${field}`);
for (const field of requiredOutcomeFields) if (!registry.contentModel?.outcomeFields?.includes(field)) failures.push(`Missing social outcome field: ${field}`);

const laneIds = new Set((registry.lanes ?? []).map((lane) => lane.id));
for (const lane of requiredLanes) if (!laneIds.has(lane)) failures.push(`Missing lane: ${lane}`);

const projects = new Map((registry.projects ?? []).map((project) => [project.slug, project]));
for (const project of requiredProjects) {
  const record = projects.get(project);
  if (!record) failures.push(`Missing project: ${project}`);
  else if (!laneIds.has(record.lane)) failures.push(`${project} references an unknown lane`);
}

const backlog = registry.backlog ?? [];
if (backlog.length !== 16) failures.push(`Expected 16 backlog items, found ${backlog.length}`);
if (backlog.filter((item) => item.lane === 'tenure').length !== 4) failures.push('Tenure backlog must contain four items');
if (backlog.filter((item) => item.lane === 'engineering-systems').length !== 4) failures.push('Engineering-systems backlog must contain four items');
if (backlog.filter((item) => item.lane === 'data-product-systems').length !== 4) failures.push('Data/product backlog must contain four items');
if (backlog.filter((item) => item.lane === 'client-delivery').length !== 4) failures.push('Client-delivery backlog must contain four items');
if (backlog.filter((item) => item.video === true).length !== 4) failures.push('Backlog must contain four video items');
if (backlog.some((item) => !item.sourceRefs?.length || !item.proofArtifact || !item.context || !item.personalAngle || !item.nextStep || !item.voiceProfile)) failures.push('Every backlog item needs sources, proof, human context, and a voice profile');

const tenure = projects.get('tenure');
if (tenure?.doNotClaim?.includes('customers') !== true || tenure?.doNotClaim?.includes('revenue') !== true) {
  failures.push('Tenure must block customer and revenue claims');
}
const crimclock = projects.get('crimclock');
if (crimclock?.doNotClaim?.includes('legal advice') !== true) failures.push('CrimClock must block legal-advice claims');

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Social registry valid: ${projects.size} projects, ${backlog.length} backlog items, ${backlog.filter((item) => item.video).length} video items.`);
}
