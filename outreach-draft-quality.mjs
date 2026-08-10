// @ts-check

import { createHash } from 'node:crypto';

import { auditHumanizedText } from './apply/application-humanizer.mjs';
import { humanizeText } from './social-writing.mjs';

export const OUTREACH_DRAFT_QUALITY_SCHEMA = 'outreach-draft-quality-receipt/v1';
export const OUTREACH_DRAFT_QUALITY_VERSION = 1;

const CHANNEL_LIMITS = Object.freeze({ email: 1800, linkedin: 300, x: 1000 });
const GENERIC_AI_LANGUAGE_RE = /\b(?:delve|tapestry|landscape|pivotal|showcase|underscores?|robust|seamless|game-changing|unlock|leverage)\b/i;
const PROOF_FRAGMENT_START_RE = /^(?:three|two|four|five|six|seven|eight|nine|ten|\d+)\s+[A-Z][^.!?]{0,180}[.!?]?$/;
const FINITE_VERB_RE = /\b(?:am|is|are|was|were|have|has|had|built|build|led|lead|worked|work|developed|develop|delivered|deliver|created|create|completed|complete|include|includes|included|span|spans|spanned)\b/i;

/** @param {unknown} value */
function text(value) {
  return String(value || '').trim();
}

/** @param {string} value */
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} subject @param {string} body */
function boundText(subject, body) {
  return `${subject}\n${body}`;
}

/**
 * Apply the deterministic outreach Humanizer. This stage only changes style;
 * the subsequent claim audit prevents it from changing URLs or numeric claims.
 * @param {string} value
 */
export function humanizeOutreachText(value) {
  const salutationFixed = String(value || '').replace(/^(Hi\s+\S+)\s*[—–-]\s*/i, '$1, ');
  const general = humanizeText(salutationFixed);
  let output = general.text;
  const findings = [...general.findings];
  const replacements = [
    [/\bI would be glad to share more context if useful\./gi, 'Happy to share more context if that would help.'],
    [/\bI would value\b/g, "I'd value"],
    [/\bI would appreciate\b/g, "I'd appreciate"],
    [/\bI would enjoy hearing\b/g, "I'd be interested to hear"],
    [/\bI wanted to contact you specifically\./gi, 'I thought you might be a good person to ask.'],
    [/\bparticularly useful as I learn how this work fits into the broader team\./gi, 'helpful as I learn more about the team.'],
    [/\bcase western reserve university\b/g, 'Case Western Reserve University'],
    [/\bexisting existing\b/gi, 'existing'],
  ];
  for (const [pattern, replacement] of replacements) {
    const next = output.replace(pattern, replacement);
    if (next !== output) findings.push('rephrased mechanical outreach language');
    output = next;
  }
  output = output
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: output, findings: [...new Set(findings)] };
}

/**
 * Check the exact post-Humanizer copy for structural and prose defects.
 * @param {{ channel: 'email'|'linkedin'|'x', subject?: string, body: string, contactName?: string, company?: string }} draft
 */
export function assessOutreachDraftQuality(draft) {
  const channel = draft.channel;
  const subject = text(draft.subject);
  const body = text(draft.body);
  const errors = [];
  const warnings = [];
  if (!Object.hasOwn(CHANNEL_LIMITS, channel)) errors.push(`unsupported outreach channel: ${channel}`);
  if (!body) errors.push('message body is empty');
  if (channel === 'email' && !subject) errors.push('email subject is empty');
  if (channel === 'email' && subject.length > 160) errors.push('email subject exceeds 160 characters');
  if (body.length > (CHANNEL_LIMITS[channel] || 0)) errors.push(`${channel} message exceeds ${CHANNEL_LIMITS[channel]} characters`);
  if (channel === 'email' && !/https:\/\//i.test(body)) errors.push('email is missing an approved proof link');
  if (/[—–]/.test(`${subject}\n${body}`)) errors.push('draft still contains dash punctuation targeted by the Humanizer');
  if (GENERIC_AI_LANGUAGE_RE.test(`${subject}\n${body}`)) errors.push('draft contains generic AI or promotional language');
  if (/\bexisting existing\b/i.test(body)) errors.push('draft repeats the word "existing"');
  if (/\bcase western reserve university\b/.test(body)) errors.push('university name is not capitalized');
  if (/\breach out directly\.\s+(?:Three|Two|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\b/.test(body)) {
    errors.push('proof point follows the introduction as a sentence fragment');
  }
  const firstName = text(draft.contactName).split(/\s+/)[0];
  if (firstName && !new RegExp(`^Hi\\s+${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,!]`, 'i').test(body)) {
    errors.push('message does not open with the recipient name');
  }
  const company = text(draft.company).replace(/[.]+$/, '');
  if (company && !body.toLowerCase().includes(company.toLowerCase())) errors.push('message does not name the company');

  const proseSegments = body
    .replace(/https?:\/\/\S+/g, '')
    .split(/(?:\n+|(?<=[.!?])\s+)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of proseSegments) {
    if (PROOF_FRAGMENT_START_RE.test(segment) && !FINITE_VERB_RE.test(segment)) {
      errors.push('message contains a standalone proof-point fragment');
      break;
    }
  }
  if (/\b(?:I wanted to|I would|very|particularly)\b/i.test(body)) {
    warnings.push('draft retains formal phrasing worth a final human glance');
  }
  return { passed: errors.length === 0, errors, warnings };
}

/**
 * Run Humanizer, claim preservation, and channel QA before persistence.
 * @param {{ channel: 'email'|'linkedin'|'x', subject?: string, body: string, contactName?: string, company?: string }} draft
 */
export function prepareOutreachDraft(draft) {
  const rawSubject = text(draft.subject);
  const rawBody = text(draft.body);
  const humanizedSubject = humanizeOutreachText(rawSubject);
  const humanizedBody = humanizeOutreachText(rawBody);
  const subject = humanizedSubject.text;
  const body = humanizedBody.text;
  const claimAudit = auditHumanizedText(boundText(rawSubject, rawBody), boundText(subject, body));
  const quality = assessOutreachDraftQuality({ ...draft, subject, body });
  const passed = claimAudit.passed && quality.passed;
  const receipt = {
    schemaVersion: OUTREACH_DRAFT_QUALITY_SCHEMA,
    version: OUTREACH_DRAFT_QUALITY_VERSION,
    channel: draft.channel,
    status: passed ? 'passed' : 'blocked',
    passed,
    inputHash: hash(boundText(rawSubject, rawBody)),
    subjectHash: hash(subject),
    bodyHash: hash(body),
    outputHash: hash(boundText(subject, body)),
    humanizer: {
      status: claimAudit.status,
      passed: claimAudit.passed,
      findings: [...new Set([...humanizedSubject.findings, ...humanizedBody.findings])],
      errors: claimAudit.errors,
    },
    quality: {
      status: quality.passed ? 'passed' : 'blocked',
      passed: quality.passed,
      errors: quality.errors,
      warnings: quality.warnings,
    },
  };
  return { subject, body, receipt };
}

/**
 * Validate that the receipt belongs to the exact copy about to be persisted.
 * @param {{ channel: 'email'|'linkedin'|'x', subject?: string, body: string, receipt: unknown }} draft
 */
export function validateOutreachDraftReceipt(draft) {
  const receipt = draft.receipt && typeof draft.receipt === 'object' && !Array.isArray(draft.receipt)
    ? /** @type {Record<string, any>} */ (draft.receipt)
    : null;
  const reasons = [];
  const subject = text(draft.subject);
  const body = text(draft.body);
  if (!receipt) return { ok: false, reasons: ['quality receipt is missing'] };
  if (receipt.schemaVersion !== OUTREACH_DRAFT_QUALITY_SCHEMA) reasons.push('quality receipt schema is invalid');
  if (receipt.version !== OUTREACH_DRAFT_QUALITY_VERSION) reasons.push('quality receipt version is invalid');
  if (receipt.channel !== draft.channel) reasons.push('quality receipt channel does not match');
  if (receipt.status !== 'passed' || receipt.passed !== true) reasons.push('quality receipt did not pass');
  if (receipt.humanizer?.status !== 'passed' || receipt.humanizer?.passed !== true) reasons.push('Humanizer stage did not pass');
  if (receipt.quality?.status !== 'passed' || receipt.quality?.passed !== true) reasons.push('quality stage did not pass');
  if (receipt.subjectHash !== hash(subject)) reasons.push('quality receipt subject hash does not match');
  if (receipt.bodyHash !== hash(body)) reasons.push('quality receipt body hash does not match');
  if (receipt.outputHash !== hash(boundText(subject, body))) reasons.push('quality receipt output hash does not match');
  return { ok: reasons.length === 0, reasons };
}
