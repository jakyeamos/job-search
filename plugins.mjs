#!/usr/bin/env node
// @ts-check

import {
  discoverPlugins,
  loadDotenvOnce,
  loadPluginConfig,
  loadSkill,
  pluginRoots,
  pluginStatus,
  resolveSuccessorIds,
  runHook,
} from './plugins/_engine.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GMAIL_INGEST_TIMEOUT_MS = 120_000;

/** @param {string} value */
function cleanUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

/** @param {unknown} value */
function normalizeJobs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const jobs = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const job = /** @type {Record<string, unknown>} */ (raw);
    const url = cleanUrl(String(job.url || job.canonicalUrl || ''));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    jobs.push({
      ...job,
      url,
      canonicalUrl: job.canonicalUrl || url,
      source: job.source || 'plugin-ingest',
      sourceLabel: job.sourceLabel || job.source || 'plugin-ingest',
    });
  }
  return jobs;
}

async function listPlugins() {
  await loadDotenvOnce();
  const config = await loadPluginConfig(ROOT);
  const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
  if (!manifests.length) {
    console.log('No plugins discovered.');
    return;
  }
  for (const manifest of manifests) {
    const status = pluginStatus(manifest, config);
    const hooks = manifest.hooks.join(', ');
    const state = status.enabled ? 'enabled' : status.configured ? `blocked: missing ${status.missingEnv.join(', ')}` : 'off';
    console.log(`${manifest.id}\t${state}\thooks=${hooks}\tsource=${manifest.dir.includes('/plugins.local/') ? 'local' : 'bundled'}`);
  }
}

/** @param {string} id @param {object} config */
function assertConfigured(id, config) {
  const entry = config?.plugins?.[id];
  if (!entry || entry.enabled !== true) {
    throw new Error(`plugin "${id}" is not enabled in config/plugins.yml`);
  }
}

async function runIngest(id, dryRun, noPipeline) {
  await loadDotenvOnce();
  const config = await loadPluginConfig(ROOT);
  assertConfigured(id, config);
  const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
  const manifest = manifests.find((candidate) => candidate.id === id && candidate.hooks.includes('ingest'));
  if (!manifest) throw new Error(`plugin "${id}" does not expose an ingest hook`);
  const status = pluginStatus(manifest, config);
  if (!status.enabled) throw new Error(`plugin "${id}" cannot run: missing ${status.missingEnv.join(', ')}`);

  const results = await runHook('ingest', null, {
    root: ROOT,
    dryRun,
    timeoutMs: id === 'gmail' ? GMAIL_INGEST_TIMEOUT_MS : undefined,
    onlyIds: [id],
  });
  const selected = results.find((result) => result.id === id);
  if (!selected) throw new Error(`plugin "${id}" was skipped by the plugin engine`);
  if (!selected.ok) throw new Error(selected.error || `plugin "${id}" failed`);
  const jobs = normalizeJobs(selected.result);
  if (!dryRun && !noPipeline && jobs.length) {
    const { appendToPipeline, appendToScanHistory } = await import('./scan.mjs');
    appendToPipeline(jobs);
    appendToScanHistory(jobs, new Date().toISOString().slice(0, 10));
  }
  console.log(`${id}: ${jobs.length} lead(s)${dryRun ? ' would be added' : noPipeline ? ' returned' : ' added to data/pipeline.md'}.`);
  for (const job of jobs.slice(0, 20)) console.log(`  + ${job.company || 'Unknown company'} | ${job.title || 'Job lead'} | ${job.url}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  if (command === 'list') {
    await listPlugins();
    return;
  }
  if (command === 'skill') {
    const id = args[1];
    if (!id) throw new Error('Usage: node plugins.mjs skill <id>');
    const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
    const manifest = manifests.find((candidate) => candidate.id === id);
    if (!manifest) throw new Error(`unknown plugin "${id}"`);
    const skill = loadSkill(manifest, ROOT);
    if (!skill) throw new Error(`plugin "${id}" has no skill.md`);
    console.log(skill.body);
    return;
  }
  if (command === 'run') {
    const id = args[1];
    if (!id) throw new Error('Usage: node plugins.mjs run <id> [--dry-run] [--no-pipeline]');
    await runIngest(id, args.includes('--dry-run'), args.includes('--no-pipeline'));
    return;
  }
  throw new Error(`Unknown plugin command "${command}". Use list, run, or skill.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await main();
  } catch (error) {
    console.error(`plugins: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
