import { isNonQuestionPrompt, normalizeQuestion } from './question-ledger.mjs';

export const LEGAL_LABEL_RE = /attest|certif|background|criminal|conviction|terms (?:and|of)|agree.*(?:accurate|truth|conditions|terms)|privacy\s+(?:notice|policy)|ai\s+policy|double[- ]check|accuracy is crucial|information provided above|full[- ]time\s+(?:on[- ]?site|in[- ]person)[\s\S]*\b(?:london|germany|france|spain|netherlands|belgium|italy)\b/i;
export const SMS_CONSENT_RE = /\b(?:text message|sms)\s+consent\b/i;
export const EEO_LABEL_RE = /^EEO\s*:/i;

/**
 * Keep the queue UI and diagnostics on one definition of what can be answered
 * in the question panel. Legal attestations, demographic fields, and
 * communication consent remain human-only; notices are informational rather
 * than questions.
 *
 * @param {string} value
 */
export function classifyQuestionVisibility(value) {
  const raw = String(value || '').trim();
  if (EEO_LABEL_RE.test(raw)) {
    return { category: 'human-only', answerable: false, humanOnly: true, reason: 'eeo-demographic' };
  }
  const question = normalizeQuestion(value);
  if (!question) return { category: 'empty', answerable: false, humanOnly: false, reason: 'empty-label' };
  if (isNonQuestionPrompt(question)) {
    return { category: 'informational', answerable: false, humanOnly: false, reason: 'informational-notice' };
  }
  if (LEGAL_LABEL_RE.test(question)) {
    return { category: 'human-only', answerable: false, humanOnly: true, reason: 'legal-attestation' };
  }
  if (SMS_CONSENT_RE.test(question)) {
    return { category: 'human-only', answerable: false, humanOnly: true, reason: 'communication-consent' };
  }
  return { category: 'answerable', answerable: true, humanOnly: false, reason: null };
}

/** @param {Record<string, unknown>} item */
export function hasVisibleQuestionReviews(item) {
  return ['ready', 'in_review'].includes(String(item.status || ''))
    && String(item.applicationState || '') !== 'submitted'
    && Array.isArray(item.applicationResult?.needsReview)
    && item.applicationResult.needsReview.length > 0;
}
