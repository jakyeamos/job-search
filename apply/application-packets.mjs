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
  createBrowserPage,
  launchBrowser,
  loadProfile,
  matchAnswerToOptions,
  sponsorshipRequirement,
  settle,
  EEO_LABEL_RE,
  LEGAL_LABEL_RE,
  MARKETING_RE,
} from './lib/adapter-core.mjs';
import {
  DEFAULT_LEDGER_PATH,
  findReusableAnswer,
  isAISafetyQuestion,
  isCloudInfrastructureQuestion,
  isCustomerDeliveryQuestion,
  isAgenticSystemsQuestion,
  isAiUsageQuestion,
  isProductionSystemQuestion,
  isPythonProductionQuestion,
  isTechnicalFoundationsQuestion,
  isSensitiveQuestion,
  loadLedger,
  pendingQuestions,
  recordEvidenceBackedAnswerInLedger,
  recordQuestionInLedger,
  saveLedger,
} from './question-ledger.mjs';
import { selectProjectAccomplishment } from '../project-accomplishment-ledger.mjs';
import { motivationAnswerForItem } from './motivation-answer.mjs';
import { assessResumeReuse, generateApplicationArtifacts, jobHash } from './application-artifacts.mjs';
import { auditHumanizedText } from './application-humanizer.mjs';
import {
  applicationAdapter,
  inspectApplicationFlow,
  jobDescriptionFromInspection,
  normalizeApplicationUrl,
  normalizeJobTitle,
} from './form-inspection.mjs';
import { readQueueState } from '../queue-lib.mjs';
import { postingFreshness } from '../queue-aging.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROFILE_PATH = path.join(ROOT, 'config', 'application-profile.json');
const DEFAULT_PACKET_ROOT = path.join(ROOT, 'output', 'application-packets');
const QUEUE_PATH = path.join(ROOT, 'data', 'job-queue.json');
export const PACKET_CONTACT_DISCOVERY_MIN_FIT_SCORE = 4.3;

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
  const fields = [
    ...(Array.isArray(packet.questions) ? packet.questions : []),
    ...(Array.isArray(packet.simpleFields) ? packet.simpleFields : []),
  ];
  return fields.map((question) => ({
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

/** @param {string} label */
function isCurrentLocationPrompt(label) {
  const text = String(label || '').toLowerCase();
  if (isSensitiveQuestion(text)) return false;
  return /^(?:location|current location|current city|current state|current country|location\s*\(city\))$/i.test(text)
    || /\bcurrent(?:ly)?\s+(?:based|located|living|working)\b/i.test(text)
    || /\bwhich country are you working from\b/i.test(text)
    || /\bwhere\s+are\s+you\s+(?:currently\s+)?(?:located|based|living)\b/i.test(text)
    || /\b(?:where|what)\s+is\s+your\s+specific\s+working\s+location\b/i.test(text);
}

/** @param {string} label */
function isRecentEmployerPrompt(label) {
  return /\b(?:most recent employer|current employer|current(?: or most recent)? company|most recent company)\b/i.test(label);
}

/** @param {string} label */
function isRecentTitlePrompt(label) {
  return /\b(?:most recent job title|current job title|most recent title|current title)\b/i.test(label);
}

/** @param {string} label */
function isStartDatePrompt(label) {
  return /\b(?:earliest.*(?:join|start)|(?:date|when).*join|start date|notice period|available to (?:start|join)|when.*(?:start|join))\b/i.test(label);
}

/** @param {string} label */
function configuredApplicationAnswerKey(label) {
  const text = String(label || '');
  if (/have you ever interviewed at anthropic before/i.test(text)) return 'anthropic_interview';
  if (/do you know anyone currently at glean/i.test(text)) return 'glean_relationship';
  if (/\bdutch\b[\s\S]{0,100}\bc1\s*\/\s*c2\b|\bc1\s*\/\s*c2\b[\s\S]{0,100}\bdutch\b/i.test(text)) return 'dutch_proficiency';
  if (/\bat least\s+3\s+years\b[\s\S]{0,120}\bprofessional experience\b[\s\S]{0,80}\bsoftware engineering\b/i.test(text)) return 'professional_software_engineering_3_years';
  if (/\btravel\b[\s\S]{0,120}\b(?:customers?|partners?)\b[\s\S]{0,80}\b(?:less than|under|up to)?\s*20\s*%/i.test(text)) return 'travel_up_to_20_percent';
  if (/\bhave you contributed to open[- ]source projects before\b/i.test(text)) return 'open_source_contribution';
  if (/\bshare an example\b[\s\S]{0,180}\bopen[- ]source contribution\b/i.test(text)) return 'open_source_contribution_example';
  const questionCue = /\b(?:are|would|will|can|do)\s+you\b/i.test(text);
  const workMode = /\b(?:hybrid|in[- ]?person|on[- ]?site|onsite|office)\b/i.test(text);
  const citySchedule = /\b(?:nyc|new york|san francisco|sf)\b[\s\S]{0,100}(?:\bdays?\s+(?:per|a)\s+week\b|\b\d+\s*%\b)/i.test(text);
  const cityRelocation = /\b(?:nyc|new york|san francisco|sf|bay area)\b/i.test(text)
    && /\b(?:relocat|move)\w*\b/i.test(text);
  if (questionCue && (workMode || citySchedule || cityRelocation)) return 'hybrid_work';
  if (/\b(?:located|live|based|reside)\b[\s\S]{0,60}\b(?:united states|u\.s\.?|us)\b/i.test(text)) return 'located_in_us';
  if (/\b(?:located|live|based|reside)\b[\s\S]{0,60}\bnorth america\b/i.test(text)) return 'located_in_north_america';
  if (/\b(?:located|live|based|reside)\b[\s\S]{0,60}\bsan francisco bay area\b/i.test(text)) return 'located_in_bay_area';
  if (/\blive in one of the following states\b/i.test(text)) return 'restricted_state_residence';
  if (/\b(?:used|worked with|experience with)\s+sentry\b|sentry experience/i.test(text)) return 'sentry_experience';
  if (isAISafetyQuestion(text)) return 'llm_evaluation';
  if (/(?:\bllm\b[\s\S]{0,100}\b(?:evaluation|observability|guardrails?)\b|\b(?:evaluation|observability|guardrails?)\b[\s\S]{0,100}\bllm\b)/i.test(text)) return 'llm_evaluation';
  if (/\bhow\s+long\b[\s\S]{0,220}\bcommit(?:ted|ting)?\b[\s\S]{0,120}\b(?:repository|repo)\b/i.test(text)) return 'recent_code_commit';
  if (/\bwhich programming languages\b|\bprogramming languages do you know\b/i.test(text)) return 'programming_languages';
  if (/\bwhat is your main development language\b/i.test(text)) return 'main_development_language';
  return '';
}

/** @param {string} label @param {string[]} options */
function isHybridOptionGroup(label, options) {
  const normalizedLabel = String(label || '').trim();
  if (!/^(?:nyc|sf|san francisco|new york city|bay area)$/i.test(normalizedLabel)) return false;
  return options.some((option) => /\b(?:relocat|office|remote|hybrid|days?\s+(?:per|a)\s+week)\b/i.test(String(option || '')));
}

/** @param {string} answer @param {string[]} options */
function compatibleConfiguredOption(answer, options) {
  const normalizedAnswer = String(answer || '').trim().toLowerCase();
  if (!normalizedAnswer || !options.length) return String(answer || '').trim();
  const exact = options.find((option) => String(option).trim().toLowerCase() === normalizedAnswer);
  if (exact) return exact;
  const matchedConfiguredOption = matchAnswerToOptions(answer, options);
  if (matchedConfiguredOption !== String(answer).trim()) return matchedConfiguredOption;
  if (/^yes$/i.test(normalizedAnswer)) {
    return options.find((option) => /^yes\b/i.test(String(option)) && /\brelocat\w*\b/i.test(String(option)))
      || options.find((option) => /^yes\b/i.test(String(option)) && /\b(?:office|hybrid|days?\s+(?:per|a)\s+week)\b/i.test(String(option)))
      || options.find((option) => /^yes\b/i.test(String(option)))
      || String(answer).trim();
  }
  if (/^no$/i.test(normalizedAnswer)) return options.find((option) => /^no\b/i.test(String(option))) || String(answer).trim();
  return String(answer).trim();
}

/** @param {Record<string, unknown>} profile @param {string} label */
function profileAnswer(profile, label) {
  const text = label.toLowerCase();
  const identity = profile.identity || {};
  const address = profile.address || {};
  const links = profile.links || {};
  const location = [address.city, address.state || address.country].filter(Boolean).join(', ');
  const country = address.country || '';
  const values = [
    [/^first name\b/, identity.first_name, 'profile:identity.first_name'],
    [/^last name\b|surname/, identity.last_name, 'profile:identity.last_name'],
    [/full name|legal name|your name/, identity.full_name, 'profile:identity.full_name'],
    [/email/, identity.email, 'profile:identity.email'],
    [/contact\s+number|phone|mobile|telephone/, identity.phone, 'profile:identity.phone'],
    [/pronouns?/, identity.pronouns, 'profile:identity.pronouns'],
    [/linkedin/, links.linkedin, 'profile:links.linkedin'],
    [/github/, links.github, 'profile:links.github'],
    [/portfolio|personal site|website/, links.website, 'profile:links.website'],
  ];
  for (const [pattern, value, source] of values) {
    if (pattern.test(text) && value) return { answer: String(value), source };
  }
  if (/\bwhich country are you working from\b/i.test(text) && country) {
    return { answer: String(country), source: 'profile:address.country' };
  }
  if (isCurrentLocationPrompt(text) && location) return { answer: String(location), source: 'profile:address' };
  if (/^(?:country|country\/region|country of residence)\b/i.test(text) && country) {
    return { answer: String(country), source: 'profile:address.country' };
  }
  return null;
}

/** @param {Record<string, unknown>} profile @param {string} label */
function profileQuestionAnswer(profile, label, context = {}) {
  const text = label.toLowerCase();
  const authorization = profile.work_authorization || {};
  if (/legally authorized|authorized to work|eligible to work|work authorization|right to work/.test(text)) {
    return { answer: authorization.authorized_us ? 'Yes' : 'No', source: 'profile:work_authorization.authorized_us', sensitive: true };
  }
  if (/sponsor|require .*(petition|immigration)|file a petition|immigration status|nonimmigrant|visa status/.test(text)) {
    const requiresSponsorship = sponsorshipRequirement(profile, context);
    return {
      answer: requiresSponsorship ? 'Yes' : 'No',
      source: requiresSponsorship
        ? 'profile:work_authorization.requires_sponsorship_outside_us'
        : 'profile:work_authorization.requires_sponsorship',
      sensitive: true,
    };
  }
  if (isRecentEmployerPrompt(label)) {
    const experiences = Array.isArray(profile.work_experience) ? profile.work_experience : [];
    const current = experiences.find((experience) => experience && experience.current === true);
    const prior = experiences.find((experience) => experience && experience.current !== true && experience.employer);
    if (current?.employer) {
      return {
        answer: `Self-employed (${String(current.employer)})${prior?.employer ? `; prior employer: ${String(prior.employer)}.` : '.'}`,
        source: 'profile:work_experience',
      };
    }
  }
  if (isRecentTitlePrompt(label)) {
    const current = Array.isArray(profile.work_experience)
      ? profile.work_experience.find((experience) => experience && experience.current === true)
      : null;
    if (current?.title) return { answer: String(current.title), source: 'profile:work_experience' };
  }
  if (isStartDatePrompt(label)) {
    const answers = profile.application_answers && typeof profile.application_answers === 'object'
      ? /** @type {Record<string, unknown>} */ (profile.application_answers)
      : {};
    const availability = answers.availability && typeof answers.availability === 'object'
      ? /** @type {Record<string, unknown>} */ (answers.availability)
      : null;
    if (availability?.answer) {
      return { answer: String(availability.answer), source: String(availability.source || 'profile:application_answers.availability') };
    }
  }
  return null;
}

/** @param {Record<string, unknown>} profile @param {string} label @param {string[]} [options] */
function profileApplicationAnswer(profile, label, options = []) {
  const answerKey = configuredApplicationAnswerKey(label) || (isAiUsageQuestion(label)
    ? 'ai_usage'
    : isAgenticSystemsQuestion(label)
      ? 'agentic_systems'
      : isCustomerDeliveryQuestion(label)
        ? 'customer_delivery'
        : isTechnicalFoundationsQuestion(label)
          ? 'technical_foundations'
          : isCloudInfrastructureQuestion(label)
            ? 'cloud_infrastructure'
            : isPythonProductionQuestion(label)
              ? 'python_production'
              : isProductionSystemQuestion(label)
                ? 'production_system'
              : isRecentEmployerPrompt(label)
                  ? 'most_recent_employer'
                  : isRecentTitlePrompt(label)
                    ? 'most_recent_job_title'
                    : isStartDatePrompt(label)
                    ? 'availability'
                      : '');
  const resolvedAnswerKey = answerKey || (isHybridOptionGroup(label, options) ? 'hybrid_work' : '');
  if (!resolvedAnswerKey) return null;
  const configuredAnswers = profile.application_answers && typeof profile.application_answers === 'object'
    ? /** @type {Record<string, unknown>} */ (profile.application_answers)
    : {};
  const configured = configuredAnswers[resolvedAnswerKey] && typeof configuredAnswers[resolvedAnswerKey] === 'object'
    ? /** @type {Record<string, unknown>} */ (configuredAnswers[resolvedAnswerKey])
    : null;
  const answer = compatibleConfiguredOption(String(configured?.answer || '').trim(), options);
  if (!answer) return null;
  const configuredEvidenceBacked = configured?.evidenceBacked ?? configured?.evidence_backed;
  const configuredAnswerStatus = configured?.answerStatus ?? configured?.answer_status;
  return {
    answer,
    source: String(configured?.source || `profile:application_answers.${resolvedAnswerKey}`),
    evidenceBacked: configuredEvidenceBacked !== false,
    answerScope: String(configured?.answerScope || configured?.answer_scope || 'question'),
    answerStatus: configuredAnswerStatus ? String(configuredAnswerStatus) : null,
    evidenceRefs: [
      String(configured?.source || `profile:application_answers.${resolvedAnswerKey}`),
      ...(Array.isArray(configured?.evidenceRefs)
        ? configured.evidenceRefs.map(String)
        : Array.isArray(configured?.evidence_refs) ? configured.evidence_refs.map(String) : []),
    ].filter(Boolean),
  };
}

/** @param {Record<string, unknown>} control */
function manualReason(control) {
  const label = String(control.label || '');
  if (EEO_LABEL_RE.test(label)) return 'voluntary self-identification — complete manually';
  if (LEGAL_LABEL_RE.test(label)) return 'legal or attestation field — review manually';
  if (MARKETING_RE.test(label)) return 'marketing consent — leave unchecked unless you choose otherwise';
  if (isSensitiveQuestion(label)) return 'sensitive or eligibility field — complete manually';
  if (control.manualReason) return String(control.manualReason);
  return '';
}

/** @param {Record<string, unknown>} control */
function isStandardControl(control) {
  if (control.category === 'standard') return true;
  const label = String(control.label || '');
  const normalizedLabel = label.trim().replace(/[\s*:]+$/g, '').trim();
  return /first name|last name|full name|legal name|preferred name|email|phone|mobile|telephone|contact number|linkedin|github|portfolio|personal site|website/i.test(label)
    || /^(?:your\s+)?name$/i.test(label.trim())
    || /^(?:country|country\/region|country of residence)$/i.test(normalizedLabel);
}

/** @param {Record<string, unknown>} control */
function shouldRecord(control) {
  return control.category === 'question' && !isStandardControl(control) && !manualReason(control);
}

/** @param {Record<string, unknown>} control */
function isNarrativeControl(control) {
  if (!['text', 'textarea'].includes(String(control.kind || control.type || '').toLowerCase())) return false;
  const label = String(control.label || '');
  const nonNarrativeLabel = /\b(?:first|last|full|legal|preferred)\s+name\b|\b(?:email|phone|mobile|telephone|contact number|pronouns?|linkedin|github|portfolio|website|country|location|address|city|state|zip|postal|salary|compensation|authorization|sponsor(?:ship)?|visa|consent|gender|race|veteran|disabil\w*|captcha|mfa|verification|attest\w*|background|criminal|conviction|earliest|start date|availability|deadline|timeline|relocat\w*|in[- ]person|on[- ]site|onsite|remote|work from)\b/i;
  return control.category === 'question'
    && !nonNarrativeLabel.test(label);
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
export function answerForControl(control, item, profile, ledger, options = {}) {
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
      evidenceBacked: false,
      answerStatus: reusable.answerStatus,
      evidenceRefs: reusable.evidenceRefs,
      reuse: {
        matchType: reusable.matchType,
        confidence: reusable.confidence,
        matchedQuestion: reusable.entry.question,
      },
    };
  }

  const applicationAnswer = profileApplicationAnswer(profile, label, Array.isArray(control.options) ? control.options.map(String) : []);
  if (applicationAnswer) {
    return {
      ...applicationAnswer,
      kind: 'evidence-backed-profile',
    };
  }

  const coachingDraft = options.drafts ? draftForControl(control, options.drafts) : null;
  if (coachingDraft && isNarrativeControl(control)) {
    const drafted = answerFromDraft(coachingDraft, options.draftsPath);
    if (drafted) return drafted;
  }

  const motivation = motivationAnswerForItem({
    ...item,
    question: label,
  }, profile);
  if (motivation) return motivation;

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
      evidenceBacked: accomplishment.approved !== false && Number(accomplishment.evidenceStrength || 0) > 0,
      answerScope: narrative ? 'role' : 'question',
      evidenceRefs: [
        `project-accomplishment:${accomplishment.id}`,
        ...(Array.isArray(accomplishment.sourceRefs) ? accomplishment.sourceRefs.map(String) : []),
      ],
      reuse: { matchType: 'job-aware-project-selection', confidence: Number(accomplishment.score || 0) },
      humanization: narrative ? auditHumanizedText(answer, '') : { status: 'not-applicable', passed: true, errors: [] },
    };
  }

  const profileValue = profileQuestionAnswer(profile, label, item) || profileAnswer(profile, label);
  if (profileValue) {
    return {
      ...profileValue,
      kind: 'verified-profile',
      evidenceBacked: !profileValue.sensitive,
      evidenceRefs: [profileValue.source],
    };
  }

  const common = answerFor(label, [commonQuestions(profile, item)]);
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
export function applicationEvidenceGate(item, inspection) {
  const pages = Array.isArray(inspection.pages) && inspection.pages.length ? inspection.pages : [inspection];
  const expectedTitle = normalizeJobTitle(item.title);
  const titleVisible = pages.some((page) => page.titleVisible === true || (
    expectedTitle
      ? [page.heading, page.title].some((value) => normalize(String(value || '')).toLowerCase().includes(expectedTitle.toLowerCase()))
      : [page.heading, page.title].some((value) => normalize(String(value || '')))
  ));
  const formReady = pages.some((page) => page.formReady === true);
  const queuedDescription = normalize(String(item.description || ''));
  const observedDescription = jobDescriptionFromInspection(inspection);
  const description = queuedDescription.length >= 120 ? queuedDescription : normalize(observedDescription.description);
  const reasons = [];
  if (!expectedTitle || !titleVisible) reasons.push('the active posting title was not visible in the inspected application flow');
  if (description.length < 120) reasons.push('the job description is missing or too short to verify this application safely');
  if (!formReady) reasons.push('no application form or application path was detected');
  return {
    ok: reasons.length === 0,
    reasons,
    titleVisible,
    formReady,
    descriptionLength: description.length,
    descriptionSource: queuedDescription.length >= 120
      ? String(item.descriptionSource || 'queue')
      : observedDescription.source || null,
  };
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
  const simpleFields = [];
  const standardFields = [];
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
    if (isStandardControl(control)) {
      standardFields.push({
        label,
        required: control.required === true,
        fieldKind: control.kind || control.type || 'text',
        occurrence: {
          id: control.id || null,
          name: control.name || null,
          fieldPath: control.fieldPath || null,
          pageIndex: control.pageIndex,
          pageUrl: control.pageUrl || null,
        },
      });
      continue;
    }
    const entry = recorded.find((candidate) => candidate.control === control)?.entry || null;
    const manualFieldReason = manualReason(control);
    if (manualFieldReason) {
      manual.push({
        label,
        required: control.required === true,
        reason: manualFieldReason,
        options: control.options || [],
        multiple: control.multiple === true,
      });
      continue;
    }
    let resolved = answerForControl(control, item, profile, ledger, options);
    const answer = resolved?.answer || null;
    if (entry && answer && resolved?.evidenceBacked === true) {
      const evidenceAnswer = recordEvidenceBackedAnswerInLedger(ledger, entry.id, answer, {
        scope: resolved.answerScope || (isNarrativeControl(control) ? 'role' : 'question'),
        company: item.company,
        role: item.title,
        url: item.applyUrl || item.canonicalUrl,
        queueId: item.id,
        evidenceRefs: resolved.evidenceRefs,
      });
      if (evidenceAnswer) {
        resolved = {
          ...resolved,
          answerRef: evidenceAnswer.answerRef,
          answerStatus: evidenceAnswer.answer.answerStatus,
          evidenceRefs: evidenceAnswer.answer.evidenceRefs || resolved.evidenceRefs || [],
        };
      }
    }
    const status = resolved?.approvedAnswer ? 'approved'
        : resolved?.kind === 'humanized' ? 'humanized'
        : resolved?.kind === 'draft' ? 'draft'
          : resolved?.evidenceBacked === true ? 'evidence-backed'
          : resolved?.answerStatus === 'evidence-backed' ? 'evidence-backed'
          : answer !== null ? 'confirmed' : 'unanswered';
    const field = {
      id: entry?.id || null,
      question: label,
      required: control.required === true,
      fieldKind: control.kind || control.type || 'text',
      options: Array.isArray(control.options) ? control.options : [],
      multiple: control.multiple === true,
      category: control.category || 'question',
      answer,
      rawAnswer: resolved?.rawAnswer || (resolved?.kind === 'draft' ? answer : null),
      humanizedAnswer: resolved?.humanizedAnswer || null,
      approvedAnswer: resolved?.approvedAnswer || null,
      status,
      answerStatus: resolved?.answerStatus || null,
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
    };
    if (isNarrativeControl(control) || ['draft', 'humanized', 'approved'].includes(status)) questions.push(field);
    else simpleFields.push(field);
  }
  if (options.persistLedger !== false) saveLedger(ledgerPath, ledger);
  return { questions, simpleFields, standardFields, artifacts, manual, ledger };
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

/**
 * @param {Record<string, unknown>} item
 * @param {{ dryRun?: boolean, contactDiscoveryRunner?: (item: Record<string, unknown>) => Promise<Record<string, unknown>> }} [options]
 */
export async function contactDiscoveryForPacket(item, options = {}) {
  const fitScore = Number(item.fitScore);
  const base = {
    threshold: PACKET_CONTACT_DISCOVERY_MIN_FIT_SCORE,
    fitScore: Number.isFinite(fitScore) ? fitScore : null,
    contacts: [],
    sources: [],
    queries: [],
    errors: [],
    warnings: [],
    emailConventions: [],
    emailHypotheses: [],
    emailVerification: [],
    candidateEmailVerification: [],
    cacheReused: false,
    sendAuthorized: false,
    submissionGate: 'confirmed-submission-required',
  };
  if (!Number.isFinite(fitScore) || fitScore < PACKET_CONTACT_DISCOVERY_MIN_FIT_SCORE) {
    return {
      ...base,
      eligible: false,
      outcome: 'not-eligible',
      reason: Number.isFinite(fitScore)
        ? `fit score ${fitScore.toFixed(1)} is below the 4.3 contact-discovery floor`
        : 'fit score is unavailable, so the 4.3 contact-discovery floor cannot be confirmed',
    };
  }

  try {
    const runner = options.contactDiscoveryRunner || (async (target) => {
      const outreach = await import('../outreach.mjs');
      return outreach.discoverContactEvidenceForPacket(target, { dryRun: options.dryRun === true });
    });
    const result = await runner(item);
    const contacts = Array.isArray(result?.contacts) ? result.contacts : [];
    const pipelineStatus = String(result?.status || 'unavailable');
    const outcome = contacts.length || pipelineStatus === 'found'
      ? 'found'
      : pipelineStatus === 'no_contacts'
        ? 'no-verified-result'
        : 'unavailable';
    return {
      ...base,
      eligible: true,
      outcome,
      pipelineStatus,
      pipelineVersion: result?.pipelineVersion || null,
      mode: result?.mode || 'packet-prep',
      reason: String(result?.reason || (outcome === 'no-verified-result'
        ? 'no verified contact result was found'
        : 'contact discovery is unavailable')),
      contacts,
      sources: Array.isArray(result?.sources) ? result.sources : [],
      queries: Array.isArray(result?.queries) ? result.queries : [],
      errors: Array.isArray(result?.errors) ? result.errors : [],
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      emailConventions: Array.isArray(result?.emailConventions) ? result.emailConventions : [],
      emailHypotheses: Array.isArray(result?.emailHypotheses) ? result.emailHypotheses : [],
      emailVerification: Array.isArray(result?.emailVerification) ? result.emailVerification : [],
      candidateEmailVerification: Array.isArray(result?.candidateEmailVerification) ? result.candidateEmailVerification : [],
      cacheReused: result?.cacheReused === true,
    };
  } catch (error) {
    return {
      ...base,
      eligible: true,
      outcome: 'unavailable',
      pipelineStatus: 'error',
      reason: error instanceof Error ? error.message : String(error),
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
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
  const navigationActions = Array.isArray(packet.form?.navigationActions) ? packet.form.navigationActions : [];
  if (navigationActions.length) {
    lines.push('## Safe browser navigation', '');
    for (const action of navigationActions) lines.push(`- Clicked ${action.control || 'control'} (${action.reason || 'navigation'})`);
    lines.push('');
  }
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
  const questions = Array.isArray(packet.questions) ? packet.questions : [];
  const manualItems = Array.isArray(packet.manualItems) ? packet.manualItems : [];
  const answerPrep = packet.answerPrep || {};
  lines.push('', '## Preparation summary', '');
  lines.push(`- Nontrivial answers prepared: ${Number(answerPrep.questionCount ?? questions.length)}`);
  lines.push(`- Simple fields excluded from copy/paste: ${Number(answerPrep.simpleFieldCount || 0)}`);
  lines.push(`- Standard profile fields excluded from copy/paste: ${Number(answerPrep.standardFieldCount || 0)}`);
  lines.push(`- Human-only fields: ${Number(answerPrep.manualFieldCount ?? manualItems.length)}`, '');
  lines.push('## Copy/paste answers', '');
  for (const question of questions.filter((entry) => ['known', 'confirmed', 'evidence-backed', 'approved', 'humanized', 'draft'].includes(entry.status) && entry.answer !== null)) {
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
  const simpleUnresolved = Array.isArray(packet.simpleUnresolved) ? packet.simpleUnresolved : [];
  lines.push('## Simple fields to complete in the form', '');
  if (!simpleUnresolved.length) lines.push('- None recorded.');
  for (const question of simpleUnresolved) {
    lines.push(`- ${question.question} (${question.required ? 'required' : 'optional'})`);
    if (question.options?.length) lines.push(`  Options: ${question.options.join(' | ')}`);
  }
  lines.push('');
  const reviewItems = Array.isArray(packet.reviewItems) ? packet.reviewItems : [];
  if (reviewItems.length) {
    lines.push('## Drafts needing human review', '');
    for (const item of reviewItems) lines.push(`- ${item.question}: ${item.reason || 'review before copying'}`);
    lines.push('');
  }
  const research = Array.isArray(packet.research?.references) ? packet.research.references : [];
  if (research.length) lines.push('## Research references', '', ...research.map((reference) => `- ${reference}`), '');
  const discovery = packet.contactDiscovery || {};
  const discoveryLabel = {
    found: 'Found',
    'no-verified-result': 'No verified result',
    unavailable: 'Unavailable',
    'not-eligible': 'Not eligible',
  }[discovery.outcome] || 'Unavailable';
  lines.push('## Contact research', '');
  lines.push(`- Outcome: ${discoveryLabel}`);
  lines.push(`- Fit score: ${discovery.fitScore === null || discovery.fitScore === undefined ? 'not available' : Number(discovery.fitScore).toFixed(1)}/5`);
  lines.push(`- Discovery floor: ${Number(discovery.threshold || PACKET_CONTACT_DISCOVERY_MIN_FIT_SCORE).toFixed(1)}/5`);
  if (discovery.reason) lines.push(`- Detail: ${discovery.reason}`);
  if (discovery.cacheReused) lines.push('- Evidence source: valid cached discovery snapshot');
  const discoveredContacts = Array.isArray(discovery.contacts) ? discovery.contacts : [];
  for (const contact of discoveredContacts) {
    const identity = [contact.name, contact.role || contact.title].filter(Boolean).join(' — ') || 'Contact';
    const verification = contact.emailVerified === true ? 'verified' : 'unverified';
    lines.push(`- ${identity}${contact.email ? ` — ${contact.email} (${verification})` : ''}`);
    if (contact.sourceUrl || contact.profileUrl) lines.push(`  Source: ${contact.sourceUrl || contact.profileUrl}`);
  }
  const discoverySources = Array.isArray(discovery.sources) ? discovery.sources : [];
  for (const source of discoverySources) lines.push(`- Source: ${source}`);
  const emailHypotheses = Array.isArray(discovery.emailHypotheses) ? discovery.emailHypotheses : [];
  for (const hypothesis of emailHypotheses.filter((entry) => entry.sendable !== true)) {
    lines.push(`- ${[hypothesis.name, hypothesis.email].filter(Boolean).join(' — ') || 'Email convention hypothesis'} (unverified hypothesis; not sendable)`);
  }
  const discoveryQueries = Array.isArray(discovery.queries) ? discovery.queries : [];
  if (!discoveredContacts.length && discoveryQueries.length) {
    lines.push('- Manual follow-up searches:');
    for (const query of discoveryQueries) lines.push(`  - ${query}`);
  }
  lines.push('- Contact discovery is research only and does not authorize outreach; confirmed submission is still required.', '');
  const manual = Array.isArray(packet.manualItems) ? packet.manualItems : [];
  lines.push('## Human-only checks', '');
  if (!manual.length) lines.push('- Review the form and final submission control.');
  for (const item of manual) lines.push(`- ${item.label}: ${item.reason}`);
  lines.push('- Review all personal, eligibility, legal, consent, and voluntary demographic fields.', '- Click Submit/Apply only after your review.', '');
  return `${lines.join('\n').trim()}\n`;
}

/** @param {Record<string, unknown>} item @param {{ browser?: string, headed?: boolean, cdpEndpoint?: string, ledgerPath?: string, profilePath?: string, outputRoot?: string, generateArtifacts?: boolean, generateCoverLetter?: boolean, dryRun?: boolean, inspection?: Record<string, unknown>, maxPages?: number, answersPath?: string, drafts?: { questions: Array<Record<string, unknown>>, coverLetter?: Record<string, unknown>, sourcePath?: string }, researchReferences?: string[], jackCoaching?: Record<string, unknown>, contactDiscoveryRunner?: (item: Record<string, unknown>) => Promise<Record<string, unknown>> }} [options] */
export async function buildApplicationPacket(item, options = {}) {
  const freshnessGate = packetFreshnessGate(item);
  if (!freshnessGate.ok) return { ok: false, status: 'stale', reason: freshnessGate.reason };
  const effectiveItem = {
    ...item,
    title: normalizeJobTitle(item.title) || normalize(String(item.title || '')),
    applyUrl: normalizeApplicationUrl(String(item.applyUrl || item.canonicalUrl || '')),
  };
  if (!effectiveItem.applyUrl) return { ok: false, reason: 'application URL is missing' };
  const profile = await loadProfile(options.profilePath || DEFAULT_PROFILE_PATH);
  const drafts = options.drafts || loadAnswerDrafts(options.answersPath || '');
  const cdpEndpoint = String(options.cdpEndpoint || process.env.CAREER_OPS_CDP_ENDPOINT || process.env.OPENCLI_CDP_ENDPOINT || '').trim();
  let inspection = options.inspection || null;
  if (!inspection) {
    let browser;
    try {
      browser = await launchBrowser(chromium, {
        headless: options.headed !== true,
        channel: options.browser || process.env.CAREER_OPS_BROWSER_CHANNEL || 'chrome',
        cdpEndpoint,
      });
      const page = await createBrowserPage(browser, { shared: Boolean(cdpEndpoint) });
      await page.goto(effectiveItem.applyUrl, { waitUntil: 'domcontentloaded' });
      await settle(page);
      inspection = await inspectApplicationFlow(page, {
        maxPages: options.maxPages,
        expectedTitle: normalizeJobTitle(effectiveItem.title),
      });
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
    const observedTitle = normalizeJobTitle(safeInspection.heading || safeInspection.title || '');
    if (observedTitle) effectiveItem.title = observedTitle;
  }
  const observedDescription = jobDescriptionFromInspection(safeInspection);
  if (observedDescription.description.length >= 120) {
    effectiveItem.description = observedDescription.description;
    effectiveItem.descriptionSource = observedDescription.source || 'application-page';
  } else if (normalize(String(effectiveItem.description || '')).length >= 120) {
    effectiveItem.descriptionSource = effectiveItem.descriptionSource || 'queue';
  }
  const evidenceGate = applicationEvidenceGate(effectiveItem, safeInspection);
  const allControls = inspectionControls(safeInspection);
  const allButtons = pages.flatMap((page) => Array.isArray(page.buttons) ? page.buttons : []);
  const allManualSignals = [...new Set(pages.flatMap((page) => Array.isArray(page.manualSignals) ? page.manualSignals : []))];
  const coverRequired = options.generateCoverLetter === true
    || allControls.some((control) => control.category === 'artifact' && /cover/i.test(String(control.label || '')) && control.required === true);
  const { questions, simpleFields, standardFields, artifacts, manual, ledger } = buildQuestions(effectiveItem, safeInspection, profile, options.ledgerPath || DEFAULT_LEDGER_PATH, {
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
  const simpleUnresolved = simpleFields.filter((question) => question.status === 'unanswered');
  const allUnresolved = [...unresolved, ...simpleUnresolved];
  const requiredUnresolved = allUnresolved.filter((question) => question.required);
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
  const contactDiscovery = await contactDiscoveryForPacket(effectiveItem, options);
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
      descriptionLength: normalize(String(effectiveItem.description || '')).length,
      descriptionSource: effectiveItem.descriptionSource || null,
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
      navigationActions: Array.isArray(safeInspection.actions) ? safeInspection.actions : [],
      manualSignals: allManualSignals,
      prepQuestionCount: questions.length,
      simpleFieldCount: simpleFields.length,
      standardFieldCount: standardFields.length,
      manualFieldCount: manual.length,
      artifactFieldCount: artifacts.length,
    },
    artifacts: generatedArtifacts,
    resumeDecision: packetResumeDecision,
    coverLetter,
    questions,
    simpleFields,
    standardFields,
    unresolved,
    simpleUnresolved,
    reviewItems,
    manualItems: manual,
    artifactFields: artifacts,
    answerPrep: {
      questionCount: questions.length,
      unresolvedCount: unresolved.length,
      simpleFieldCount: simpleFields.length,
      simpleUnresolvedCount: simpleUnresolved.length,
      standardFieldCount: standardFields.length,
      manualFieldCount: manual.length,
      artifactFieldCount: artifacts.length,
      requiredUnresolvedCount: requiredUnresolved.length,
    },
    research: {
      references: researchReferences,
      coaching: options.jackCoaching || { primary: 'career-ops-local-coaching', fallback: 'jackandjill-on-demand' },
      answerDraftsPath: options.answersPath || drafts.sourcePath || null,
    },
    contactDiscovery,
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
      unresolvedCount: allUnresolved.length,
      prepUnresolvedCount: unresolved.length,
      simpleUnresolvedCount: simpleUnresolved.length,
      pendingGroups: pendingQuestions(ledger, {
        company: String(effectiveItem.company || ''),
        role: String(effectiveItem.title || ''),
        url: String(effectiveItem.applyUrl || ''),
      }).length,
    },
    checklist: [
      'Open the canonical application URL and confirm the posting is still active.',
      'Attach the selected resume and cover letter files when required.',
      'Review each prepared nontrivial answer, including draft/humanized narrative text.',
      'Complete simple profile and eligibility fields directly in the form.',
      'Complete EEO, consent, legal, CAPTCHA, MFA, and identity fields manually.',
      'Perform the final Submit/Apply action yourself after review.',
    ],
  };
  const historyState = options.dryRun
    ? { history: [] }
    : snapshotPreviousPacket(packetPaths, packet);
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
      'cdp-endpoint': { type: 'string' },
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
    cdpEndpoint: values['cdp-endpoint'],
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
    questionCount: result.answerPrep?.questionCount ?? result.questions.length,
    prepQuestionCount: result.answerPrep?.questionCount ?? result.questions.length,
    unresolvedCount: result.answerPrep?.unresolvedCount ?? result.unresolved.length,
    simpleFieldCount: result.answerPrep?.simpleFieldCount || 0,
    simpleUnresolvedCount: result.answerPrep?.simpleUnresolvedCount || 0,
    standardFieldCount: result.answerPrep?.standardFieldCount || 0,
    requiredUnresolvedCount: result.answerPrep?.requiredUnresolvedCount || 0,
    markdownPath: result.paths.markdown,
    jsonPath: result.paths.json,
  })}`);
}
