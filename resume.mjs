#!/usr/bin/env node

import { readQueueState, renderQueueMarkdown, writeQueueState } from './queue-lib.mjs';
import {
  buildResumeRequest,
  registerResumeArtifact,
  resolveResumeArtifact,
} from './resume-contract.mjs';
import { inspectArtifactCache } from './apply/application-artifacts.mjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(ROOT, 'data', 'job-queue.json');
const QUEUE_MARKDOWN = join(ROOT, 'data', 'job-queue.md');

/** @param {string[]} args @param {string} flag @param {string} fallback */
function readFlag(args, flag, fallback = '') {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

/** @param {Record<string, unknown>} item */
function queueItemSummary(item) {
  const request = buildResumeRequest(item, ROOT);
  const resolution = resolveResumeArtifact(item, ROOT);
  const artifacts = inspectArtifactCache(item);
  return {
    id: item.id,
    company: item.company,
    title: item.title,
    lane: request.lane,
    paperFormat: request.paperFormat,
    selectedProjects: request.selectedProjects,
    evidenceSources: request.evidenceSources.map((source) => source.path),
    artifactPath: resolution.artifactPath || request.artifactPath,
    manifestPath: resolution.manifestPath || request.manifestPath,
    status: resolution.status,
    ready: resolution.ok,
    artifactStatus: artifacts.status,
    artifactManifest: artifacts.manifestPath,
    reason: resolution.reason || null,
  };
}

function plan() {
  const args = process.argv.slice(3);
  const limit = Math.max(1, Math.min(20, Number(readFlag(args, '--limit', '6')) || 6));
  const state = readQueueState(QUEUE_FILE);
  const selected = (state.items || [])
    .filter((item) => item.selectedForToday)
    .sort((a, b) => Number(a.queueRank || 999) - Number(b.queueRank || 999))
    .slice(0, limit)
    .map(queueItemSummary);
  console.log(JSON.stringify({ contractVersion: 1, count: selected.length, items: selected }, null, 2));
}

function register() {
  const args = process.argv.slice(3);
  const itemId = readFlag(args, '--item-id');
  const artifactPath = readFlag(args, '--artifact');
  if (!itemId || !artifactPath) {
    throw new Error('Usage: node resume.mjs register --item-id <queue-id> --artifact <pdf|doc|docx> [--html <html>] [--source-mode tailored|canonical-base] [--audit-status passed]');
  }
  const state = readQueueState(QUEUE_FILE);
  const item = state.items.find((candidate) => String(candidate.id) === itemId);
  if (!item) throw new Error(`queue item not found: ${itemId}`);

  const result = registerResumeArtifact(item, ROOT, {
    artifactPath,
    htmlPath: readFlag(args, '--html') || undefined,
    sourceMode: readFlag(args, '--source-mode', 'tailored'),
    auditStatus: readFlag(args, '--audit-status', 'not-run'),
  });
  item.resumeContractVersion = result.request.contractVersion;
  item.resumeJobKey = result.request.jobKey;
  item.resumeManifest = result.manifestPath;
  item.resumeArtifact = result.artifactPath;
  item.resumeFormat = result.request.paperFormat;
  item.resumeProjects = result.request.selectedProjects;
  item.resumeStatus = `${result.manifest.sourceMode}; audit ${result.manifest.auditStatus}`;
  item.updatedAt = new Date().toISOString();
  writeQueueState(QUEUE_FILE, state);
  writeFileSync(QUEUE_MARKDOWN, renderQueueMarkdown(state), 'utf8');
  console.log(JSON.stringify({ ok: true, request: result.request, manifest: result.manifest }, null, 2));
}

const command = process.argv[2] || 'plan';
try {
  if (command === 'plan') plan();
  else if (command === 'register') register();
  else throw new Error('Usage: node resume.mjs plan|register');
} catch (error) {
  console.error(`resume: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
