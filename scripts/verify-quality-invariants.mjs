#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST_PATH = path.join(ROOT, 'quality-invariants.json');

function fail(message, details = {}) {
  process.stderr.write(`${JSON.stringify({
    schema: 'career-ops-quality-invariant-verification/v1',
    status: 'failed',
    message,
    ...details,
  }, null, 2)}\n`);
  process.exit(1);
}

function repositoryFile(relativePath, invariantId) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    fail('invariant surface must be a non-empty repository-relative path', { invariantId, surface: relativePath });
  }
  const resolved = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('invariant surface escapes the repository root', { invariantId, surface: relativePath });
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    fail('invariant surface does not exist as a file', { invariantId, surface: relativePath });
  }
  return relativePath;
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (error) {
  fail('quality invariant manifest is missing or invalid JSON', {
    manifest: path.relative(ROOT, MANIFEST_PATH),
    error: error instanceof Error ? error.message : String(error),
  });
}

if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.invariants) || manifest.invariants.length === 0) {
  fail('quality invariant manifest must use schemaVersion 1 and declare at least one invariant');
}

const seenIds = new Set();
const results = [];

for (const invariant of manifest.invariants) {
  const id = invariant?.id;
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail('invariant id must be a stable lowercase kebab-case string', { invariantId: id });
  }
  if (seenIds.has(id)) fail('invariant ids must be unique', { invariantId: id });
  seenIds.add(id);

  if (typeof invariant.description !== 'string' || !invariant.description.trim()) {
    fail('invariant must include a description', { invariantId: id });
  }
  if (typeof invariant.owner !== 'string' || !invariant.owner.trim()) {
    fail('invariant must include an owner', { invariantId: id });
  }
  if (!Array.isArray(invariant.surfaces) || invariant.surfaces.length === 0) {
    fail('invariant must declare at least one owned surface', { invariantId: id });
  }
  const surfaces = invariant.surfaces.map((surface) => repositoryFile(surface, id));

  const argv = invariant.verification?.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || !part)) {
    fail('invariant verification.argv must be a non-empty string array', { invariantId: id });
  }

  const startedAt = new Date().toISOString();
  const completed = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  const stdout = String(completed.stdout || '').trim();
  const stderr = String(completed.stderr || '').trim();
  if (completed.error || completed.status !== 0) {
    fail('invariant proof command failed', {
      invariantId: id,
      owner: invariant.owner,
      surfaces,
      command: argv,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: completed.status,
      error: completed.error?.message,
      stdout,
      stderr,
    });
  }
  results.push({
    id,
    owner: invariant.owner,
    status: 'passed',
    surfaces,
    command: argv,
    startedAt,
    completedAt: new Date().toISOString(),
  });
}

process.stdout.write(`${JSON.stringify({
  schema: 'career-ops-quality-invariant-verification/v1',
  status: 'passed',
  manifest: path.relative(ROOT, MANIFEST_PATH),
  invariantCount: results.length,
  results,
}, null, 2)}\n`);
