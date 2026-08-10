#!/usr/bin/env node
// @ts-check
/**
 * pipeline-fast-pass.mjs — prepare one cheap, evidence-bearing pipeline chunk.
 *
 * This is deliberately a preprocessor, not an application agent. It reads the
 * next unchecked pipeline rows, fetches public ATS descriptions in grouped
 * board requests, applies the repository's deterministic blocker rules, and
 * writes one manifest for a Codex discovery worker. It never edits pipeline.md,
 * applications.md, reports, or tracker additions.
 *
 * Usage:
 *   node pipeline-fast-pass.mjs
 *   node pipeline-fast-pass.mjs --limit 30 --concurrency 6
 *   node pipeline-fast-pass.mjs --output batch/fast-pass/trial.json
 *   node pipeline-fast-pass.mjs --stdout
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProfile, normalizeText, normalizeUrl, scoreCandidate } from './queue-lib.mjs';
import { fetchPostings } from './posting-fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT = path.join(ROOT, 'batch', 'fast-pass', 'latest.json');
const HIGH_CONFIDENCE_DEFENSE_RE = /\b(defense|defence|military|clearance|classified|national security|government|dod|intelligence|armed forces|army|navy|air force|space force)\b/i;

/**
 * `scoreCandidate()` is intentionally broad because its normal output goes to a
 * review queue. Auto-disposition needs a stricter bar: generic benefits/legal
 * prose can mention "government" without making a role defense work. Only
 * blockers with self-contained evidence, or defense terms visible in the
 * title/company metadata, may bypass model review.
 *
 * @param {Record<string, any>} candidate
 * @param {ReturnType<typeof scoreCandidate>} evaluation
 */
export function safeAutoSkipBlockers(candidate, evaluation) {
  const titleAndCompany = `${candidate.title || ''} ${candidate.company || ''}`;
  return (evaluation.blockers || []).filter((blocker) => {
    if (/^seniority title suggests/i.test(blocker)) return true;
    if (/^posting states a \d+\+? year experience floor/i.test(blocker)) return true;
    if (/^defense-contractor employer/i.test(blocker)) return true;
    if (/^gambling, betting, casino/i.test(blocker)) return true;
    if (/^location appears outside/i.test(blocker)) return true;
    if (/^posting requires .+-language fluency/i.test(blocker)) return true;
    if (/^title targets a /i.test(blocker)) return true;
    if (/^graduate\/rotational program/i.test(blocker)) return true;
    if (/^defense, intelligence, clearance/i.test(blocker)) {
      return HIGH_CONFIDENCE_DEFENSE_RE.test(titleAndCompany);
    }
    return false;
  });
}

/**
 * @param {string} text
 * @returns {Array<{
 *   lineNumber: number,
 *   rawLine: string,
 *   url: string,
 *   canonicalUrl: string,
 *   company: string,
 *   title: string,
 *   location: string,
 *   compensation: string,
 * }>}
 */
export function parsePendingPipeline(text) {
  const pending = [];
  for (const [index, rawLine] of String(text || '').split('\n').entries()) {
    const match = rawLine.match(/^- \[ \]\s+(https?:\/\/\S+)(?:\s+\|\s*(.*))?$/i);
    if (!match) continue;
    const url = normalizeUrl(match[1]);
    if (!url) continue;
    const cells = (match[2] || '').split(/\s+\|\s+/).map(normalizeText);
    const rawLocation = cells[2] || '';
    pending.push({
      lineNumber: index + 1,
      rawLine,
      url,
      canonicalUrl: url,
      company: cells[0] || '',
      title: cells[1] || 'Job lead',
      location: /^\d+(?:\.\d+)?\/5$/.test(rawLocation) ? '' : rawLocation,
      compensation: cells[3] || '',
    });
  }
  return pending;
}

/**
 * @param {ReturnType<typeof parsePendingPipeline>} jobs
 * @param {Awaited<ReturnType<typeof fetchPostings>>} results
 * @param {Record<string, any>} profile
 * @param {{ generatedAt?: string, elapsedMs?: number }} [metadata]
 */
export function buildFastPassManifest(jobs, results, profile, metadata = {}) {
  const generatedAt = metadata.generatedAt || new Date().toISOString();
  const items = jobs.map((job, index) => {
    const fetched = results[index];
    const fetchedFields = fetched?.ok ? fetched.fields : {};
    const candidate = {
      ...job,
      title: fetchedFields.title || job.title,
      company: fetchedFields.company || job.company,
      location: fetchedFields.location || job.location,
      description: fetchedFields.description || '',
      liveness: fetched?.ok ? fetched.liveness : fetched?.outcome === 'expired' ? 'expired' : 'uncertain',
    };
    const evaluation = fetched?.ok ? scoreCandidate(candidate, profile) : null;
    const autoSkipBlockers = evaluation ? safeAutoSkipBlockers(candidate, evaluation) : [];

    let route = 'model_fallback';
    if (fetched?.outcome === 'expired') route = 'expired';
    else if (fetched?.ok && autoSkipBlockers.length > 0) route = 'deterministic_skip';
    else if (fetched?.ok) route = 'model_triage';

    return {
      queueIndex: index + 1,
      lineNumber: job.lineNumber,
      rawLine: job.rawLine,
      url: job.url,
      company: candidate.company,
      title: candidate.title,
      location: candidate.location,
      compensation: job.compensation,
      description: candidate.description,
      liveness: candidate.liveness,
      verification: fetched?.ok
        ? 'unconfirmed (public ATS/API; browser verification required before application)'
        : 'unconfirmed (fast fetch unavailable; Codex-native fallback required)',
      fetch: fetched?.ok
        ? { ok: true, outcome: 'active' }
        : { ok: false, outcome: fetched?.outcome || 'error', reason: fetched?.reason || 'unknown fetch failure' },
      deterministic: evaluation
        ? {
            ...evaluation,
            autoSkipBlockers,
            requiresModelReview: evaluation.status === 'excluded' && autoSkipBlockers.length === 0,
          }
        : null,
      route,
    };
  });

  const routes = items.reduce((counts, item) => {
    counts[item.route] = (counts[item.route] || 0) + 1;
    return counts;
  }, {});

  return {
    schemaVersion: 1,
    generatedAt,
    source: 'data/pipeline.md',
    requested: jobs.length,
    elapsedMs: metadata.elapsedMs || 0,
    routes,
    instructions: {
      discoveryOnly: true,
      submitApplications: false,
      generateResumeArtifacts: false,
      fullEvaluation: false,
      reportMode: 'compact-decision-card',
      browserVerificationRequiredBeforeApplication: true,
    },
    items,
  };
}

/**
 * @param {{
 *   root?: string,
 *   limit?: number,
 *   concurrency?: number,
 *   gapMs?: number,
 *   fetchFn?: (url: string, init?: any) => Promise<any>,
 *   pipelineText?: string,
 * }} [options]
 */
export async function prepareFastPass(options = {}) {
  const root = options.root || ROOT;
  const pipelineText = options.pipelineText
    ?? readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8');
  const limit = Math.max(1, Number(options.limit || 30));
  const jobs = parsePendingPipeline(pipelineText).slice(0, limit);
  const startedAt = Date.now();
  const results = await fetchPostings(jobs.map((job) => job.url), {
    concurrency: Math.max(1, Number(options.concurrency || 6)),
    gapMs: Math.max(0, Number(options.gapMs || 0)),
    fetchFn: options.fetchFn,
  });
  return buildFastPassManifest(jobs, results, loadProfile(root), {
    elapsedMs: Date.now() - startedAt,
  });
}

function parseArgs(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  return {
    limit: Number(value('--limit', 30)),
    concurrency: Number(value('--concurrency', 6)),
    gapMs: Number(value('--gap-ms', 0)),
    output: String(value('--output', DEFAULT_OUTPUT)),
    stdout: argv.includes('--stdout'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await prepareFastPass(options);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.stdout) {
    process.stdout.write(json);
    return;
  }
  const output = path.resolve(options.output);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, json, 'utf8');
  console.log(JSON.stringify({
    output: path.relative(ROOT, output),
    requested: manifest.requested,
    routes: manifest.routes,
    elapsedMs: manifest.elapsedMs,
  }));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`pipeline-fast-pass: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
