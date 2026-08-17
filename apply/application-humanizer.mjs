#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';

export const CANDIDATE_COPY_RECEIPT_SCHEMA = 'candidate-copy-quality-receipt/v1';
export const CANDIDATE_COPY_RECEIPT_VERSION = 1;

/** @param {string} value */
function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
/** @param {string} value */
function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

/** @param {unknown} value */
function exactText(value) {
  return String(value ?? '');
}

/** @param {unknown} value */
export function exactCopyHash(value) {
  return createHash('sha256').update(exactText(value)).digest('hex');
}

/** @param {string} text */
export function protectedClaimTokens(text) {
  const value = String(text || '');
  return [...new Set([
    ...(value.match(/https?:\/\/[^\s)]+/gi) || []),
    ...(value.match(/\$?\d+(?:\.\d+)?(?:%|[kKmMbB])?/g) || []),
    ...(value.match(/\b(?:19|20)\d{2}\b/g) || []),
    ...(value.match(/\b\d+(?:\.\d+)?x\b/gi) || []),
  ])];
}

/**
 * Check a humanizer revision without attempting to judge style. The revision
 * must preserve concrete claims from the evidence-bound draft; a missing or
 * empty revision remains pending rather than being treated as approved.
 * @param {string} raw
 * @param {string} humanized
 */
export function auditHumanizedText(raw, humanized) {
  const draft = normalize(raw);
  const revision = normalize(humanized);
  if (!revision) return { status: 'pending', passed: false, errors: ['humanized text is missing'], protectedClaims: protectedClaimTokens(draft), rawHash: hash(draft), humanizedHash: '' };
  const protectedClaims = protectedClaimTokens(draft);
  const missingClaims = protectedClaims.filter((claim) => !revision.includes(claim));
  return {
    status: missingClaims.length ? 'flagged' : 'passed',
    passed: missingClaims.length === 0,
    errors: missingClaims.length ? [`humanized text changed protected claims: ${missingClaims.join(', ')}`] : [],
    protectedClaims,
    missingClaims,
    rawHash: hash(draft),
    humanizedHash: hash(revision),
  };
}

/** @param {unknown} text */
export function auditCandidateCopyStyle(text) {
  const value = exactText(text);
  const errors = [];
  if (/[—–]/u.test(value)) errors.push('humanized text still contains an em dash or en dash');
  return {
    status: errors.length ? 'flagged' : 'passed',
    passed: errors.length === 0,
    errors,
  };
}

/**
 * Build the content-bound receipt used by candidate-facing copy. The
 * Humanizer is an agent stage, so the executable guard verifies its output,
 * preserves concrete claims, and binds the exact text to the receipt. It
 * does not pretend that a hash proves the quality of the prose by itself.
 *
 * @param {{ artifactType?: string, raw?: unknown, humanized?: unknown, approvedText?: unknown, approved?: boolean }} [input]
 */
export function prepareCandidateCopy(input = {}) {
  const artifactType = exactText(input.artifactType || 'candidate-copy');
  const raw = exactText(input.raw);
  const humanized = exactText(input.humanized);
  const approvedText = exactText(input.approvedText);
  const revision = humanized || approvedText;
  const humanization = auditHumanizedText(raw, revision);
  const approvedAudit = approvedText ? auditHumanizedText(raw, approvedText) : null;
  const humanizedPassed = humanization.passed;
  const approvedPassed = Boolean(approvedAudit?.passed);
  const claimReady = humanizedPassed || approvedPassed;
  const output = claimReady
    ? (approvedPassed ? approvedText : humanized)
    : raw;
  const finalAudit = approvedPassed ? approvedAudit : humanization;
  const style = auditCandidateCopyStyle(output);
  const finalReady = claimReady && style.passed;
  const approvalPassed = finalReady && (approvedPassed || (input.approved === true && humanizedPassed));
  const status = finalReady ? 'passed' : revision ? 'flagged' : 'pending';
  const receipt = {
    schema: CANDIDATE_COPY_RECEIPT_SCHEMA,
    version: CANDIDATE_COPY_RECEIPT_VERSION,
    artifactType,
    status,
    passed: finalReady,
    finalReady,
    inputHash: exactCopyHash(raw),
    rawHash: exactCopyHash(raw),
    humanizedHash: exactCopyHash(revision),
    outputHash: exactCopyHash(output),
    protectedClaims: finalAudit?.protectedClaims || [],
    missingClaims: finalAudit?.missingClaims || [],
    style,
    humanizer: {
      status: finalReady ? 'passed' : revision ? 'flagged' : 'pending',
      passed: finalReady,
      source: approvedPassed ? 'approved-revision' : 'humanizer-revision',
      errors: [
        ...(humanizedPassed ? [] : (humanization.errors || [])),
        ...style.errors,
      ],
    },
    approval: {
      status: approvalPassed ? 'approved' : 'pending',
      passed: approvalPassed,
      errors: approvedAudit && !approvedPassed ? (approvedAudit.errors || []) : [],
    },
  };
  return {
    artifactType,
    raw,
    humanized: humanized || (approvedText || null),
    approvedText: approvedText || null,
    revision,
    output,
    passed: finalReady,
    finalReady,
    approved: approvalPassed,
    status,
    humanization,
    style,
    approvedAudit,
    finalAudit,
    receipt,
  };
}

/**
 * Validate a receipt against the exact copy that will be shown or attached.
 * A missing receipt, changed input, changed output, or failed claim audit is
 * a hard failure. `requireApproval` is reserved for a caller that is also
 * enforcing a separate human approval boundary.
 *
 * @param {{ artifactType?: string, raw?: unknown, humanized?: unknown, output?: unknown, receipt?: Record<string, unknown> | null, requireApproval?: boolean }} input
 */
export function validateCandidateCopyReceipt(input = {}) {
  const artifactType = exactText(input.artifactType || 'candidate-copy');
  const raw = exactText(input.raw);
  const humanized = exactText(input.humanized);
  const output = exactText(input.output);
  const receipt = input.receipt && typeof input.receipt === 'object' ? input.receipt : null;
  const errors = [];
  if (!receipt) {
    errors.push('candidate-copy receipt is missing');
    return { ok: false, status: 'blocked', errors, receipt: null };
  }
  if (receipt.schema !== CANDIDATE_COPY_RECEIPT_SCHEMA) errors.push('candidate-copy receipt schema is invalid');
  if (receipt.version !== CANDIDATE_COPY_RECEIPT_VERSION) errors.push('candidate-copy receipt version is invalid');
  if (receipt.artifactType !== artifactType) errors.push('candidate-copy receipt artifact type does not match');
  if (receipt.status !== 'passed' || receipt.passed !== true || receipt.finalReady !== true) {
    errors.push('candidate-copy receipt does not show a passed Humanizer stage');
  }
  if (receipt.humanizer?.status !== 'passed' || receipt.humanizer?.passed !== true) {
    errors.push('candidate-copy receipt Humanizer status is not passed');
  }
  if (receipt.inputHash !== exactCopyHash(raw) || receipt.rawHash !== exactCopyHash(raw)) {
    errors.push('candidate-copy input text changed after Humanizer');
  }
  const revision = humanized || output;
  if (receipt.humanizedHash !== exactCopyHash(revision)) errors.push('candidate-copy humanized text changed after receipt creation');
  if (receipt.outputHash !== exactCopyHash(output)) errors.push('candidate-copy output changed after receipt creation');
  const audit = auditHumanizedText(raw, output || revision);
  if (!audit.passed) errors.push(...audit.errors);
  const style = auditCandidateCopyStyle(output || revision);
  if (receipt.style?.passed !== true) errors.push('candidate-copy receipt style audit is not passed');
  if (!style.passed) errors.push(...style.errors);
  if (JSON.stringify(receipt.protectedClaims || []) !== JSON.stringify(audit.protectedClaims || [])) {
    errors.push('candidate-copy protected-claim inventory changed');
  }
  if (input.requireApproval === true && receipt.approval?.passed !== true) {
    errors.push('candidate-copy human approval is missing');
  }
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'passed' : 'blocked',
    errors: [...new Set(errors)],
    receipt,
    audit,
    style,
  };
}
