#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanizeText, runSocialWritingPipeline } from './social-writing.mjs';

export { humanizeText, runSocialWritingPipeline };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOCIAL_REGISTRY_PATH = path.join(ROOT, 'config', 'social.json');
export const SOCIAL_PLATFORMS = ['linkedin', 'x', 'instagram', 'native-video', 'owned-article'];
export const SOCIAL_OUTCOMES = ['drafted', 'approved', 'published', 'skipped'];

const LANE_PRIORITY = {
  tenure: 28,
  'engineering-systems': 26,
  'data-product-systems': 24,
  'client-delivery': 16,
};

export function readSocialRegistry(registryPath = DEFAULT_SOCIAL_REGISTRY_PATH) {
  const resolvedPath = path.resolve(registryPath);
  if (!existsSync(resolvedPath)) throw new Error(`Social registry does not exist: ${resolvedPath}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse social registry ${resolvedPath}: ${errorMessage(error)}`);
  }
  validateSocialRegistry(parsed);
  return parsed;
}

export function validateSocialRegistry(registry) {
  const failures = [];
  if (!isRecord(registry)) throw new Error('Invalid social registry: root must be an object');
  if (registry.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (!isRecord(registry.identity) || !String(registry.identity.name || '').trim()) failures.push('identity.name is required');
  if (!String(registry.identity?.graduationStatusPolicy || '').includes('Do not include')) {
    failures.push('LinkedIn graduation-status policy must explicitly block graduation wording');
  }
  if (registry.publishing?.approval !== 'manual') failures.push('Publishing approval must remain manual');
  if (registry.publishing?.linkedinAutomation !== false) failures.push('LinkedIn automation must remain disabled');
  if (registry.publishing?.xLivePosting !== false) failures.push('X live posting must remain disabled');
  if (!Array.isArray(registry.lanes) || registry.lanes.length === 0) failures.push('At least one lane is required');
  if (!Array.isArray(registry.projects) || registry.projects.length === 0) failures.push('At least one project is required');
  if (!Array.isArray(registry.backlog) || registry.backlog.length === 0) failures.push('At least one backlog item is required');

  const laneIds = new Set();
  for (const lane of registry.lanes || []) {
    if (!String(lane?.id || '').trim()) failures.push('Every lane needs an id');
    if (laneIds.has(lane.id)) failures.push(`Duplicate lane: ${lane.id}`);
    laneIds.add(lane.id);
  }

  const projectSlugs = new Set();
  for (const project of registry.projects || []) {
    if (!String(project?.slug || '').trim()) failures.push('Every project needs a slug');
    if (projectSlugs.has(project.slug)) failures.push(`Duplicate project: ${project.slug}`);
    projectSlugs.add(project.slug);
    if (!laneIds.has(project.lane)) failures.push(`${project.slug} references unknown lane ${project.lane}`);
    if (!Array.isArray(project.publicClaims) || !Array.isArray(project.doNotClaim)) {
      failures.push(`${project.slug} needs publicClaims and doNotClaim arrays`);
    }
  }

  const backlogIds = new Set();
  for (const item of registry.backlog || []) {
    if (!String(item?.id || '').trim()) failures.push('Every backlog item needs an id');
    if (backlogIds.has(item.id)) failures.push(`Duplicate backlog item: ${item.id}`);
    backlogIds.add(item.id);
    if (!laneIds.has(item.lane)) failures.push(`${item.id} references unknown lane ${item.lane}`);
    const project = (registry.projects || []).find((candidate) => candidate.slug === item.project);
    if (!project) failures.push(`${item.id} references unknown project ${item.project}`);
    if (project && project.lane !== item.lane) failures.push(`${item.id} lane does not match project lane`);
    for (const field of ['title', 'hook', 'context', 'personalAngle', 'nextStep', 'voiceProfile', 'proofArtifact']) {
      if (!String(item[field] || '').trim()) failures.push(`${item.id} needs ${field}`);
    }
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0) failures.push(`${item.id} needs sourceRefs`);
  }

  const writingProfiles = ['linkedin', 'x', 'instagram', 'native-video', 'portfolio', 'frmwrk-labs'];
  for (const profile of writingProfiles) {
    if (!registry.writing?.profiles?.[profile]) failures.push(`Missing writing profile: ${profile}`);
    if (!registry.platformStrategy?.[profile]) failures.push(`Missing platform strategy: ${profile}`);
  }
  if (!registry.writing?.general?.avoid?.includes('Current work:')) {
    failures.push('General humanizer must block Current work labels');
  }

  const tenure = (registry.projects || []).find((project) => project.slug === 'tenure');
  if (tenure && !['customers', 'revenue', 'completed pilots'].every((blocked) => tenure.doNotClaim.includes(blocked))) {
    failures.push('Tenure must block customer, revenue, and completed-pilot claims');
  }
  const crimclock = (registry.projects || []).find((project) => project.slug === 'crimclock');
  if (crimclock && !crimclock.doNotClaim.includes('legal advice')) failures.push('CrimClock must block legal-advice claims');

  if (failures.length > 0) throw new Error(`Invalid social registry: ${failures.join('; ')}`);
  return registry;
}

export function parseSocialPlatform(value) {
  if (!SOCIAL_PLATFORMS.includes(value)) throw new Error(`Unsupported social platform: ${value}`);
  return value;
}

export function parseSocialOutcome(value) {
  if (!SOCIAL_OUTCOMES.includes(value)) throw new Error(`Unsupported social publication outcome: ${value}`);
  return value;
}

export function readSocialOutcomes(workspace = ROOT) {
  const outcomePath = socialOutcomePath(workspace);
  if (!existsSync(outcomePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(outcomePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse social outcomes ${outcomePath}: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Malformed social outcomes ${outcomePath}: expected an array`);
  for (const outcome of parsed) {
    if (!isRecord(outcome) || !outcome.itemId || !SOCIAL_PLATFORMS.includes(outcome.platform) || !SOCIAL_OUTCOMES.includes(outcome.publicationOutcome)) {
      throw new Error(`Malformed social outcomes ${outcomePath}: invalid outcome record`);
    }
  }
  return parsed;
}

export function buildSocialPlan(registry, outcomes = []) {
  validateSocialRegistry(registry);
  const allItems = registry.backlog.map((item) => {
    const project = projectFor(registry, item.project);
    const lane = laneFor(registry, item.lane);
    return rankSocialItem(item, project, lane, registry.platformStrategy, outcomes);
  });
  const publishedItems = new Set(outcomes.filter((outcome) => outcome.publicationOutcome === 'published').map((outcome) => outcome.itemId));
  const openItems = allItems.filter((item) => !isClosedStatus(item.item.status) && !item.published);
  const next = [...openItems].sort(compareRankedItems).slice(0, 5);
  const laneSummary = registry.lanes.map((lane) => {
    const laneItems = allItems.filter((item) => item.lane.id === lane.id);
    return {
      id: lane.id,
      title: lane.title,
      kind: lane.kind,
      contentBudget: lane.contentBudget,
      backlogCount: laneItems.length,
      openCount: laneItems.filter((item) => !isClosedStatus(item.item.status) && !item.published).length,
      publishedCount: laneItems.filter((item) => publishedItems.has(item.item.id)).length,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    identity: registry.identity,
    publishing: registry.publishing,
    profiles: registry.profiles,
    writing: registry.writing,
    platformStrategy: registry.platformStrategy,
    laneSummary,
    backlog: allItems,
    next,
    metrics: {
      totalItems: allItems.length,
      openItems: openItems.length,
      videoItems: allItems.filter((item) => item.item.video).length,
      publishedItems: publishedItems.size,
      outcomeRecords: outcomes.length,
    },
  };
}

export function writeSocialPlan(workspace = ROOT, registryPath = DEFAULT_SOCIAL_REGISTRY_PATH) {
  const registry = readSocialRegistry(registryPath);
  const plan = buildSocialPlan(registry, readSocialOutcomes(workspace));
  const outputDirectory = socialOutputDirectory(workspace);
  mkdirSync(outputDirectory, { recursive: true });
  const planPath = path.join(outputDirectory, 'social-plan.json');
  const markdownPath = path.join(outputDirectory, 'social-backlog.md');
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, `${renderSocialBacklog(plan)}\n`, 'utf8');
  return { planPath, markdownPath, outcomePath: socialOutcomePath(workspace), plan };
}

export function writeSocialBackfill(workspace = ROOT, registryPath = DEFAULT_SOCIAL_REGISTRY_PATH) {
  const registry = readSocialRegistry(registryPath);
  const variants = registry.backlog.flatMap((item) => {
    const platforms = ['linkedin', 'x', 'owned-article'];
    if (item.video) platforms.push('native-video');
    return platforms.map((platform) => buildSocialVariant(registry, item.id, platform));
  });
  const outputDirectory = socialOutputDirectory(workspace);
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'social-backfill.json');
  writeFileSync(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), variants }, null, 2)}\n`, 'utf8');
  return { outputPath, variantCount: variants.length, variants };
}

export function renderSocialBacklog(plan) {
  const rows = plan.next
    .map((item, index) => `| ${index + 1} | ${item.rankScore} | ${markdownCell(item.lane.title)} | ${markdownCell(item.project.name)} | ${item.item.slot} | ${item.item.status} | ${markdownCell(item.item.title)} |`)
    .join('\n');
  const laneRows = plan.laneSummary
    .map((lane) => `| ${markdownCell(lane.title)} | ${lane.kind} | ${lane.contentBudget} | ${lane.backlogCount} | ${lane.openCount} | ${lane.publishedCount} |`)
    .join('\n');
  return [
    '# Career-Ops Social Proof Queue',
    '',
    `Generated: ${plan.generatedAt}`,
    `Approval: ${plan.publishing.approval}; LinkedIn automation: ${plan.publishing.linkedinAutomation ? 'enabled' : 'disabled'}; X live posting: ${plan.publishing.xLivePosting ? 'enabled' : 'disabled'}`,
    '',
    '## Publish next',
    '',
    '| Rank | Score | Lane | Project | Slot | Status | Content atom |',
    '| ---: | ---: | --- | --- | --- | --- | --- |',
    rows || '| - | - | - | - | - | - | No open content atoms |',
    '',
    '## Lane budget',
    '',
    '| Lane | Kind | Budget | Atoms | Open | Published |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    laneRows,
    '',
    '## Platform rules from current research',
    '',
    ...Object.entries(plan.platformStrategy).flatMap(([platform, strategy]) => [
      `### ${platform}`,
      `**Purpose:** ${strategy.purpose}`,
      `**Formats:** ${strategy.formats.join(', ')}`,
      `**Rules:** ${strategy.rules.join(' ')}`,
      `**Link rule:** ${strategy.linkRule}`,
      `**Success metrics:** ${strategy.successMetrics.join(', ')}`,
      `**Sources:** ${strategy.sourceRefs.join(', ')}`,
      '',
    ]),
    '## Operating rule',
    '',
    'Every generated variant remains a draft until human review. LinkedIn is manual copy/paste; X stays dry-run/manual until explicitly enabled.',
  ].join('\n');
}

export function buildSocialVariant(registry, itemId, platform) {
  validateSocialRegistry(registry);
  parseSocialPlatform(platform);
  const item = registry.backlog.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Unknown social backlog item: ${itemId}`);
  const project = projectFor(registry, item.project);
  const lane = laneFor(registry, item.lane);
  const brief = {
    title: item.title,
    project: project.name,
    projectStatus: project.publicStatus,
    lane: lane.title,
    laneNarrative: lane.narrative,
    hook: item.hook,
    context: item.context,
    personalAngle: item.personalAngle,
    nextStep: item.nextStep,
    voiceProfile: item.voiceProfile,
    doNotClaim: project.doNotClaim,
    proofArtifact: item.proofArtifact,
  };
  const destination = platform === 'owned-article' ? 'portfolio' : platform;
  const humanization = runSocialWritingPipeline(brief, registry.writing, destination);
  const destinationVariants = platform === 'owned-article'
    ? ['portfolio', 'frmwrk-labs'].map((destinationId) => {
        const destinationHumanization = runSocialWritingPipeline(brief, registry.writing, destinationId);
        return { destination: destinationId, profileId: destinationHumanization.profileId, body: destinationHumanization.finalBody };
      })
    : undefined;
  const base = {
    itemId,
    platform,
    title: item.title,
    project: project.name,
    lane: lane.title,
    body: humanization.finalBody,
    sourceRefs: [...item.sourceRefs],
    proofArtifact: item.proofArtifact,
    publicSurfaces: [...project.publicSurfaces],
    approvalRequired: true,
    archiveTargets: platform === 'owned-article' ? [...registry.publishing.ownedArchive] : [],
    safetyNotes: [...project.doNotClaim],
    rawBody: humanization.rawBody,
    humanization,
    destinationVariants,
  };
  if (platform === 'native-video') {
    return {
      ...base,
      assetBrief: [
        '0-2s - Hook: name the problem or put the relevant working surface on screen immediately.',
        '2-20s - Working surface: show the real product, CLI, report, diagram, or approved screen recording.',
        '20-45s - Technical point: explain one important architecture or product decision.',
        `45-75s - Current limitation/next step: name the honest boundary and point to ${project.publicStatus}.`,
      ],
    };
  }
  return base;
}

export function recordSocialOutcome(workspace, registryPath, input) {
  const registry = readSocialRegistry(registryPath);
  if (!registry.backlog.some((item) => item.id === input.itemId)) throw new Error(`Unknown social backlog item: ${input.itemId}`);
  parseSocialPlatform(input.platform);
  parseSocialOutcome(input.publicationOutcome);
  const outcome = { ...input, recordedAt: new Date().toISOString() };
  for (const field of ['impressions', 'profileVisits', 'projectClicks', 'recruiterReplies', 'conversations', 'referrals', 'interviews']) {
    if (outcome[field] !== undefined && (!Number.isInteger(outcome[field]) || outcome[field] < 0)) throw new Error(`${field} must be a non-negative integer`);
  }
  const outcomes = [...readSocialOutcomes(workspace), outcome];
  const outputDirectory = socialOutputDirectory(workspace);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(socialOutcomePath(workspace), `${JSON.stringify(outcomes, null, 2)}\n`, 'utf8');
  return outcome;
}

export function getSocialPlanStatus(workspace = ROOT, registryPath = DEFAULT_SOCIAL_REGISTRY_PATH) {
  const resolvedPath = path.resolve(registryPath);
  try {
    const registry = readSocialRegistry(resolvedPath);
    const plan = buildSocialPlan(registry, readSocialOutcomes(workspace));
    return {
      available: true,
      registryPath: resolvedPath,
      registryLabel: 'career-ops/config/social.json',
      message: null,
      laneCount: registry.lanes.length,
      projectCount: registry.projects.length,
      backlogCount: plan.metrics.totalItems,
      openCount: plan.metrics.openItems,
      videoCount: plan.metrics.videoItems,
      publishedCount: plan.metrics.publishedItems,
      outcomeCount: plan.metrics.outcomeRecords,
      manualApproval: plan.publishing.approval === 'manual',
      linkedinAutomation: plan.publishing.linkedinAutomation,
      xLivePosting: plan.publishing.xLivePosting,
      next: plan.next.map((item) => ({ itemId: item.item.id, title: item.item.title, project: item.project.name, lane: item.lane.title, score: item.rankScore, status: item.item.status })),
    };
  } catch (error) {
    return {
      available: false,
      registryPath: resolvedPath,
      registryLabel: 'career-ops/config/social.json',
      message: errorMessage(error),
      laneCount: 0,
      projectCount: 0,
      backlogCount: 0,
      openCount: 0,
      videoCount: 0,
      publishedCount: 0,
      outcomeCount: 0,
      manualApproval: true,
      linkedinAutomation: false,
      xLivePosting: false,
      next: [],
    };
  }
}

function rankSocialItem(item, project, lane, platformStrategy, outcomes) {
  const itemOutcomes = outcomes.filter((outcome) => outcome.itemId === item.id);
  const published = itemOutcomes.some((outcome) => outcome.publicationOutcome === 'published');
  const scoreParts = [LANE_PRIORITY[lane.id] || 10];
  const reasons = [];
  scoreParts.push(lane.kind === 'flagship' ? 12 : 4);
  reasons.push(lane.kind === 'flagship' ? 'flagship narrative' : 'supporting proof');
  if (project.tier === 'flagship') { scoreParts.push(8); reasons.push('flagship project'); }
  if (item.sourceRefs.length >= 2) { scoreParts.push(6); reasons.push('multiple verified sources'); }
  else { scoreParts.push(3); reasons.push('verified source'); }
  if (item.proofArtifact.length > 0) { scoreParts.push(6); reasons.push('named proof artifact'); }
  if (item.video && project.videoEligible) { scoreParts.push(7); reasons.push('visual proof slot'); }
  if (item.video && platformStrategy.instagram) { scoreParts.push(4); reasons.push('original visual format fits discovery'); }
  if (project.publicSurfaces.length > 0 && platformStrategy.portfolio) { scoreParts.push(3); reasons.push('owned proof surface available'); }
  if (item.status === 'backlog') { scoreParts.push(8); reasons.push('ready to draft'); }
  else if (item.status === 'needs-asset') { scoreParts.push(2); reasons.push('needs approved asset'); }
  else if (item.status === 'needs-approval') { scoreParts.push(-12); reasons.push('approval gate'); }
  const fatiguePenalty = Math.min(itemOutcomes.length * 8, 24);
  if (fatiguePenalty > 0) { scoreParts.push(-fatiguePenalty); reasons.push(`${itemOutcomes.length} prior outcome record${itemOutcomes.length === 1 ? '' : 's'}`); }
  if (published) { scoreParts.push(-100); reasons.push('already published'); }
  return {
    item,
    project,
    lane,
    platforms: item.video ? ['linkedin', 'x', 'instagram', 'native-video', 'owned-article'] : ['linkedin', 'x', 'owned-article'],
    audience: audienceFor(lane, item),
    asset: item.video ? 'approved-native-video' : 'text-plus-proof-artifact',
    claimRefs: [...item.sourceRefs],
    rankScore: scoreParts.reduce((total, value) => total + value, 0),
    rankingReasons: reasons,
    outcomeCount: itemOutcomes.length,
    published,
  };
}

function compareRankedItems(left, right) { return right.rankScore - left.rankScore || left.item.id.localeCompare(right.item.id); }
function isClosedStatus(status) { return status === 'published' || status === 'archived'; }
function audienceFor(lane, item) {
  if (item.format === 'technical-tradeoff' || item.format === 'failure-note') return 'technical-builders';
  if (lane.id === 'client-delivery' || item.format === 'linkedin-case-study') return 'hiring-reviewers';
  return 'operator-peers';
}
function projectFor(registry, slug) { const project = registry.projects.find((candidate) => candidate.slug === slug); if (!project) throw new Error(`Unknown social project: ${slug}`); return project; }
function laneFor(registry, id) { const lane = registry.lanes.find((candidate) => candidate.id === id); if (!lane) throw new Error(`Unknown social lane: ${id}`); return lane; }
function socialOutputDirectory(workspace) { return path.join(workspace, 'output', 'social'); }
function socialOutcomePath(workspace) { return path.join(socialOutputDirectory(workspace), 'social-outcomes.json'); }
function markdownCell(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

function optionValue(options, name, fallback = undefined) { return options[name] === undefined ? fallback : options[name]; }
function parseArgs(args) {
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'status';
  const options = {};
  for (let index = command === args[0] ? 1 : 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const [key, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (args[index + 1] && !args[index + 1].startsWith('--')) { options[key] = args[index + 1]; index += 1; }
    else options[key] = true;
  }
  return { command, options };
}

export function main(args = process.argv.slice(2)) {
  const { command, options } = parseArgs(args);
  const workspace = path.resolve(String(optionValue(options, 'workspace', ROOT)));
  const registryPath = path.resolve(String(optionValue(options, 'registry', DEFAULT_SOCIAL_REGISTRY_PATH)));
  try {
    if (command === 'verify') {
      const registry = readSocialRegistry(registryPath);
      console.log(JSON.stringify({ valid: true, projects: registry.projects.length, backlogItems: registry.backlog.length, videoItems: registry.backlog.filter((item) => item.video).length }, null, 2));
      return;
    }
    if (command === 'plan') {
      const result = writeSocialPlan(workspace, registryPath);
      console.log(JSON.stringify({ ...result.plan.metrics, planPath: result.planPath, markdownPath: result.markdownPath, outcomePath: result.outcomePath }, null, 2));
      return;
    }
    if (command === 'backfill') {
      const result = writeSocialBackfill(workspace, registryPath);
      console.log(JSON.stringify({ variantCount: result.variantCount, outputPath: result.outputPath }, null, 2));
      return;
    }
    if (command === 'next') {
      const registry = readSocialRegistry(registryPath);
      const plan = buildSocialPlan(registry, readSocialOutcomes(workspace));
      const limit = Number(optionValue(options, 'limit', 5));
      console.log(JSON.stringify(plan.next.slice(0, Number.isFinite(limit) ? limit : 5), null, 2));
      return;
    }
    if (command === 'variant') {
      const itemId = String(optionValue(options, 'item', ''));
      const platform = parseSocialPlatform(String(optionValue(options, 'platform', '')));
      console.log(JSON.stringify(buildSocialVariant(readSocialRegistry(registryPath), itemId, platform), null, 2));
      return;
    }
    if (command === 'outcome') {
      const numericFields = ['impressions', 'profileVisits', 'projectClicks', 'recruiterReplies', 'conversations', 'referrals', 'interviews'];
      const input = {
        itemId: String(optionValue(options, 'item', '')),
        platform: parseSocialPlatform(String(optionValue(options, 'platform', ''))),
        publicationOutcome: parseSocialOutcome(String(optionValue(options, 'publication-outcome', ''))),
        notes: optionValue(options, 'notes'),
      };
      for (const field of numericFields) if (options[field] !== undefined) input[field] = Number(options[field]);
      console.log(JSON.stringify(recordSocialOutcome(workspace, registryPath, input), null, 2));
      return;
    }
    if (command === 'status') {
      console.log(JSON.stringify(getSocialPlanStatus(workspace, registryPath), null, 2));
      return;
    }
    console.log('Usage: pnpm social <verify|plan|backfill|next|variant|outcome|status> [options]');
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
