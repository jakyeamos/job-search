#!/usr/bin/env node
// @ts-check

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  auditCoachResponse,
  buildJackCoachPrompt,
  JACK_SOURCE,
  JACK_SOURCE_LABEL,
  normalizeJackJob,
  normalizeJackJobs,
  normalizeJackJobUrl,
  normalizeText,
  readOptionalSource,
  unpackJackRecords,
} from './jackandjill-lib.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_FILE = path.join(ROOT, 'data', 'jackandjill-recommendations.json');
const DEFAULT_TIMEOUT_SECONDS = 180;

/** @param {string[]} args */
function parseArgs(args) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith('--') && !['true', 'false'].includes(next.toLowerCase())) {
      flags.set(name, next);
      index += 1;
    } else if (next && ['true', 'false'].includes(next.toLowerCase())) {
      flags.set(name, next.toLowerCase());
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positionals };
}

/** @param {Map<string, string|boolean>} flags @param {string} name @param {string} fallback */
function flagValue(flags, name, fallback = '') {
  const value = flags.get(name);
  return value === undefined || value === true ? fallback : String(value);
}

/** @param {Map<string, string|boolean>} flags @param {string} name @param {boolean} fallback */
function booleanFlag(flags, name, fallback = false) {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  if (value === true) return true;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** @param {Map<string, string|boolean>} flags */
function timeoutSeconds(flags) {
  const value = Number(flagValue(flags, 'timeout', String(DEFAULT_TIMEOUT_SECONDS)));
  return Number.isFinite(value) && value > 0 ? Math.min(900, Math.floor(value)) : DEFAULT_TIMEOUT_SECONDS;
}

/** @param {string} value */
function redactError(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

/** @param {string} text */
function parseJsonOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* OpenCLI may prefix a warning. */ }
  const candidates = trimmed.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next line */ }
  }
  throw new Error('OpenCLI did not return JSON; inspect the bridge/adapter output before retrying');
}

/** @param {unknown} value */
function responseText(value) {
  for (const row of unpackJackRecords(value)) {
    if (!row || typeof row !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    for (const key of ['response', 'answer', 'text', 'content']) {
      if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
    }
  }
  if (typeof value === 'string') return value.trim();
  return '';
}

/**
 * Invoke the private browser adapter with an argv array. No shell expansion,
 * cookies, tokens, or browser profile data are handled by this wrapper.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeout
 */
async function runOpenCli(command, args, timeout) {
  const executable = process.env.OPENCLI_BIN || 'opencli';
  try {
    const result = await execFileAsync(executable, ['jackandjill', command, ...args, '-f', 'json'], {
      cwd: ROOT,
      timeout: timeout * 1_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseJsonOutput(result.stdout);
  } catch (error) {
    const typed = /** @type {Error & {stdout?: string, stderr?: string}} */ (error);
    const detail = redactError(typed.stderr || typed.stdout || typed.message || String(error));
    throw new Error(`opencli jackandjill ${command} failed: ${detail}`, { cause: error });
  }
}

/** @param {string} value */
function requireJackUrl(value) {
  const canonical = normalizeJackJobUrl(value);
  if (!canonical) throw new Error(`expected a Jack & Jill job URL containing a stable UUID: ${value}`);
  return canonical;
}

/** @param {unknown} value @param {string} sourceUrl */
function normalizeDetail(value, sourceUrl) {
  const job = normalizeJackJob(unpackJackRecords(value)[0], { sourceUrl });
  if (!job) throw new Error(`Jack & Jill returned no canonical job record for ${sourceUrl}`);
  return job;
}

/** @param {string} url @param {number} timeout */
async function fetchJob(url, timeout) {
  const canonical = requireJackUrl(url);
  const raw = await runOpenCli('job', ['--url', canonical], timeout);
  return normalizeDetail(raw, url);
}

/** @param {string} file */
function readJobFile(file) {
  if (!existsSync(file)) throw new Error(`job file does not exist: ${file}`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`job file is not valid JSON: ${file}`, { cause: error }); }
  const job = normalizeDetail(parsed, String(parsed?.sourceUrl || parsed?.url || ''));
  return job;
}

/** @param {string} file @param {Record<string, unknown>[]} jobs @param {string} observedAt */
function writeCache(file, jobs, observedAt) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    source: JACK_SOURCE,
    sourceLabel: JACK_SOURCE_LABEL,
    observedAt,
    jobs,
  }, null, 2)}\n`, 'utf8');
}

/** @param {Record<string, unknown>[]} jobs @param {boolean} write */
async function mergePipeline(jobs, write) {
  const pipelineFile = path.join(ROOT, 'data', 'pipeline.md');
  const existing = new Set();
  for (const line of readOptionalSource(pipelineFile).split('\n')) {
    const match = line.match(/https?:\/\/\S+/);
    const canonical = match ? normalizeJackJobUrl(match[0]) : '';
    if (canonical) existing.add(canonical);
  }
  const additions = jobs.filter((job) => !existing.has(job.canonicalUrl));
  if (!write || !additions.length) return { added: additions.length, skipped: jobs.length - additions.length };
  const { appendToPipeline, appendToScanHistory } = await import('./scan.mjs');
  appendToPipeline(additions);
  appendToScanHistory(additions, new Date().toISOString().slice(0, 10));
  return { added: additions.length, skipped: jobs.length - additions.length };
}

/** @param {Map<string, string|boolean>} flags */
async function listJobs(flags) {
  const timeout = timeoutSeconds(flags);
  const limit = Math.max(1, Math.min(100, Number(flagValue(flags, 'limit', '20')) || 20));
  const raw = await runOpenCli('jobs', ['--limit', String(limit)], timeout);
  const summaries = normalizeJackJobs(raw);
  const warnings = [];
  const detailed = booleanFlag(flags, 'details', false);
  const jobs = [];
  for (const summary of summaries) {
    if (!detailed) {
      jobs.push(summary);
      continue;
    }
    try {
      const detail = await fetchJob(String(summary.url), timeout);
      jobs.push(normalizeJackJob({ ...summary, ...detail }, {
        sourceUrl: String(summary.sourceUrl || summary.url),
        sourceMessageId: typeof summary.sourceMessageId === 'string' ? summary.sourceMessageId : undefined,
      }) || summary);
    } catch (error) {
      warnings.push(redactError(error instanceof Error ? error.message : String(error)));
      jobs.push(summary);
    }
  }
  const observedAt = new Date().toISOString();
  for (const job of jobs) {
    if (!job.observedAt) job.observedAt = observedAt;
    if (!job.discoveredAt) job.discoveredAt = observedAt;
  }
  const cacheFile = flagValue(flags, 'cache-file', DEFAULT_CACHE_FILE);
  const write = booleanFlag(flags, 'write-cache', false) || booleanFlag(flags, 'write', false);
  if (write) writeCache(cacheFile, jobs, observedAt);
  return { source: JACK_SOURCE, sourceLabel: JACK_SOURCE_LABEL, command: 'jobs', observedAt, cacheFile: write ? cacheFile : null, records: jobs, warnings };
}

/** @param {Map<string, string|boolean>} flags */
async function getJob(flags) {
  const input = flagValue(flags, 'url', '');
  if (!input) throw new Error('Usage: node jackandjill.mjs job --url <jack-job-url>');
  const observedAt = new Date().toISOString();
  const job = await fetchJob(input, timeoutSeconds(flags));
  job.observedAt = observedAt;
  return { source: JACK_SOURCE, sourceLabel: JACK_SOURCE_LABEL, command: 'job', observedAt, record: job, warnings: job.warnings || [] };
}

/** @param {Map<string, string|boolean>} flags */
async function coach(flags) {
  const jobUrl = flagValue(flags, 'job-url', '');
  const jobFile = flagValue(flags, 'job-file', '');
  if (!jobUrl && !jobFile) throw new Error('Usage: node jackandjill.mjs coach --job-url <jack-job-url>');
  const job = jobFile ? readJobFile(jobFile) : await fetchJob(jobUrl, timeoutSeconds(flags));
  const cv = readOptionalSource(path.join(ROOT, 'cv.md'));
  const digest = readOptionalSource(path.join(ROOT, 'article-digest.md'));
  const profile = readOptionalSource(path.join(ROOT, 'config', 'profile.yml'));
  if (!cv.trim()) throw new Error('canonical cv.md is missing or empty');
  const prompt = flagValue(flags, 'prompt', '') || buildJackCoachPrompt({
    cv,
    digest,
    profile,
    job,
    includeCoverLetter: !booleanFlag(flags, 'no-cover-letter', false),
  });
  const raw = await runOpenCli('coach', [prompt, '--timeout', String(timeoutSeconds(flags))], timeoutSeconds(flags));
  const response = responseText(raw);
  if (!response) throw new Error('Jack & Jill returned an empty coaching response');
  const audit = auditCoachResponse(response, [cv, digest, profile, JSON.stringify(job)]);
  const warnings = [...(Array.isArray(job.warnings) ? job.warnings : []), ...audit.warnings];
  const payload = {
    source: JACK_SOURCE,
    sourceLabel: JACK_SOURCE_LABEL,
    command: 'coach',
    observedAt: new Date().toISOString(),
    sourceUrl: job.sourceUrl || job.url,
    job,
    prompt,
    response,
    warnings,
    evidenceAudit: audit,
    reviewRequired: warnings.length > 0,
  };
  if (booleanFlag(flags, 'strict-evidence', false) && !audit.accepted) {
    process.exitCode = 3;
  }
  return payload;
}

/** @param {Map<string, string|boolean>} flags */
async function sync(flags) {
  const result = await listJobs(new Map([
    ...flags.entries(),
    ['details', true],
  ]));
  const write = booleanFlag(flags, 'write-cache', false) || booleanFlag(flags, 'write', false);
  const pipeline = booleanFlag(flags, 'pipeline', false);
  if (pipeline && !write) throw new Error('sync --pipeline requires explicit --write');
  const pipelineResult = await mergePipeline(result.records, pipeline);
  return { ...result, command: 'sync', pipeline: pipelineResult, writeRequested: write };
}

/** @param {string[]} args */
async function main(args) {
  const command = args[0] || 'jobs';
  const { flags, positionals } = parseArgs(args.slice(1));
  if (command === 'coach') {
    if (positionals.length && !flags.has('prompt')) flags.set('prompt', positionals.join(' '));
    return coach(flags);
  }
  if (command === 'jobs') return listJobs(flags);
  if (command === 'job') return getJob(flags);
  if (command === 'sync') return sync(flags);
  throw new Error(`Unknown Jack & Jill command: ${command}. Use coach, jobs, job, or sync.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      source: JACK_SOURCE,
      ok: false,
      observedAt: new Date().toISOString(),
      error: redactError(error instanceof Error ? error.message : String(error)),
    }, null, 2));
    process.exitCode = process.exitCode || 1;
  }
}
