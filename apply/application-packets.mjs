#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  recordQuestion,
} from './question-ledger.mjs';
import { selectProjectAccomplishment } from '../project-accomplishment-ledger.mjs';
import { generateApplicationArtifacts, jobHash } from './application-artifacts.mjs';
import { inspectApplicationPage, applicationAdapter, normalizeApplicationUrl } from './form-inspection.mjs';
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
  const identity = shortHash(`${item.id || ''}\n${item.applyUrl || item.canonicalUrl || ''}\n${item.company || ''}\n${item.title || ''}`);
  const directory = path.join(options.outputRoot || DEFAULT_PACKET_ROOT, `${slug(target)}-${identity}`);
  return {
    directory,
    json: path.join(directory, 'submission-packet.json'),
    markdown: path.join(directory, 'submission-packet.md'),
  };
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

/** @param {Record<string, unknown>} control @param {Record<string, unknown>} item @param {Record<string, unknown>} profile @param {{ entries: Array<Record<string, unknown>> }} ledger */
function answerForControl(control, item, profile, ledger) {
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
      source: `question-ledger:${reusable.entry.id}`,
      reuse: {
        matchType: reusable.matchType,
        confidence: reusable.confidence,
        matchedQuestion: reusable.entry.question,
      },
    };
  }

  const accomplishment = selectProjectAccomplishment({
    question: label,
    company: item.company,
    title: item.title,
    description: item.description,
    lane: item.lane,
  });
  if (accomplishment?.answer) {
    return {
      answer: String(accomplishment.answer),
      source: `project-accomplishment:${accomplishment.id}`,
      reuse: { matchType: 'job-aware-project-selection', confidence: Number(accomplishment.score || 0) },
    };
  }

  const profileValue = profileAnswer(profile, label) || profileQuestionAnswer(profile, label);
  if (profileValue) return profileValue;

  const common = answerFor(label, [commonQuestions(profile)]);
  if (common !== null) return { answer: common, source: 'profile:common-question-rule', sensitive: sensitivity === 'high' };
  return null;
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} control @param {Record<string, unknown>} metadata @param {string} ledgerPath */
function recordFormQuestion(item, control, metadata, ledgerPath) {
  if (!shouldRecord(control)) return null;
  return recordQuestion(ledgerPath, String(control.label || ''), {
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

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} inspection @param {Record<string, unknown>} profile @param {string} ledgerPath */
function buildQuestions(item, inspection, profile, ledgerPath) {
  const recorded = [];
  for (const control of inspection.controls || []) {
    const entry = recordFormQuestion(item, control, { reason: manualReason(control) }, ledgerPath);
    if (entry) recorded.push({ control, entry });
  }
  const ledger = loadLedger(ledgerPath);
  const questions = [];
  const artifacts = [];
  const manual = [];
  for (const control of inspection.controls || []) {
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
    const resolved = manualFieldReason ? null : answerForControl(control, item, profile, ledger);
    const answer = resolved?.answer || null;
    questions.push({
      id: entry?.id || null,
      question: label,
      required: control.required === true,
      fieldKind: control.kind || control.type || 'text',
      options: Array.isArray(control.options) ? control.options : [],
      category: control.category || 'question',
      answer,
      status: manualFieldReason ? 'manual' : answer !== null ? 'known' : 'unanswered',
      source: resolved?.source || null,
      reuse: resolved?.reuse || null,
      sensitivity: isSensitiveQuestion(label) ? 'high' : 'normal',
      occurrence: {
        id: control.id || null,
        name: control.name || null,
        fieldPath: control.fieldPath || null,
      },
    });
  }
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
  lines.push('', '## Copy/paste answers', '');
  const questions = Array.isArray(packet.questions) ? packet.questions : [];
  for (const question of questions.filter((entry) => entry.status === 'known' && entry.answer !== null)) {
    lines.push(`### ${question.question}`, '', `Answer: ${question.answer}`, `Source: ${question.source || 'verified ledger'}`, '');
  }
  const unresolved = Array.isArray(packet.unresolved) ? packet.unresolved : [];
  lines.push('## Questions waiting for you', '');
  if (!unresolved.length) lines.push('- None recorded.');
  for (const question of unresolved) {
    lines.push(`### ${question.question}`, '', `Required: ${question.required ? 'yes' : 'no'}`, `Answer: [your answer]`);
    if (question.options?.length) lines.push(`Options: ${question.options.join(' | ')}`);
    if (question.id) lines.push(`Ledger id: ${question.id}`);
    lines.push('');
  }
  const manual = Array.isArray(packet.manualItems) ? packet.manualItems : [];
  lines.push('## Human-only checks', '');
  if (!manual.length) lines.push('- Review the form and final submission control.');
  for (const item of manual) lines.push(`- ${item.label}: ${item.reason}`);
  lines.push('- Review all personal, eligibility, legal, consent, and voluntary demographic fields.', '- Click Submit/Apply only after your review.', '');
  return `${lines.join('\n').trim()}\n`;
}

/** @param {Record<string, unknown>} item @param {{ browser?: string, headed?: boolean, cdpEndpoint?: string, ledgerPath?: string, profilePath?: string, outputRoot?: string, generateArtifacts?: boolean }} [options] */
export async function buildApplicationPacket(item, options = {}) {
  const freshnessGate = packetFreshnessGate(item);
  if (!freshnessGate.ok) return { ok: false, reason: freshnessGate.reason };
  const effectiveItem = {
    ...item,
    applyUrl: normalizeApplicationUrl(String(item.applyUrl || item.canonicalUrl || '')),
  };
  if (!effectiveItem.applyUrl) return { ok: false, reason: 'application URL is missing' };
  const profile = await loadProfile(options.profilePath || DEFAULT_PROFILE_PATH);
  let artifactsResult = null;
  let artifactWarning = '';
  if (options.generateArtifacts !== false) {
    try {
      artifactsResult = await generateApplicationArtifacts(effectiveItem, { includeCoverLetter: true });
      if (!artifactsResult.ok) artifactWarning = String(artifactsResult.reason || 'artifact generation failed');
      if (artifactsResult.jobDescription && String(artifactsResult.jobDescription).length > String(effectiveItem.description || '').length) effectiveItem.description = artifactsResult.jobDescription;
    } catch (error) {
      artifactWarning = error instanceof Error ? error.message : String(error);
    }
  }

  const browser = await launchBrowser(chromium, {
    headless: options.headed !== true,
    channel: options.browser || process.env.CAREER_OPS_BROWSER_CHANNEL || 'chrome-beta',
    cdpEndpoint: options.cdpEndpoint,
  });
  let inspection;
  try {
    const page = await browser.newPage();
    await page.goto(effectiveItem.applyUrl, { waitUntil: 'domcontentloaded' });
    await settle(page);
    inspection = await inspectApplicationPage(page);
  } finally {
    await browser.close();
  }

  const { questions, artifacts, manual, ledger } = buildQuestions(effectiveItem, inspection, profile, options.ledgerPath || DEFAULT_LEDGER_PATH);
  const generatedArtifacts = artifactsResult?.ok ? {
    manifestPath: artifactsResult.manifestPath,
    resumePdf: artifactsResult.resumePdf,
    coverLetterPdf: artifactsResult.coverLetterPdf,
    coverLetterText: artifactsResult.coverLetterText,
    descriptionSource: artifactsResult.job?.descriptionSource || null,
  } : {
    manifestPath: '',
    resumePdf: '',
    coverLetterPdf: '',
    coverLetterText: '',
    descriptionSource: null,
  };
  const packetPaths = packetPathsForItem(effectiveItem, { outputRoot: options.outputRoot });
  const unresolved = questions.filter((question) => question.status === 'unanswered' && question.required);
  const status = unresolved.length ? 'needs-user-answers' : 'ready-for-human-review';
  const packet = {
    schemaVersion: 1,
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
    },
    form: {
      title: inspection.title || '',
      heading: inspection.heading || '',
      url: inspection.url || effectiveItem.applyUrl,
      formCount: inspection.formCount || 0,
      formReady: inspection.formReady === true,
      submitControls: (inspection.buttons || []).filter((button) => button.submitLike),
    },
    artifacts: generatedArtifacts,
    questions,
    unresolved,
    manualItems: manual,
    artifactFields: artifacts,
    warnings: [freshnessGate.warning || '', artifactWarning, inspection.formReady ? '' : 'no rendered application form was detected'].filter(Boolean),
    ledger: {
      path: options.ledgerPath || DEFAULT_LEDGER_PATH,
      canonicalQuestionCount: ledger.entries.length,
      unresolvedCount: unresolved.length,
    },
  };
  const markdown = buildPacketMarkdown(packet);
  mkdirSync(packetPaths.directory, { recursive: true });
  writeFileSync(packetPaths.json, `${JSON.stringify({ ...packet, paths: packetPaths }, null, 2)}\n`, 'utf8');
  writeFileSync(packetPaths.markdown, markdown, 'utf8');
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
