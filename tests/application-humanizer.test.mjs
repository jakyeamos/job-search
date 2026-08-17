import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANDIDATE_COPY_RECEIPT_SCHEMA,
  auditCandidateCopyStyle,
  auditHumanizedText,
  prepareCandidateCopy,
  protectedClaimTokens,
  validateCandidateCopyReceipt,
} from '../apply/application-humanizer.mjs';

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

test('candidate-copy receipt passes for the exact Humanizer output', () => {
  const raw = 'I cut production timelines by 90% in 2025.';
  const prepared = prepareCandidateCopy({
    artifactType: 'application-answer',
    raw,
    humanized: 'I reduced production timelines by 90% in 2025.',
  });
  assert.equal(prepared.receipt.schema, CANDIDATE_COPY_RECEIPT_SCHEMA);
  assert.equal(prepared.receipt.status, 'passed');
  assert.equal(prepared.finalReady, true);
  const validated = validateCandidateCopyReceipt({
    artifactType: 'application-answer',
    raw,
    humanized: prepared.humanized,
    output: prepared.output,
    receipt: prepared.receipt,
  });
  assert.equal(validated.ok, true);
});

test('candidate-copy receipt fails closed when it is missing', () => {
  const validated = validateCandidateCopyReceipt({
    artifactType: 'application-answer',
    raw: 'I built a reliable service.',
    humanized: 'I built a reliable service.',
    output: 'I built a reliable service.',
    receipt: null,
  });
  assert.equal(validated.ok, false);
  assert.match(validated.errors.join('\n'), /receipt is missing/);
});

test('candidate-copy receipt catches text changed after Humanizer', () => {
  const raw = 'I shipped 3 integrations in 2025.';
  const prepared = prepareCandidateCopy({
    artifactType: 'application-answer',
    raw,
    humanized: 'I shipped 3 integrations in 2025.',
  });
  const validated = validateCandidateCopyReceipt({
    artifactType: 'application-answer',
    raw,
    humanized: prepared.humanized,
    output: `${prepared.output} I also shipped 4 integrations.`,
    receipt: prepared.receipt,
  });
  assert.equal(validated.ok, false);
  assert.match(validated.errors.join('\n'), /output changed/);
});

test('candidate-copy receipt blocks bypassing Humanizer with the raw draft', () => {
  const raw = 'I cut production timelines by 90% in 2025.';
  const prepared = prepareCandidateCopy({
    artifactType: 'application-answer',
    raw,
    humanized: 'I reduced production timelines by 90% in 2025.',
  });
  const validated = validateCandidateCopyReceipt({
    artifactType: 'application-answer',
    raw,
    humanized: prepared.humanized,
    output: raw,
    receipt: prepared.receipt,
  });
  assert.equal(validated.ok, false);
  assert.match(validated.errors.join('\n'), /output changed/);
});

test('candidate-copy gate rejects em-dash output', () => {
  const style = auditCandidateCopyStyle('I built the service — and kept the claim intact.');
  assert.equal(style.passed, false);
  const prepared = prepareCandidateCopy({
    artifactType: 'application-answer',
    raw: 'I built the service and kept the claim intact.',
    humanized: 'I built the service — and kept the claim intact.',
  });
  assert.equal(prepared.finalReady, false);
  assert.match(prepared.receipt.humanizer.errors.join('\n'), /em dash/);
});
