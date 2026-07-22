#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

import {
  commonQuestions,
  answerFor,
  launchBrowser,
  loadProfile,
  settle,
  EEO_LABEL_RE,
  LEGAL_LABEL_RE,
  MARKETING_RE,
} from './lib/adapter-core.mjs';
import {
  DEFAULT_LEDGER_PATH,
  findReusableAnswer,
  isSensitiveQuestion,
  loadLedger,
  pendingQuestions,
  recordQuestionInLedger,
  saveLedger,
} from './question-ledger.mjs';
import { selectProjectAccomplishment } from '../project-accomplishment-ledger.mjs';
import { assessResumeReuse, generateApplicationArtifacts, jobHash } from './application-artifacts.mjs';
import { auditHumanizedText } from './application-humanizer.mjs';
import { inspectApplicationFlow, applicationAdapter, normalizeApplicationUrl } from './form-inspection.mjs';
import { readQueueState } from '../queue-lib.mjs';
import { postingFreshness } from '../queue-aging.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROFILE_PATH = path.join(ROOT, 'config', 'application-profile.json');
const DEFAULT_PACKET_ROOT = path.join(ROOT, 'output', 'application-packets');
const QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');

/** @param {string} value */
function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {string} value */
function slug(value) {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'application';
}

/** @param {string} value */
function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

/** @param {Record<string, unknown>} item @param {{ outputRoot?: string }} [options] */
export function packetPathsForItem(item, options = {}) {
  const target = `${item.company || 'company'} ${item.title || 'role'}`;
  const canonical = String(item.canonicalUrl || item.applyUrl || '').replace(/[?#].*$/, '');
  const identity = shortHash(canonical || `${item.company || ''}\n${item.title || ''}`);
  const directory = path.join(options.outputRoot || DEFAULT_PACKET_ROOT, `${slug(target)}-${identity}`);
  return {
    directory,
    json: path.join(directory, 'submission-packet.json'),
    markdown: path.join(directory, 'submission-packet.md'),
  };
}

/** @param {Record<string, unknown>} packet */
function canonicalAnswerShape(packet) {
  return (Array.isArray(packet.questions) ? packet.questions : []).map((question) => ({
    id: question.id || null,
    question: question.question || '',
    status: question.status || '',
    answerRef: question.answerRef || null,
  }));
}

/** @param {Record<string, unknown>} previous @param {Record<string, unknown>} current */
function packetChangeReasons(previous, current) {
  const reasons = [];
  if (previous.hashes?.jd !== current.hashes?.jd) reasons.push('job-description-changed');
  if (previous.hashes?.form !== current.hashes?.form) reasons.push('application-form-changed');
  if (previous.resumeDecision?.decision !== current.resumeDecision?.decision) reasons.push('resume-decision-changed');
  if (shortHash(JSON.stringify(canonicalAnswerShape(previous))) !== shortHash(JSON.stringify(canonicalAnswerShape(current)))) {
    reasons.push('canonical-answers-changed');
  }
  return reasons;
}

/** @param {ReturnType<typeof packetPathsForItem>} packetPaths @param {Record<string, unknown>} current */
function snapshotPreviousPacket(packetPaths, current) {
  if (!existsSync(packetPaths.json)) return { history: [] };
  try {
    const previous = JSON.parse(readFileSync(packetPaths.json, 'utf8'));
    const priorHistory = Array.isArray(previous.history) ? previous.history : [];
    const reasons = packetChangeReasons(previous, current);
    if (!reasons.length) return { history: priorHistory };
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${shortHash(JSON.stringify(previous.hashes || {}))}`;
    const directory = path.join(packetPaths.directory, 'history', snapshotId);
    mkdirSync(directory, { recursive: true });
    const json = path.join(directory, 'submission-packet.json');
    const markdown = path.join(directory, 'submission-packet.md');
    copyFileSync(packetPaths.json, json);
    if (existsSync(packetPaths.markdown)) copyFileSync(packetPaths.markdown, markdown);
    const snapshot = {
      createdAt: new Date().toISOString(),
      generatedAt: previous.generatedAt || null,
      reasonCodes: reasons,
      jsonPath: json,
      markdownPath: existsSync(markdown) ? markdown : null,
      hashes: previous.hashes || {},
    };
    return { history: [snapshot, ...priorHistory].slice(0, 20), snapshot };
  } catch {
    return { history: [], warning: 'previous packet could not be read for history comparison' };
  }
}

/** @param {Record<string, unknown>} profile @param {string} label */
function profileAnswer(profile, label) {
  const text = label.toLowerCase();
  const identity = profile.identity || {};
  const address = profile.address || {};
  const links = profile.links || {};
  const location = [address.city, address.state || address.country].filter(Boolean).join(', ');
  const values = [
    [/^first name\b/, identity.first_name, 'profile:identity.first_name'],
    [/^last name\b|surname/, identity.last_name, 'profile:identity.last_name'],
    [/full name|legal name|your name/, identity.full_name, 'profile:identity.full_name'],
    [/email/, identity.email, 'profile:identity.email'],
    [/phone|mobile/, identity.phone, 'profile:identity.phone'],
    [/linkedin/, links.linkedin, 'profile:links.linkedin'],
    [/github/, links.github, 'profile:links.github'],
    [/portfolio|personal site|website/, links.website, 'profile:links.website'],
    [/where.*work|work.*from|current location|location|city|based in/, location, 'profile:address'],
  ];
  for (const [pattern, value, source] of values) {
    if (pattern.test(text) && value) return { answer: String(value), source };
  }
  return null;
}

/** @param {Record<string, unknown>} profile @param {string} label */
function profileQuestionAnswer(profile, label) {
  const text = label.toLowerCase();
  const authorization = profile.work_authorization || {};
  if (/legally authorized|authorized to work|eligible to work|work authorization|right to work/.test(text)) {
    return { answer: authorization.authorized_us ? 'Yes' : 'No', source: 'profile:work_authorization.authorized_us', sensitive: true };
  }
  if (/sponsor|require .*(petition|immigration)|file a petition|immigration status|nonimmigrant|visa status/.test(text)) {
    return { answer: authorization.requires_sponsorship ? 'Yes' : 'No', source: 'profile:work_authorization.requires_sponsorship', sensitive: true };
  }
  return null;
}

/** @param {Record<string, unknown>} control */
function manualReason(control) {
  const label = String(control.label || '');
  if (EEO_LABEL_RE.test(label)) return 'voluntary self-identification — complete manually';
  if (LEGAL_LABEL_RE.test(label)) return 'legal or attestation field — review manually';
  if (MARKETING_RE.test(label)) return 'marketing consent — leave unchecked unless you choose otherwise';
  if (control.manualReason) return String(control.manualReason);
  return '';
}

/** @param {Record<string, unknown>} control */
function shouldRecord(control) {
  const label = String(control.label || '');
  return control.category === 'question' && !EEO_LABEL_RE.test(label) && !MARKETING_RE.test(label);
}

/** @param {Record<string, unknown>} control */
function isNarrativeControl(control) {
  if (!['text', 'textarea'].includes(String(control.kind || control.type || '').toLowerCase())) return false;
  const label = String(control.label || '');
  return control.category === 'question'
    && !/first name|last name|full name|legal name|email|phone|linkedin|github|portfolio|website|location|salary|compensation|authorization|sponsor|visa|consent|gender|race|veteran|disabilit|captcha|mfa|verification|attest|background|criminal|conviction/i.test(label);
}

/** @param {string} file */
function loadAnswerDrafts(file) {
  if (!file || !existsSync(file)) return { questions: [], coverLetter: null, sourcePath: file || '' };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      questions: Array.isArray(parsed?.questions) ? parsed.questions.filter((entry) => entry && typeof entry === 'object') : [],
      coverLetter: parsed?.coverLetter && typeof parsed.coverLetter === 'object' ? parsed.coverLetter : null,
      sourcePath: file,
    };
  } catch {
    return { questions: [], coverLetter: null, sourcePath: file, warning: `answer draft file could not be read: ${file}` };
  }
}

/** @param {Record<string, unknown>} control @param {{ questions: Array<Record<string, unknown>> }} drafts */
function draftForControl(control, drafts) {
  const label = String(control.label || '').toLowerCase();
  return drafts.questions.find((entry) => String(entry.questionId || '') === String(control.questionId || '')
    || String(entry.question || '').trim().toLowerCase() === label) || null;
}

/** @param {Record<string, unknown>} draft @param {string} [draftPath] */
function answerFromDraft(draft, draftPath = '') {
  const rawValue = draft?.draft || draft?.raw || draft?.rawAnswer;
  if (!rawValue) return null;
  const rawAnswer = String(rawValue);
  const humanized = draft.humanized || draft.humanizedAnswer ? String(draft.humanized || draft.humanizedAnswer) : '';
  const humanization = humanized ? auditHumanizedText(rawAnswer, humanized) : auditHumanizedText(rawAnswer, '');
  const proposedApproval = draft.approvedAnswer || (typeof draft.approved === 'string' ? draft.approved : '');
  const approvedAudit = proposedApproval ? auditHumanizedText(rawAnswer, String(proposedApproval)) : null;
  const approvedAnswer = approvedAudit?.passed
    ? String(proposedApproval)
    : draft.approved === true && humanization.passed ? humanized : null;
  const answer = approvedAnswer || (humanization.passed ? humanized : rawAnswer);
  return {
    answer,
    rawAnswer,
    humanizedAnswer: humanized || null,
    approvedAnswer,
    source: 'application-coaching-draft',
    kind: approvedAnswer ? 'approved' : humanization.passed ? 'humanized' : 'draft',
    evidenceRefs: Array.isArray(draft.evidenceRefs) ? draft.evidenceRefs.map(String) : [],
    humanization,
    draftPath: draftPath || null,
  };
}

/** @param {Record<string, unknown> | null} draft @param {string} [generatedPath] */
function coverLetterReview(draft, generatedPath = '') {
  let raw = draft?.draft || draft?.raw || draft?.rawAnswer || '';
  let source = draft ? 'application-coaching-draft' : 'generated-cover-letter';
  if (!raw && generatedPath && existsSync(generatedPath)) {
    try {
      raw = readFileSync(generatedPath, 'utf8');
    } catch {
      raw = '';
    }
  }
  if (!raw) return null;
  const rawAnswer = String(raw);
  const humanizedAnswer = draft?.humanized || draft?.humanizedAnswer ? String(draft.humanized || draft.humanizedAnswer) : '';
  const humanization = humanizedAnswer ? auditHumanizedText(rawAnswer, humanizedAnswer) : auditHumanizedText(rawAnswer, '');
  const proposedApproval = draft?.approvedAnswer || (typeof draft?.approved === 'string' ? draft.approved : '');
  const approvedAudit = proposedApproval ? auditHumanizedText(rawAnswer, String(proposedApproval)) : null;
  const approvedAnswer = approvedAudit?.passed
    ? String(proposedApproval)
    : draft?.approved === true && humanization.passed ? humanizedAnswer : null;
  const answer = approvedAnswer || (humanization.passed ? humanizedAnswer : rawAnswer);
  return {
    source,
    path: generatedPath || null,
    draftPath: draft ? (draft.draftPath || null) : null,
    rawAnswer,
    humanizedAnswer: humanizedAnswer || null,
    approvedAnswer,
    answer,
    status: approvedAnswer ? 'approved' : humanization.passed ? 'humanized' : 'draft',
    evidenceRefs: Array.isArray(draft?.evidenceRefs) ? draft.evidenceRefs.map(String) : [],
    humanization,
  };
}

/** @param {Record<string, unknown>} control @param {Record<string, unknown>} item @param {Record<string, unknown>} profile @param {{ entries: Array<Record<string, unknown>> }} ledger @param {{ drafts?: { questions: Array<Record<string, unknown>> }, draftsPath?: string }} [options] */
function answerForControl(control, item, profile, ledger, options = {}) {
  const label = String(control.label || '');
  const sensitivity = isSensitiveQuestion(label) ? 'high' : 'normal';
  const reusable = findReusableAnswer(label, ledger, {
    company: String(item.company || ''),
    role: String(item.title || ''),
    url: String(item.applyUrl || item.canonicalUrl || ''),
    fieldKind: String(control.kind || ''),
    options: Array.isArray(control.options) ? control.options : [],
    sensitivity,
  });
  if (reusable) {
    return {
      answer: reusable.answer,
      source: reusable.answerRef || `question-ledger:${reusable.entry.id}`,
      answerRef: reusable.answerRef || null,
      kind: 'confirmed',
      reuse: {
        matchType: reusable.matchType,
        confidence: reusable.confidence,
        matchedQuestion: reusable.entry.question,
      },
    };
  }

  const coachingDraft = options.drafts ? draftForControl(control, options.drafts) : null;
  if (coachingDraft && isNarrativeControl(control)) {
    const drafted = answerFromDraft(coachingDraft, options.draftsPath);
    if (drafted) return drafted;
  }

  const accomplishment = selectProjectAccomplishment({
    question: label,
    company: item.company,
    title: item.title,
    description: item.description,
    lane: item.lane,
  });
  if (accomplishment?.answer) {
    const answer = String(accomplishment.answer);
    const narrative = isNarrativeControl(control);
    return {
      answer,
      rawAnswer: narrative ? answer : null,
      humanizedAnswer: null,
      approvedAnswer: null,
      source: `project-accomplishment:${accomplishment.id}`,
      kind: narrative ? 'draft' : 'verified-evidence',
      evidenceRefs: [`project-accomplishment:${accomplishment.id}`],
      reuse: { matchType: 'job-aware-project-selection', confidence: Number(accomplishment.score || 0) },
      humanization: narrative ? auditHumanizedText(answer, '') : { status: 'not-applicable', passed: true, errors: [] },
    };
  }

  const profileValue = profileAnswer(profile, label) || profileQuestionAnswer(profile, label);
  if (profileValue) return { ...profileValue, kind: 'verified-profile' };

  const common = answerFor(label, [commonQuestions(profile)]);
  if (common !== null) return { answer: common, source: 'profile:common-question-rule', kind: 'verified-profile', sensitive: sensitivity === 'high' };
  return null;
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} control @param {Record<string, unknown>} metadata @param {{ entries: Array<Record<string, unknown>> }} ledger */
function recordFormQuestion(item, control, metadata, ledger) {
  if (!shouldRecord(control)) return null;
  return recordQuestionInLedger(ledger, String(control.label || ''), {
    company: item.company,
    role: item.title,
    url: item.applyUrl || item.canonicalUrl,
    queueId: item.id,
    jdHash: jobHash(item),
    source: 'application-packet:form-inspection',
    options: Array.isArray(control.options) ? control.options : [],
    fieldKind: control.kind,
    required: control.required === true,
    sensitivity: isSensitiveQuestion(String(control.label || '')) ? 'high' : 'normal',
    reason: metadata.reason || '',
  });
}

/** @param {Record<string, unknown>} inspection */
function inspectionControls(inspection) {
  const pages = Array.isArray(inspection.pages) && inspection.pages.length ? inspection.pages : [inspection];
  return pages.flatMap((page, pageIndex) => (page.controls || []).map((control) => ({
    ...control,
    pageIndex,
    pageUrl: page.url || inspection.url || '',
  })));
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} inspection */
function applicationEvidenceGate(item, inspection) {
  const pages = Array.isArray(inspection.pages) && inspection.pages.length ? inspection.pages : [inspection];
  const expectedTitle = normalize(String(item.title || ''));
  const titleVisible = pages.some((page) => page.titleVisible === true || (
    expectedTitle
      ? [page.heading, page.title].some((value) => normalize(String(value || '')).toLowerCase().includes(expectedTitle.toLowerCase()))
      : [page.heading, page.title].some((value) => normalize(String(value || '')))
  ));
  const formReady = pages.some((page) => page.formReady === true);
  const reasons = [];
  if (!expectedTitle || !titleVisible) reasons.push('the active posting title was not visible in the inspected application flow');
  if (normalize(String(item.description || '')).length < 120) reasons.push('the job description is missing or too short to verify this application safely');
  if (!formReady) reasons.push('no application form or application path was detected');
  return { ok: reasons.length === 0, reasons, titleVisible, formReady };
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} inspection @param {Record<string, unknown>} profile @param {string} ledgerPath @param {{ persistLedger?: boolean, drafts?: { questions: Array<Record<string, unknown>> }, draftsPath?: string }} [options] */
function buildQuestions(item, inspection, profile, ledgerPath, options = {}) {
  const ledger = loadLedger(ledgerPath);
  const recorded = [];
  const controls = inspectionControls(inspection);
  for (const control of controls) {
    const entry = recordFormQuestion(item, control, { reason: manualReason(control) }, ledger);
    if (entry) recorded.push({ control, entry });
  }
  const questions = [];
  const artifacts = [];
  const manual = [];
  for (const control of controls) {
    const label = String(control.label || 'Unlabeled field');
    if (control.category === 'artifact' || control.kind === 'file') {
      artifacts.push({
        label,
        required: control.required === true,
        kind: control.kind,
        path: /cover/i.test(label) ? '' : '',
        status: 'human-attach',
      });
      continue;
    }
    const entry = recorded.find((candidate) => candidate.control === control)?.entry || null;
    const manualFieldReason = manualReason(control);
    if (manualFieldReason) {
      manual.push({ label, required: control.required === true, reason: manualFieldReason, options: control.options || [] });
    }
    const resolved = manualFieldReason ? null : answerForControl(control, item, profile, ledger, options);
    const answer = resolved?.answer || null;
    const status = manualFieldReason ? 'manual'
      : resolved?.approvedAnswer ? 'approved'
        : resolved?.kind === 'humanized' ? 'humanized'
        : resolved?.kind === 'draft' ? 'draft'
          : answer !== null ? 'confirmed' : 'unanswered';
    questions.push({
      id: entry?.id || null,
      question: label,
      required: control.required === true,
      fieldKind: control.kind || control.type || 'text',
      options: Array.isArray(control.options) ? control.options : [],
      category: control.category || 'question',
      answer,
      rawAnswer: resolved?.rawAnswer || (resolved?.kind === 'draft' ? answer : null),
      humanizedAnswer: resolved?.humanizedAnswer || null,
      approvedAnswer: resolved?.approvedAnswer || null,
      status,
      source: resolved?.source || null,
      answerRef: resolved?.answerRef || null,
      provenance: {
        source: resolved?.source || null,
        evidenceRefs: resolved?.evidenceRefs || [],
        answerRef: resolved?.answerRef || null,
        draftPath: resolved?.draftPath || null,
      },
      humanization: resolved?.humanization || { status: 'not-applicable', passed: true, errors: [] },
      reuse: resolved?.reuse || null,
      sensitivity: isSensitiveQuestion(label) ? 'high' : 'normal',
      occurrence: {
        id: control.id || null,
        name: control.name || null,
        fieldPath: control.fieldPath || null,
        pageIndex: control.pageIndex,
        pageUrl: control.pageUrl || null,
      },
    });
  }
  if (options.persistLedger !== false) saveLedger(ledgerPath, ledger);
  return { questions, artifacts, manual, ledger };
}

/**
 * @param {Record<string, unknown>} item
 * @param {string} [now]
 * @returns {{ ok: boolean, freshness: ReturnType<typeof postingFreshness>, warning?: string, reason?: string }}
 */
export function packetFreshnessGate(item, now = new Date().toISOString()) {
  const freshness = postingFreshness(item, now);
  if (['stale', 'archivable', 'archived'].includes(freshness.state) || ['stale', 'archived'].includes(String(item.status || ''))) {
    return {
      ok: false,
      freshness,
      reason: 'posting freshness is stale; refresh and revalidate the role before preparing a submission packet',
    };
  }
  if (freshness.state === 'recheck_due') {
    return {
      ok: true,
      freshness,
      warning: `posting freshness recheck is due (${freshness.ageDays} days since the last observation or positive verification)`,
    };
  }
  return { ok: true, freshness };
}

/** @param {Record<string, unknown>} packet */
export function buildPacketMarkdown(packet) {
  const target = packet.target || {};
  const lines = [
    `# Application packet — ${target.company || 'Company'} · ${target.title || 'Role'}`,
    '',
    '> Human submission only. Review every answer and complete the final Submit/Apply action yourself.',
    '',
    `- Company: ${target.company || 'Not parsed'}`,
    `- Role: ${target.title || 'Not parsed'}`,
    `- Application: ${target.url || 'Not available'}`,
    `- Adapter: ${target.adapter || 'unknown'}`,
    `- Packet status: ${packet.status || 'needs-review'}`,
    `- Resume decision: ${packet.resumeDecision?.decision || packet.artifacts?.resumeDecision || 'not assessed'}`,
    '',
  ];
  const warnings = Array.isArray(packet.warnings) ? packet.warnings : [];
  if (warnings.length) lines.push('## Warnings', '', ...warnings.map((warning) => `- ${warning}`), '');
  const artifacts = packet.artifacts || {};
  lines.push('## Files to attach', '');
  for (const [label, value] of [['Résumé', artifacts.resumePdf], ['Cover letter', artifacts.coverLetterPdf || artifacts.coverLetterText]]) {
    if (value) lines.push(`- ${label}: \`${value}\``);
  }
  if (!artifacts.resumePdf && !artifacts.coverLetterPdf && !artifacts.coverLetterText) lines.push('- No generated artifacts are available; attach them manually.');
  const coverLetter = packet.coverLetter || null;
  if (coverLetter) {
    lines.push('', '## Cover letter text', '', `Status: ${coverLetter.status}`, `Source: ${coverLetter.source || 'generated artifact'}`);
    if (coverLetter.path) lines.push(`Artifact: \`${coverLetter.path}\``);
    if (coverLetter.rawAnswer) lines.push('', 'Evidence-bound draft:', '', coverLetter.rawAnswer);
    if (coverLetter.humanizedAnswer) lines.push('', 'Humanized revision:', '', coverLetter.humanizedAnswer);
    if (coverLetter.approvedAnswer) lines.push('', 'Approved copy:', '', coverLetter.approvedAnswer);
    lines.push('');
  }
  lines.push('', '## Copy/paste answers', '');
  const questions = Array.isArray(packet.questions) ? packet.questions : [];
  for (const question of questions.filter((entry) => ['known', 'confirmed', 'approved', 'humanized', 'draft'].includes(entry.status) && entry.answer !== null)) {
    lines.push(`### ${question.question}`, '', `Answer: ${question.answer}`, `Status: ${question.status}`, `Source: ${question.source || 'verified ledger'}`);
    if (question.answerRef) lines.push(`Answer reference: ${question.answerRef}`);
    if (question.rawAnswer && question.humanizedAnswer) lines.push(`Raw draft: ${question.rawAnswer}`, `Humanized: ${question.humanizedAnswer}`);
    if (question.status === 'draft') lines.push('Copy only after the humanizer review and approval step.');
    lines.push('');
  }
  const unresolved = Array.isArray(packet.unresolved) ? packet.unresolved : [];
  lines.push('## Questions waiting for you', '');
  if (!unresolved.length) lines.push('- None recorded.');
  for (const question of unresolved) {
    lines.push(`### ${question.question}`, '', `Required: ${question.required ? 'yes' : 'no'}`, `Answer: [your answer]`);
    if (question.options?.length) lines.push(`Options: ${question.options.join(' | ')}`);
    if (question.id) lines.push(`Question id: ${question.id}`);
    if (question.answerRef) lines.push(`Canonical answer reference: ${question.answerRef}`);
    lines.push('');
  }
  const reviewItems = Array.isArray(packet.reviewItems) ? packet.reviewItems : [];
  if (reviewItems.length) {
    lines.push('## Drafts needing human review', '');
    for (const item of reviewItems) lines.push(`- ${item.question}: ${item.reason || 'review before copying'}`);
    lines.push('');
  }
  const research = Array.isArray(packet.research?.references) ? packet.research.references : [];
  if (research.length) lines.push('## Research references', '', ...research.map((reference) => `- ${reference}`), '');
  const manual = Array.isArray(packet.manualItems) ? packet.manualItems : [];
  lines.push('## Human-only checks', '');
  if (!manual.length) lines.push('- Review the form and final submission control.');
  for (const item of manual) lines.push(`- ${item.label}: ${item.reason}`);
  lines.push('- Review all personal, eligibility, legal, consent, and voluntary demographic fields.', '- Click Submit/Apply only after your review.', '');
  return `${lines.join('\n').trim()}\n`;
}

/** @param {Record<string, unknown>} item @param {{ browser?: string, headed?: boolean, cdpEndpoint?: string, ledgerPath?: string, profilePath?: string, outputRoot?: string, generateArtifacts?: boolean, generateCoverLetter?: boolean, dryRun?: boolean, inspection?: Record<string, unknown>, maxPages?: number, answersPath?: string, drafts?: { questions: Array<Record<string, unknown>>, coverLetter?: Record<string, unknown>, sourcePath?: string }, researchReferences?: string[], jackCoaching?: Record<string, unknown> }} [options] */
export async function buildApplicationPacket(item, options = {}) {
  const freshnessGate = packetFreshnessGate(item);
  if (!freshnessGate.ok) return { ok: false, status: 'stale', reason: freshnessGate.reason };
  const effectiveItem = {
    ...item,
    applyUrl: normalizeApplicationUrl(String(item.applyUrl || item.canonicalUrl || '')),
  };
  if (!effectiveItem.applyUrl) return { ok: false, reason: 'application URL is missing' };
  const profile = await loadProfile(options.profilePath || DEFAULT_PROFILE_PATH);
  const drafts = options.drafts || loadAnswerDrafts(options.answersPath || '');
  let inspection = options.inspection || null;
  if (!inspection) {
    let browser;
    try {
      browser = await launchBrowser(chromium, {
        headless: options.headed !== true,
        channel: options.browser || process.env.CAREER_OPS_BROWSER_CHANNEL || 'chrome-beta',
        cdpEndpoint: options.cdpEndpoint,
      });
      const page = await browser.newPage();
      await page.goto(effectiveItem.applyUrl, { waitUntil: 'domcontentloaded' });
      await settle(page);
      inspection = await inspectApplicationFlow(page, { maxPages: options.maxPages, expectedTitle: effectiveItem.title });
    } catch (error) {
      return {
        ok: false,
        status: 'blocked',
        reason: `browser bridge or application form inspection is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        target: { ...effectiveItem, url: effectiveItem.applyUrl },
      };
    } finally {
      if (browser) await browser.close();
    }
  }

  const safeInspection = /** @type {Record<string, unknown>} */ (inspection || {});
  const pages = Array.isArray(safeInspection.pages) && safeInspection.pages.length ? safeInspection.pages : [safeInspection];
  if (!normalize(String(effectiveItem.title || ''))) {
    const observedTitle = normalize(String(safeInspection.heading || safeInspection.title || ''));
    if (observedTitle) effectiveItem.title = observedTitle;
  }
  const evidenceGate = applicationEvidenceGate(effectiveItem, safeInspection);
  const allControls = inspectionControls(safeInspection);
  const allButtons = pages.flatMap((page) => Array.isArray(page.buttons) ? page.buttons : []);
  const allManualSignals = [...new Set(pages.flatMap((page) => Array.isArray(page.manualSignals) ? page.manualSignals : []))];
  const coverRequired = options.generateCoverLetter === true
    || allControls.some((control) => control.category === 'artifact' && /cover/i.test(String(control.label || '')) && control.required === true);
  const { questions, artifacts, manual, ledger } = buildQuestions(effectiveItem, safeInspection, profile, options.ledgerPath || DEFAULT_LEDGER_PATH, {
    persistLedger: options.dryRun !== true,
    drafts,
    draftsPath: options.answersPath || drafts.sourcePath || '',
  });

  let resumeDecision = options.generateArtifacts === false
    ? { decision: 'not-generated', reasonCodes: ['artifact-generation-disabled'], reasons: ['artifact generation was disabled for this run'] }
    : assessResumeReuse(effectiveItem, { outputRoot: options.outputRoot, description: String(effectiveItem.description || '') });
  let artifactsResult = null;
  let artifactWarning = '';
  const reusedManifest = resumeDecision.manifest || null;
  const reusedArtifacts = resumeDecision.decision === 'reuse' ? {
    manifestPath: resumeDecision.manifestPath || '',
    resumePdf: resumeDecision.artifactPath || reusedManifest?.resume?.pdfPath || reusedManifest?.artifact?.path || '',
    coverLetterPdf: reusedManifest?.coverLetter?.pdfPath || '',
    coverLetterText: reusedManifest?.coverLetter?.textPath || '',
    descriptionSource: reusedManifest?.job?.descriptionSource || null,
  } : null;
  const coverAvailable = Boolean(reusedArtifacts?.coverLetterPdf || reusedArtifacts?.coverLetterText);
  if (options.generateArtifacts !== false && !options.dryRun && (resumeDecision.decision !== 'reuse' || (coverRequired && !coverAvailable))) {
    try {
      artifactsResult = await generateApplicationArtifacts(effectiveItem, {
        includeCoverLetter: coverRequired,
        fetchJobDescription: false,
        outputRoot: options.outputRoot,
        reuseResume: resumeDecision.decision === 'reuse' ? resumeDecision : undefined,
      });
      if (!artifactsResult.ok) artifactWarning = String(artifactsResult.reason || 'artifact generation failed');
      if (artifactsResult.jobDescription && String(artifactsResult.jobDescription).length > String(effectiveItem.description || '').length) effectiveItem.description = artifactsResult.jobDescription;
    } catch (error) {
      artifactWarning = error instanceof Error ? error.message : String(error);
    }
  } else if (options.dryRun && options.generateArtifacts !== false) {
    artifactWarning = 'dry-run: artifact generation was skipped';
  } else if (resumeDecision.decision === 'reuse' && coverRequired && !coverAvailable) {
    artifactWarning = 'existing resume is reusable; a new cover letter is required and remains to be generated';
  }

  const generatedArtifacts = artifactsResult?.ok ? {
    manifestPath: artifactsResult.manifestPath,
    resumePdf: artifactsResult.resumePdf,
    coverLetterPdf: artifactsResult.coverLetterPdf,
    coverLetterText: artifactsResult.coverLetterText,
    descriptionSource: artifactsResult.job?.descriptionSource || null,
    resumeDecision: artifactsResult.resumeDecision || resumeDecision.decision,
  } : reusedArtifacts || {
    manifestPath: resumeDecision.manifestPath || '',
    resumePdf: '',
    coverLetterPdf: '',
    coverLetterText: '',
    descriptionSource: null,
    resumeDecision: resumeDecision.decision,
  };
  const packetPaths = packetPathsForItem(effectiveItem, { outputRoot: options.outputRoot });
  const unresolved = questions.filter((question) => question.status === 'unanswered');
  const requiredUnresolved = unresolved.filter((question) => question.required);
  const packetResumeDecision = { ...resumeDecision };
  delete packetResumeDecision.manifest;
  const coverLetter = coverLetterReview(drafts.coverLetter, generatedArtifacts.coverLetterText || '');
  const reviewItems = questions
    .filter((question) => ['draft', 'humanized'].includes(question.status) && question.approvedAnswer === null)
    .map((question) => ({ question: question.question, reason: question.status === 'draft' ? 'evidence-bound draft needs humanizer review' : 'humanized response needs final human approval' }));
  if (coverLetter && ['draft', 'humanized'].includes(coverLetter.status) && coverLetter.approvedAnswer === null) {
    reviewItems.push({
      question: 'Cover letter',
      reason: coverLetter.status === 'draft' ? 'cover-letter text needs humanizer review' : 'humanized cover letter needs final human approval',
    });
  }
  const flowBlocked = Boolean(safeInspection.blocked || safeInspection.blockedReason || safeInspection.authRequired || safeInspection.challengeDetected || !evidenceGate.ok);
  const status = flowBlocked ? 'blocked' : requiredUnresolved.length ? 'needs-user-input' : 'ready-for-human-review';
  const researchReferences = [...new Set([
    effectiveItem.canonicalUrl || '',
    effectiveItem.applyUrl || '',
    effectiveItem.sourceUrl || '',
    effectiveItem.reportPath || '',
    ...(Array.isArray(options.researchReferences) ? options.researchReferences : []),
  ].filter(Boolean).map(String))];
  const formHash = shortHash(JSON.stringify({ pages, controls: allControls, buttons: allButtons }));
  const humanizationWarnings = questions.flatMap((question) => question.humanization?.errors || []);
  const packet = {
    schemaVersion: 2,
    type: 'application-submission-packet',
    generatedAt: new Date().toISOString(),
    status,
    submissionBoundary: 'human-only',
    target: {
      id: effectiveItem.id || null,
      company: effectiveItem.company || '',
      title: effectiveItem.title || '',
      location: effectiveItem.location || '',
      url: effectiveItem.applyUrl,
      adapter: applicationAdapter(effectiveItem.applyUrl),
      jdHash: jobHash(effectiveItem),
      canonicalUrl: effectiveItem.canonicalUrl || effectiveItem.applyUrl,
    },
    form: {
      title: safeInspection.title || '',
      heading: safeInspection.heading || '',
      url: safeInspection.url || effectiveItem.applyUrl,
      formCount: pages.reduce((count, page) => count + Number(page.formCount || 0), 0),
      formReady: pages.some((page) => page.formReady === true),
      pageCount: pages.length,
      pages,
      submitControls: allButtons.filter((button) => button.submitLike),
      manualSignals: allManualSignals,
    },
    artifacts: generatedArtifacts,
    resumeDecision: packetResumeDecision,
    coverLetter,
    questions,
    unresolved,
    reviewItems,
    manualItems: manual,
    artifactFields: artifacts,
    research: {
      references: researchReferences,
      coaching: options.jackCoaching || { primary: 'career-ops-local-coaching', fallback: 'jackandjill-on-demand' },
      answerDraftsPath: options.answersPath || drafts.sourcePath || null,
    },
    hashes: {
      jd: jobHash(effectiveItem),
      form: formHash,
    },
    warnings: [
      freshnessGate.warning || '',
      artifactWarning,
      safeInspection.formReady ? '' : 'no rendered application form was detected',
      ...evidenceGate.reasons,
      safeInspection.blockedReason || '',
      drafts.warning || '',
      ...humanizationWarnings,
      ...(coverLetter?.humanization?.errors || []),
      ...((Array.isArray(safeInspection.warnings) ? safeInspection.warnings : []).map(String)),
    ].filter(Boolean),
    ledger: {
      path: options.ledgerPath || DEFAULT_LEDGER_PATH,
      canonicalQuestionCount: ledger.entries.length,
      unresolvedCount: unresolved.length,
      pendingGroups: pendingQuestions(ledger, {
        company: String(effectiveItem.company || ''),
        role: String(effectiveItem.title || ''),
        url: String(effectiveItem.applyUrl || ''),
      }).length,
    },
    checklist: [
      'Open the canonical application URL and confirm the posting is still active.',
      'Attach the selected resume and cover letter files when required.',
      'Review every answer, including draft/humanized narrative text and human-only fields.',
      'Complete EEO, consent, legal, CAPTCHA, MFA, and identity fields manually.',
      'Perform the final Submit/Apply action yourself after review.',
    ],
  };
  const historyState = snapshotPreviousPacket(packetPaths, packet);
  packet.history = historyState.history;
  if (historyState.warning) packet.warnings.push(historyState.warning);
  const markdown = buildPacketMarkdown(packet);
  if (!options.dryRun) {
    mkdirSync(packetPaths.directory, { recursive: true });
    writeFileSync(packetPaths.json, `${JSON.stringify({ ...packet, paths: packetPaths }, null, 2)}\n`, 'utf8');
    writeFileSync(packetPaths.markdown, markdown, 'utf8');
  }
  return {
    ok: true,
    ...packet,
    paths: packetPaths,
    markdown,
  };
}

/** @param {string} queueId */
function queueItem(queueId) {
  const state = readQueueState(QUEUE_PATH);
  return (state.items || []).find((item) => String(item.id || '') === queueId) || null;
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'queue-id': { type: 'string' },
      company: { type: 'string' },
      title: { type: 'string' },
      location: { type: 'string' },
      'job-description': { type: 'string' },
      browser: { type: 'string' },
      headed: { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      answers: { type: 'string' },
      'max-pages': { type: 'string' },
      cover: { type: 'boolean', default: false },
      'no-artifacts': { type: 'boolean', default: false },
      'output-root': { type: 'string' },
      profile: { type: 'string' },
      ledger: { type: 'string' },
    },
  });
  const item = values['queue-id']
    ? queueItem(values['queue-id'])
    : positionals[0]
      ? {
        applyUrl: positionals[0],
        company: values.company || '',
        title: values.title || '',
        location: values.location || '',
        description: values['job-description'] || '',
      }
      : null;
  if (!item) throw new Error('Usage: node apply/application-packets.mjs [application-url] [--queue-id <id>] [--company <name>] [--title <role>]');
  const result = await buildApplicationPacket(item, {
    browser: values.browser,
    headed: values.headed === true && values.headless !== true,
    generateArtifacts: values['no-artifacts'] !== true,
    generateCoverLetter: values.cover === true,
    dryRun: values['dry-run'] === true,
    answersPath: values.answers,
    maxPages: values['max-pages'] ? Number(values['max-pages']) : undefined,
    outputRoot: values['output-root'],
    profilePath: values.profile,
    ledgerPath: values.ledger,
  });
  if (!result.ok) throw new Error(result.reason);
  console.log(`CAREER_OPS_APPLICATION_PACKET ${JSON.stringify({
    ok: true,
    status: result.status,
    queueId: result.target.id,
    company: result.target.company,
    title: result.target.title,
    questionCount: result.questions.length,
    unresolvedCount: result.unresolved.length,
    markdownPath: result.paths.markdown,
    jsonPath: result.paths.json,
  })}`);
}
