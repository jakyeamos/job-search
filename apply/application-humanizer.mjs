#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';

/** @param {string} value */
function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
/** @param {string} value */
function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
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
