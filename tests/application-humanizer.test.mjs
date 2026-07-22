import test from 'node:test';
import assert from 'node:assert/strict';

import { auditHumanizedText, protectedClaimTokens } from '../apply/application-humanizer.mjs';

test('humanizer audit preserves concrete claims', () => {
  const raw = 'I cut production timelines by 90% and shipped 3 integrations in 2025: https://example.com/project.';
  assert.deepEqual(protectedClaimTokens(raw), ['https://example.com/project.', '90%', '3', '2025']);
  const passed = auditHumanizedText(raw, 'I reduced production timelines by 90% and shipped 3 integrations in 2025: https://example.com/project.');
  assert.equal(passed.status, 'passed');
  assert.equal(passed.passed, true);
});

test('humanizer audit flags changed metrics and keeps the raw draft available', () => {
  const raw = 'Built a $160k workflow in 2024.';
  const flagged = auditHumanizedText(raw, 'Built a high-value workflow recently.');
  assert.equal(flagged.status, 'flagged');
  assert.equal(flagged.passed, false);
  assert.deepEqual(flagged.missingClaims, ['$160k', '2024']);
  const pending = auditHumanizedText(raw, '');
  assert.equal(pending.status, 'pending');
});
