#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAISafetyQuestion } from './apply/question-ledger.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_ACCOMPLISHMENT_LEDGER_PATH = path.join(ROOT, 'config', 'project-accomplishment-ledger.json');

const ACCOMPLISHMENT_QUESTION_RE = /(?:most impressive|proud of|personally built|built or automated|technical accomplishment|project.*proud|accomplishment.*(?:ai|system|project)|most impactful[\s\S]{0,80}\b(?:work|project|contribution|accomplishment|system|thing)\b|impactful[\s\S]{0,60}\b(?:work|project|contribution|accomplishment|system|thing)\b)/i;

const LANE_PATTERNS = [
  ['data_analytics', /data|analytics|sql|warehouse|pipeline|experiment|statistics|modeling|insights/i],
  ['solutions_forward_deployed', /solutions|forward[- ]deployed|implementation|consult|client|customer|deployment|technical account/i],
  ['product_full_stack', /frontend|front[- ]end|full[- ]stack|product engineer|web app|mobile|user experience/i],
  ['developer_tools_infrastructure', /developer tools|developer experience|platform|infrastructure|devops|quality|cli|lsp|mcp|runtime|observability|reliability/i],
  ['applied_ai_client_delivery', /applied ai|generative ai|genai|llm|agent|rag|machine learning|computer vision|ai engineer/i],
];

/** @param {string} value */
function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {string} value */
function normalizedKey(value) {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @param {string} file */
export function loadProjectAccomplishmentLedger(file = DEFAULT_PROJECT_ACCOMPLISHMENT_LEDGER_PATH) {
  if (!existsSync(file)) return { schemaVersion: 1, entries: [], path: file, loadError: 'project accomplishment ledger is missing' };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      schemaVersion: 1,
      entries: Array.isArray(parsed?.entries) ? parsed.entries.filter((entry) => entry && typeof entry === 'object') : [],
      path: file,
    };
  } catch {
    return { schemaVersion: 1, entries: [], path: file, loadError: 'project accomplishment ledger is not valid JSON' };
  }
}

/** @param {string} question */
export function isProjectAccomplishmentQuestion(question) {
  return ACCOMPLISHMENT_QUESTION_RE.test(normalize(question));
}

/** @param {Record<string, unknown>} context */
export function inferProjectAccomplishmentLane(context = {}) {
  const explicit = normalizedKey(String(context.lane || ''));
  if (explicit) return explicit.replace(/ /g, '_');
  const signal = `${context.title || ''} ${context.company || ''} ${context.description || ''}`;
  return LANE_PATTERNS.find(([, pattern]) => pattern.test(signal))?.[0] || 'backend_ai_platform';
}

/** @param {Record<string, unknown>} entry @param {string} lane @param {string} signal */
function scoreEntry(entry, lane, signal) {
  if (entry.approved === false || !normalize(String(entry.answer || ''))) return Number.NEGATIVE_INFINITY;
  const laneWeights = entry.laneWeights && typeof entry.laneWeights === 'object' ? entry.laneWeights : {};
  const laneScore = Number(laneWeights[lane] || (Array.isArray(entry.lanes) && entry.lanes.includes(lane) ? 8 : 0));
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.map(String) : [];
  const keywordScore = keywords.filter((keyword) => signal.includes(normalizedKey(keyword))).length * 3;
  const priority = Number(entry.priority || 0);
  const evidenceStrength = Number(entry.evidenceStrength || 0);
  const fallback = entry.fallback === true ? 2 : 0;
  return laneScore + keywordScore + priority + evidenceStrength + fallback;
}

/** @param {Record<string, unknown>} context @param {{ entries: Array<Record<string, unknown>> }} [ledger] */
export function selectProjectAccomplishment(context = {}, ledger = loadProjectAccomplishmentLedger()) {
  const question = String(context.question || 'What accomplishment are you most proud of?');
  if (!isProjectAccomplishmentQuestion(question)) return null;
  // AI-safety prompts need the dedicated evidence-backed profile answer when
  // one exists; do not silently substitute an unrelated generic project.
  if (isAISafetyQuestion(question)) return null;
  const lane = inferProjectAccomplishmentLane(context);
  const signal = normalizedKey(`${context.company || ''} ${context.title || ''} ${context.description || ''}`);
  const ranked = (ledger.entries || [])
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, lane, signal),
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score
      || Number(right.entry.evidenceStrength || 0) - Number(left.entry.evidenceStrength || 0)
      || Number(right.entry.priority || 0) - Number(left.entry.priority || 0)
      || String(left.entry.id || '').localeCompare(String(right.entry.id || '')));
  if (!ranked.length) return null;
  return {
    ...ranked[0].entry,
    lane,
    score: ranked[0].score,
  };
}

/** @param {Record<string, unknown>} context @param {{ entries: Array<Record<string, unknown>> }} [ledger] */
export function projectAccomplishmentAnswerTable(context = {}, ledger = loadProjectAccomplishmentLedger()) {
  const entry = selectProjectAccomplishment({ ...context, question: context.question || 'What accomplishment are you most proud of?' }, ledger);
  if (!entry) return [];
  return [{
    re: ACCOMPLISHMENT_QUESTION_RE,
    value: String(entry.answer),
    source: `project-accomplishment:${entry.id}`,
  }];
}
