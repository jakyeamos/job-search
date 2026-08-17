#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

import { isCompanyMotivationQuestion } from './question-ledger.mjs';
import { loadProjectAccomplishmentLedger } from '../project-accomplishment-ledger.mjs';

const MIN_JOB_DESCRIPTION_LENGTH = 120;

const SIGNALS = [
  {
    id: 'safety',
    label: 'AI safety and misuse mitigation',
    job: /\b(?:safety|safeguard|misuse|harm(?:s)?|red[- ]team(?:ing)?|adversarial|threat model|mitigat(?:e|ion)|responsible scaling|steerable|trustworthy|interpretab)/i,
    evidence: /\b(?:safety|safeguard|misuse|harm(?:s)?|red[- ]team(?:ing)?|adversarial|threat model|mitigat(?:e|ion)|guardrail|responsible|steerable|trustworthy|interpretab)/i,
  },
  {
    id: 'evaluation',
    label: 'evaluation, benchmarks, and reliability',
    job: /\b(?:evaluat(?:e|ed|es|ing|ion|ions)|benchmark(?:s)?|classifier(?:s)?|monitor(?:ing)?|anomal(?:y|ies)|signals?|test(?:ing|s)?|robustness)\b/i,
    evidence: /\b(?:evaluat(?:e|ed|es|ing|ion|ions)|benchmark(?:s)?|paired comparison|model selection|classifier(?:s)?|monitor(?:ing)?|anomal(?:y|ies)|reliab(?:le|ility))\b/i,
  },
  {
    id: 'agentic',
    label: 'agentic systems and their failure modes',
    job: /\b(?:agent(?:ic|s)?|prompt injection|tool use|multi[- ]turn|across contexts|coordinated attacks?)\b/i,
    evidence: /\b(?:agent(?:ic|s)?|prompt injection|tool use|multi[- ]turn|context(?:s)?|handoff(?:s)?|workflow(?:s)?|evaluation)\b/i,
  },
  {
    id: 'data',
    label: 'data pipelines and evidence-backed analysis',
    job: /\b(?:data pipeline(?:s)?|synthetic data|data ingestion|analytics|signals?|aggregate|analy[sz](?:e|ing|is)|sql|warehouse)\b/i,
    evidence: /\b(?:data pipeline(?:s)?|synthetic data|data ingestion|analytics|signals?|aggregate|analy[sz](?:e|ing|is)|sql|warehouse|data contract)\b/i,
  },
  {
    id: 'applied-ai',
    label: 'applied AI systems with human review',
    job: /\b(?:machine learning|ML systems?|AI systems?|large language models?|LLMs?|applied AI|research[- ]to[- ]deployment|production systems?)\b/i,
    evidence: /\b(?:machine learning|ML systems?|AI systems?|large language models?|LLMs?|applied AI|research[- ]to[- ]deployment|production systems?|human review|review[- ]gated|guardrail)\b/i,
  },
  {
    id: 'engineering',
    label: 'reliable backend systems and APIs',
    job: /\b(?:backend|API(?:s)?|Python|TypeScript|distributed systems?|production|deployment|service(?:s)?|infrastructure)\b/i,
    evidence: /\b(?:backend|API(?:s)?|Python|TypeScript|distributed systems?|production|deployment|service(?:s)?|infrastructure|data contract|reliab(?:le|ility))\b/i,
  },
];

const GENERIC_TOKENS = new Set([
  'about', 'also', 'and', 'are', 'build', 'built', 'building', 'company', 'develop',
  'development', 'experience', 'for', 'from', 'have', 'has', 'into', 'more', 'our',
  'role', 'should', 'system', 'systems', 'team', 'that', 'their', 'this', 'through',
  'to', 'use', 'using', 'want', 'we', 'what', 'with', 'work', 'you',
]);

/** @param {unknown} value */
function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value */
function plainText(value) {
  return normalize(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;|&ndash;/gi, '-')
    .replace(/&rsquo;|&lsquo;|&ldquo;|&rdquo;/gi, "'"));
}

/** @param {string} value @param {number} limit */
function compactText(value, limit = 280) {
  const text = normalize(value);
  if (text.length <= limit) return text;
  const firstSentence = text.match(/^(.{40,}?\.)(?:\s|$)/)?.[1];
  if (firstSentence && firstSentence.length <= limit) return firstSentence;
  return `${text.slice(0, Math.max(0, limit - 3)).replace(/\s+\S*$/, '')}...`;
}

/** @param {string} value */
function sentences(value) {
  return plainText(value)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalize(sentence))
    .filter(Boolean);
}

/** @param {string} value */
function missionPhrase(value) {
  const sentence = sentences(value).find((candidate) => /\bmission\b|safe and beneficial|reliable,? interpretable|trustworthy|steerable/i.test(candidate));
  if (!sentence) return '';
  const afterMission = sentence.match(/\bmission\s+(?:is|to|:)?\s*(.+)$/i)?.[1];
  return compactText(afterMission || sentence, 190).replace(/[.!?]+$/, '');
}

/** @param {string} value */
function meaningfulTokens(value) {
  return [...new Set(plainText(value)
    .toLowerCase()
    .replace(/[^a-z0-9+#./-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token)))];
}

/** @param {string} token */
function tokenFamily(token) {
  const value = String(token || '').toLowerCase();
  if (value.length < 6) return value;
  return value
    .replace(/(?:ations?|ments?|ments?|ingly|edly|ing|ed|es|s)$/i, '')
    .replace(/e$/, '');
}

/** @param {string} keyword @param {string} jobText */
function keywordMatchesJob(keyword, jobText) {
  const keywordText = normalize(keyword).toLowerCase();
  const normalizedJob = plainText(jobText).toLowerCase();
  if (keywordText && normalizedJob.includes(keywordText)) return true;
  const jobFamilies = new Set(meaningfulTokens(normalizedJob).map(tokenFamily));
  return meaningfulTokens(keyword).some((token) => jobFamilies.has(tokenFamily(token)));
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} ledger */
function evidenceCandidates(profile = {}, ledger = loadProjectAccomplishmentLedger()) {
  const candidates = [];
  const applicationAnswers = profile.application_answers && typeof profile.application_answers === 'object'
    ? profile.application_answers
    : {};
  for (const [key, raw] of Object.entries(applicationAnswers)) {
    if (!raw || typeof raw !== 'object') continue;
    const answer = normalize(raw.answer);
    if (!answer || raw.evidenceBacked === false || raw.answerStatus === 'manual') continue;
    candidates.push({
      id: `profile:${key}`,
      name: key.replace(/_/g, ' '),
      answer,
      keywords: [key.replace(/_/g, ' '), ...(Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs : [])],
      evidenceStrength: raw.evidenceBacked === true ? 5 : 2,
      priority: 0,
      sourceRefs: Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.map(String) : [String(raw.source || `profile:${key}`)],
    });
  }
  for (const entry of ledger.entries || []) {
    if (entry.approved === false || !normalize(entry.answer)) continue;
    candidates.push({
      id: String(entry.id || entry.name || 'project'),
      name: String(entry.name || entry.id || 'project'),
      answer: normalize(entry.answer),
      keywords: Array.isArray(entry.keywords) ? entry.keywords.map(String) : [],
      evidenceStrength: Number(entry.evidenceStrength || 0),
      priority: Number(entry.priority || 0),
      sourceRefs: Array.isArray(entry.sourceRefs) ? entry.sourceRefs.map(String) : [],
    });
  }
  return candidates;
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} profile @param {{ ledger?: Record<string, unknown>, coverLetterText?: string, coverLetterManifest?: Record<string, unknown> }} [options] */
export function motivationAnswerForItem(item = {}, profile = {}, options = {}) {
  const question = String(item.question || 'Why do you want to work here?');
  if (!isCompanyMotivationQuestion(question)) return null;

  const company = normalize(item.company || 'this company');
  const title = normalize(item.title || 'this role');
  const description = plainText(item.description || '');
  const coverLetter = readCoverLetterText(item, options);
  const coverLetterAnswer = extractCoverLetterOpening(coverLetter, company, title);
  if (coverLetterAnswer) {
    return {
      answer: coverLetterAnswer,
      source: 'job-aware-cover-letter',
      kind: 'draft',
      evidenceBacked: true,
      answerStatus: 'job-aware-draft',
      answerScope: 'posting',
      evidenceRefs: [
        String(item.applicationArtifactManifest || options.coverLetterManifest?.path || options.coverLetterText || 'generated cover-letter'),
        ...(Array.isArray(options.coverLetterManifest?.sourceFiles) ? options.coverLetterManifest.sourceFiles.map(String) : []),
      ].filter(Boolean),
      reuse: { matchType: 'job-aware-cover-letter-opening', confidence: 1 },
    };
  }

  if (description.length < MIN_JOB_DESCRIPTION_LENGTH) return null;

  const jobText = `${company} ${title} ${description}`;
  const jobSignals = SIGNALS.filter((signal) => signal.job.test(jobText));
  if (!jobSignals.length) return null;

  const ledger = options.ledger || loadProjectAccomplishmentLedger();
  const ranked = evidenceCandidates(profile, ledger)
    .map((candidate) => {
      const sharedSignals = jobSignals.filter((signal) => signal.evidence.test(candidate.answer));
      const keywordMatches = candidate.keywords.filter((keyword) => keywordMatchesJob(keyword, jobText));
      const score = (sharedSignals.length * 8)
        + (keywordMatches.length * 3)
        + Number(candidate.evidenceStrength || 0)
        + (Number(candidate.priority || 0) / 10);
      return { candidate, sharedSignals, keywordMatches, score };
    })
    .filter((candidate) => candidate.sharedSignals.length > 0)
    .sort((left, right) => right.score - left.score
      || right.sharedSignals.length - left.sharedSignals.length
      || right.candidate.evidenceStrength - left.candidate.evidenceStrength
      || left.candidate.name.localeCompare(right.candidate.name));
  const best = ranked[0];
  if (!best) return null;

  const focus = [...new Set(best.sharedSignals || [])]
    .slice(0, 3)
    .map((signal) => signal.label);
  const mission = missionPhrase(description);
  const missionSentence = mission
    ? ` I also connect with the company's stated mission: ${mission}.`
    : '';
  const evidenceSentence = compactText(best.candidate.answer, 430);
  const focusSentence = focus.length
    ? `the ${title} role's focus on ${joinList(focus)} aligns with the work I have already chosen to do.`
    : `the ${title} role aligns with the kind of evidence-driven engineering work I have already chosen to do.`;
  const answer = `I am interested in ${company} because ${focusSentence}${missionSentence} ${evidenceSentence}`;
  return {
    answer: normalize(answer),
    source: 'job-aware-motivation',
    kind: 'draft',
    evidenceBacked: true,
    answerStatus: 'job-aware-draft',
    answerScope: 'posting',
    evidenceRefs: [
      String(item.applyUrl || item.canonicalUrl || 'job description'),
      ...best.candidate.sourceRefs,
    ].filter(Boolean),
    reuse: {
      matchType: 'job-description-corpus-intersection',
      confidence: Math.min(1, best.score / 30),
      signals: focus,
    },
  };
}

/** @param {Record<string, unknown>} item @param {{ coverLetterText?: string }} options */
function readCoverLetterText(item, options) {
  const candidate = options.coverLetterText || item.coverLetterText || '';
  if (!candidate) return '';
  if (typeof candidate === 'string' && existsSync(candidate)) {
    try { return readFileSync(candidate, 'utf8'); } catch { return ''; }
  }
  return String(candidate);
}

/** @param {string} value @param {string} company @param {string} title */
function extractCoverLetterOpening(value, company, title) {
  const paragraphs = String(value || '')
    .split(/\n\s*\n/)
    .map((paragraph) => normalize(paragraph))
    .filter(Boolean);
  const opening = paragraphs.find((paragraph) => /^(?:what caught my attention|i(?:'|’)m interested|i am interested|i(?:'|’)m drawn)/i.test(paragraph));
  if (!opening) return '';
  if (company && !opening.toLowerCase().includes(company.toLowerCase())) return '';
  if (title && !opening.toLowerCase().includes(title.toLowerCase())) return '';
  return compactText(opening, 620);
}

/** @param {string[]} values */
function joinList(values) {
  if (values.length <= 1) return values[0] || 'this work';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}
