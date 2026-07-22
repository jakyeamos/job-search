import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSocialPlan,
  buildSocialVariant,
  readSocialRegistry,
  recordSocialOutcome,
  writeSocialBackfill,
} from '../social.mjs';

const registry = readSocialRegistry();

test('builds the canonical social queue with the expected proof inventory', () => {
  const plan = buildSocialPlan(registry);

  assert.equal(plan.metrics.totalItems, registry.backlog.length);
  assert.equal(plan.metrics.videoItems, registry.backlog.filter((item) => item.video).length);
  assert.equal(plan.publishing.approval, 'manual');
  assert.equal(plan.publishing.linkedinAutomation, false);
  assert.equal(plan.publishing.xLivePosting, false);
  assert.ok(plan.next.length > 0);
});

test('backfills reviewable variants without publishing them', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'career-ops-social-'));
  const result = writeSocialBackfill(workspace);

  assert.equal(result.variantCount, registry.backlog.reduce((count, item) => count + (item.video ? 4 : 3), 0));
  assert.ok(existsSync(result.outputPath));
  assert.ok(result.variants.every((variant) => variant.approvalRequired === true));
  assert.ok(result.variants.some((variant) => variant.platform === 'native-video'));
  assert.ok(result.variants.some((variant) => variant.platform === 'owned-article' && variant.destinationVariants?.length === 2));
});

test('renders platform variants with claim-safe humanization and review stages', () => {
  const item = registry.backlog.find((candidate) => candidate.id === 'tenure-problem') || registry.backlog[0];
  const variant = buildSocialVariant(registry, item.id, 'x');

  assert.equal(variant.approvalRequired, true);
  assert.ok(variant.body.length <= 280);
  assert.deepEqual(variant.humanization.stages.map((stage) => stage.id), [
    'source-brief',
    'domain-draft',
    'domain-qa',
    'general-humanizer',
    'destination-voice',
    'approval',
  ]);
  assert.equal(variant.humanization.stages.at(-1).status, 'pending');
});

test('records publication outcomes and removes published atoms from the open queue', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'career-ops-social-outcome-'));
  const item = registry.backlog[0];
  const before = buildSocialPlan(registry).metrics.openItems;

  recordSocialOutcome(workspace, undefined, {
    itemId: item.id,
    platform: 'linkedin',
    publicationOutcome: 'published',
    impressions: 12,
  });
  const after = buildSocialPlan(registry, [{ itemId: item.id, platform: 'linkedin', publicationOutcome: 'published' }]);

  assert.equal(after.metrics.openItems, before - 1);
  assert.equal(after.metrics.publishedItems, 1);
});
