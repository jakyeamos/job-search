#!/usr/bin/env node

/**
 * Fail-closed upstream updater for career-ops.
 *
 * The updater compares three states for every upstream-changed path:
 *   recorded upstream baseline -> current local/index state -> incoming upstream
 *
 * Local deviations are never overwritten. Incoming versions for those paths are
 * staged under .update-incoming/ for review. Every affected path is snapshotted
 * under Git's common directory before any working-tree write.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForUpdate } from './update-check.mjs';
import { matchesPath, safeRelativePath, sameState, sha256 } from './update-primitives.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CANONICAL_REPO = process.env.CAREER_OPS_UPSTREAM_REPO || 'https://github.com/santifer/career-ops.git';
const UPSTREAM_BRANCH = process.env.CAREER_OPS_UPSTREAM_BRANCH || 'main';
const BASELINE_FILE = '.upstream-baseline.json';
const OVERRIDES_FILE = '.local-overrides.json';
const INCOMING_DIR = '.update-incoming';
const LOCK_FILE = '.update-lock';
const SNAPSHOT_SCHEMA = 'career-ops-update-snapshot/v1';

const USER_PATHS = [
  'cv.md',
  'config/profile.yml',
  'config/google-sheets.json',
  'config/application-profile.json',
  'modes/_profile.md',
  'modes/_brief.md',
  'portals.yml',
  'article-digest.md',
  'interview-prep/',
  'data/',
  'reports/',
  'output/',
  'jds/',
  'research/',
  'batch/tracker-additions/',
  '.mac-control/',
  '.project-compass/',
  '.pnpm-store/',
];

const CONTROLLER_PATHS = [
  BASELINE_FILE,
  OVERRIDES_FILE,
  `${INCOMING_DIR}/`,
  LOCK_FILE,
  '.update-dismissed',
];

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: options.encoding === 'buffer' ? 'buffer' : 'utf8',
    timeout: options.timeout || 60_000,
    maxBuffer: options.maxBuffer || 128 * 1024 * 1024,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function gitText(args) {
  return String(git(args)).trim();
}

function isProtectedNamespace(path) {
  return [...USER_PATHS, ...CONTROLLER_PATHS].some((rule) => matchesPath(path, rule));
}

function strictJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function loadBaseline() {
  const path = join(ROOT, BASELINE_FILE);
  const baseline = strictJson(path, BASELINE_FILE);
  if (baseline.schema_version !== 'career-ops-upstream-baseline/v1') {
    throw new Error(`${BASELINE_FILE} has an unsupported schema_version`);
  }
  if (!/^[0-9a-f]{40}$/i.test(baseline.commit || '')) {
    throw new Error(`${BASELINE_FILE} must record a full 40-character upstream commit`);
  }
  try {
    gitText(['cat-file', '-e', `${baseline.commit}^{commit}`]);
  } catch {
    throw new Error(`Recorded upstream baseline commit is unavailable locally: ${baseline.commit}`);
  }
  return baseline;
}

function loadOverrides() {
  const path = join(ROOT, OVERRIDES_FILE);
  if (!existsSync(path)) return [];
  const value = strictJson(path, OVERRIDES_FILE);
  if (!Array.isArray(value.paths)) throw new Error(`${OVERRIDES_FILE}.paths must be an array`);
  return value.paths.map((entry) => safeRelativePath(entry, 'override path'));
}

function changedTreePaths(baselineRef, incomingRef) {
  const output = gitText(['diff', '--name-only', '--no-renames', baselineRef, incomingRef, '--']);
  if (!output) return [];
  return output.split('\n').map((path) => safeRelativePath(path, 'changed tree path'));
}

function treeState(ref, path) {
  let row;
  try {
    row = gitText(['ls-tree', ref, '--', path]);
  } catch {
    return { kind: 'absent' };
  }
  if (!row) return { kind: 'absent' };
  const match = row.match(/^(\d{6})\s+blob\s+([0-9a-f]{40})\t/);
  if (!match) throw new Error(`Unsupported upstream tree entry for ${path}`);
  const content = git(['show', `${ref}:${path}`], { encoding: 'buffer' });
  return { kind: 'file', mode: match[1], hash: sha256(content), content };
}

function localPathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function localState(path) {
  const fullPath = join(ROOT, path);
  if (!localPathExists(fullPath)) return { kind: 'absent' };
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    const content = Buffer.from(readlinkSync(fullPath));
    return { kind: 'file', mode: '120000', hash: sha256(content), content };
  }
  if (stat.isDirectory()) return { kind: 'directory' };
  if (!stat.isFile()) throw new Error(`Unsupported local update path type: ${path}`);
  const content = readFileSync(fullPath);
  return { kind: 'file', mode: stat.mode & 0o111 ? '100755' : '100644', hash: sha256(content), content };
}

function writeWorkingTreeState(destination, state, content) {
  if (state.kind !== 'file') throw new Error(`Cannot write non-file state at ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  if (localPathExists(destination)) rmSync(destination, { force: true });
  if (state.mode === '120000') {
    symlinkSync(content.toString('utf8'), destination);
    return;
  }
  writeFileSync(destination, content);
  chmodSync(destination, state.mode === '100755' ? 0o755 : 0o644);
}

function indexState(path) {
  const row = gitText(['ls-files', '--stage', '--', path]);
  if (!row) return { kind: 'absent' };
  const match = row.split('\n')[0].match(/^(\d{6})\s+([0-9a-f]{40})\s+0\t/);
  if (!match) throw new Error(`Unmerged index entry blocks update: ${path}`);
  const content = git(['show', `:${path}`], { encoding: 'buffer' });
  return { kind: 'file', mode: match[1], hash: sha256(content) };
}

function overrideMatches(path, overrides) {
  return overrides.some((rule) => matchesPath(path, rule));
}

function hasGitChange(path) {
  return gitText(['status', '--porcelain=v1', '--untracked-files=all', '--', path]) !== '';
}

function buildPlan(baselineRef, incomingRef) {
  const overrides = loadOverrides();
  const paths = new Set(changedTreePaths(baselineRef, incomingRef));
  const changes = [];

  for (const path of [...paths].sort()) {
    if (isProtectedNamespace(path)) continue;
    const baseline = treeState(baselineRef, path);
    const incoming = treeState(incomingRef, path);
    if (sameState(baseline, incoming)) continue;

    const local = localState(path);
    const index = indexState(path);
    const explicit = overrideMatches(path, overrides);
    const locallyChanged = !sameState(local, baseline) || !sameState(index, baseline) || hasGitChange(path);
    const protectedEdit = explicit || locallyChanged;

    changes.push({
      path,
      action: protectedEdit ? 'stage_for_review' : incoming.kind === 'absent' ? 'delete' : 'update',
      reason: explicit ? 'explicit_override' : locallyChanged ? 'local_deviation' : 'upstream_only',
      baseline,
      incoming,
      local,
      index,
    });
  }

  const changesByPath = new Map(changes.map((item) => [item.path, item]));
  for (const item of changes) {
    if (item.action !== 'update' || item.incoming.mode !== '120000') continue;
    let targetPath;
    try {
      targetPath = safeRelativePath(
        join(dirname(item.path), item.incoming.content.toString('utf8')),
        `symlink target for ${item.path}`,
      );
    } catch {
      item.action = 'stage_for_review';
      item.reason = 'protected_dependency';
      continue;
    }
    const targetChange = changesByPath.get(targetPath);
    const targetUnavailable = targetChange
      ? targetChange.action === 'stage_for_review' || targetChange.incoming.kind === 'absent'
      : localState(targetPath).kind === 'absent';
    if (targetUnavailable) {
      item.action = 'stage_for_review';
      item.reason = 'protected_dependency';
    }
  }

  return {
    baseline: baselineRef,
    incoming: incomingRef,
    changes,
    protected: changes.filter((item) => item.action === 'stage_for_review'),
    applicable: changes.filter((item) => item.action !== 'stage_for_review'),
  };
}

function snapshotRoot() {
  const common = gitText(['rev-parse', '--git-common-dir']);
  const commonDir = resolve(ROOT, common);
  return join(commonDir, 'upstream-update-backups', 'career-ops');
}

function serializeState(state) {
  return state.kind === 'file'
    ? { kind: state.kind, mode: state.mode, sha256: state.hash }
    : { kind: state.kind };
}

function createSnapshot(plan, baselineRecord) {
  const id = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`;
  const root = join(snapshotRoot(), id);
  mkdirSync(join(root, 'files'), { recursive: true });

  for (const item of plan.changes) {
    if (item.local.kind !== 'file') continue;
    const destination = join(root, 'files', item.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, item.local.content);
    if (sha256(readFileSync(destination)) !== item.local.hash) {
      throw new Error(`Snapshot verification failed for ${item.path}`);
    }
  }

  copyFileSync(join(ROOT, BASELINE_FILE), join(root, BASELINE_FILE));
  const indexPath = resolve(ROOT, gitText(['rev-parse', '--git-path', 'index']));
  const indexDestination = join(root, 'git-index');
  copyFileSync(indexPath, indexDestination);
  const indexSha256 = sha256(readFileSync(indexDestination));
  const manifest = {
    schema_version: SNAPSHOT_SCHEMA,
    id,
    created_at: new Date().toISOString(),
    repository: ROOT,
    baseline: baselineRecord,
    incoming_commit: plan.incoming,
    git_index: { path: indexPath, sha256: indexSha256 },
    changes: plan.changes.map((item) => ({
      path: item.path,
      action: item.action,
      reason: item.reason,
      local: serializeState(item.local),
      index: serializeState(item.index),
      baseline: serializeState(item.baseline),
      incoming: serializeState(item.incoming),
    })),
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, root, manifest };
}

function incomingHasFiles() {
  const root = join(ROOT, INCOMING_DIR);
  if (!existsSync(root)) return false;
  return readdirSync(root, { recursive: true }).length > 0;
}

function incomingFileCount(root = join(ROOT, INCOMING_DIR)) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += incomingFileCount(path);
    else count += 1;
  }
  return count;
}

function stageProtectedIncoming(plan) {
  const root = join(ROOT, INCOMING_DIR);
  mkdirSync(root, { recursive: true });
  const deletions = [];
  for (const item of plan.protected) {
    if (item.incoming.kind === 'absent') {
      deletions.push(item.path);
      continue;
    }
    const destination = join(root, item.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, item.incoming.content);
    if (sha256(readFileSync(destination)) !== item.incoming.hash) {
      throw new Error(`Incoming review copy verification failed for ${item.path}`);
    }
  }
  if (deletions.length > 0) {
    writeFileSync(join(root, '.upstream-deletions.json'), `${JSON.stringify({ paths: deletions }, null, 2)}\n`);
  }
}

function restoreFailedAttempt(snapshot, plan) {
  for (const item of plan.applicable) {
    const destination = join(ROOT, item.path);
    if (item.local.kind === 'absent') {
      if (localPathExists(destination)) rmSync(destination, { force: true });
      continue;
    }
    if (item.local.kind !== 'file') throw new Error(`Cannot restore local path type for ${item.path}`);
    const source = join(snapshot.root, 'files', item.path);
    if (!existsSync(source) || sha256(readFileSync(source)) !== item.local.hash) {
      throw new Error(`Snapshot bytes are missing or corrupt for ${item.path}`);
    }
    writeWorkingTreeState(destination, item.local, readFileSync(source));
  }
  copyFileSync(join(snapshot.root, BASELINE_FILE), join(ROOT, BASELINE_FILE));
  const indexSource = join(snapshot.root, 'git-index');
  if (sha256(readFileSync(indexSource)) !== snapshot.manifest.git_index.sha256) {
    throw new Error('Snapshot Git index is corrupt');
  }
  copyFileSync(indexSource, snapshot.manifest.git_index.path);
  rmSync(join(ROOT, INCOMING_DIR), { recursive: true, force: true });
}

function applyWorkingTree(plan) {
  for (const item of plan.applicable) {
    const destination = join(ROOT, item.path);
    if (item.action === 'delete') {
      if (localPathExists(destination)) rmSync(destination, { force: true });
      continue;
    }
    writeWorkingTreeState(destination, item.incoming, item.incoming.content);
  }
}

function verifyProtectedUnchanged(plan) {
  for (const item of plan.protected) {
    if (!sameState(localState(item.path), item.local)) {
      throw new Error(`Protected local path changed during update: ${item.path}`);
    }
    if (!sameState(indexState(item.path), item.index)) {
      throw new Error(`Protected index path changed during update: ${item.path}`);
    }
  }
}

function writeBaseline(commit) {
  let version = null;
  const state = treeState(commit, 'VERSION');
  if (state.kind === 'file') version = state.content.toString('utf8').trim().split(/\s+/)[0];
  const value = {
    schema_version: 'career-ops-upstream-baseline/v1',
    upstream_repo: CANONICAL_REPO,
    upstream_branch: UPSTREAM_BRANCH,
    commit,
    version,
    recorded_at: new Date().toISOString(),
  };
  writeFileSync(join(ROOT, BASELINE_FILE), `${JSON.stringify(value, null, 2)}\n`);
}

function commitExact(plan, incomingCommit) {
  const paths = [...plan.applicable.map((item) => item.path), BASELINE_FILE];
  if (paths.length === 0) return null;
  if (process.env.CAREER_OPS_UPDATE_NO_COMMIT === '1') return null;
  git(['add', '-A', '--', ...paths]);
  const version = treeState(incomingCommit, 'VERSION');
  const label = version.kind === 'file' ? version.content.toString('utf8').trim().split(/\s+/)[0] : incomingCommit.slice(0, 12);
  git(['commit', '--only', '-m', `chore: apply protected upstream update ${label}`, '--', ...paths]);
  return gitText(['rev-parse', 'HEAD']);
}

function acquireLock() {
  const path = join(ROOT, LOCK_FILE);
  let descriptor;
  try {
    descriptor = openSync(path, 'wx');
  } catch {
    throw new Error(`Update already in progress (${LOCK_FILE} exists)`);
  }
  writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
  closeSync(descriptor);
  return path;
}

function fetchIncoming() {
  git(['fetch', '--no-tags', CANONICAL_REPO, UPSTREAM_BRANCH], { stdio: 'inherit', timeout: 120_000 });
  return gitText(['rev-parse', 'FETCH_HEAD^{commit}']);
}

function localVersion() {
  try {
    return loadBaseline().version || loadBaseline().commit.slice(0, 12);
  } catch {
    return 'unknown';
  }
}

async function check() {
  const local = localVersion();
  const pendingReviewCount = incomingFileCount();
  if (pendingReviewCount > 0) {
    console.log(JSON.stringify({
      status: 'review-required',
      local,
      pending_review_count: pendingReviewCount,
      incoming_dir: join(ROOT, INCOMING_DIR),
    }));
    return;
  }
  const result = await checkForUpdate({ local, dismissed: existsSync(join(ROOT, '.update-dismissed')) });
  console.log(JSON.stringify(result));
}

function summarizePlan(plan, snapshot = null) {
  return {
    status: plan.changes.length === 0 ? 'no-changes' : plan.protected.length > 0 ? 'review-required' : 'ready',
    baseline: plan.baseline,
    incoming: plan.incoming,
    change_count: plan.changes.length,
    applicable_count: plan.applicable.length,
    protected_count: plan.protected.length,
    protected_paths: plan.protected.map((item) => item.path),
    snapshot: snapshot ? snapshot.root : null,
  };
}

function preview(ref = 'upstream/main') {
  const baseline = loadBaseline();
  const incoming = gitText(['rev-parse', `${ref}^{commit}`]);
  console.log(JSON.stringify(summarizePlan(buildPlan(baseline.commit, incoming)), null, 2));
}

function apply() {
  const lockPath = acquireLock();
  let snapshot = null;
  let plan = null;
  let committed = false;
  try {
    if (incomingHasFiles()) {
      throw new Error(`${INCOMING_DIR}/ contains an unresolved prior update; review or archive it before applying another update`);
    }
    const baseline = loadBaseline();
    const incoming = fetchIncoming();
    plan = buildPlan(baseline.commit, incoming);
    if (plan.changes.length === 0) {
      console.log(JSON.stringify(summarizePlan(plan), null, 2));
      return;
    }
    snapshot = createSnapshot(plan, baseline);
    stageProtectedIncoming(plan);
    applyWorkingTree(plan);
    verifyProtectedUnchanged(plan);
    writeBaseline(incoming);
    const commit = commitExact(plan, incoming);
    committed = Boolean(commit);
    writeFileSync(join(snapshot.root, 'result.json'), `${JSON.stringify({ status: 'applied', commit, completed_at: new Date().toISOString() }, null, 2)}\n`);
    console.log(JSON.stringify({ ...summarizePlan(plan, snapshot), commit, dependency_install: 'manual_if_package_metadata_changed' }, null, 2));
  } catch (error) {
    if (snapshot) {
      let restorationError = null;
      if (!committed && plan) {
        try {
          restoreFailedAttempt(snapshot, plan);
        } catch (restoreError) {
          restorationError = restoreError.message;
        }
      }
      writeFileSync(join(snapshot.root, 'result.json'), `${JSON.stringify({
        status: committed ? 'failed_after_commit' : restorationError ? 'failed_restore_incomplete' : 'failed_restored',
        error: error.message,
        restoration_error: restorationError,
        failed_at: new Date().toISOString(),
      }, null, 2)}\n`);
      if (restorationError) throw new Error(`${error.message}; automatic restoration also failed: ${restorationError}`);
    }
    throw error;
  } finally {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function latestAppliedSnapshot() {
  const root = snapshotRoot();
  if (!existsSync(root)) throw new Error('No protected update snapshots found');
  const ids = readdirSync(root).sort().reverse();
  for (const id of ids) {
    const resultPath = join(root, id, 'result.json');
    if (!existsSync(resultPath)) continue;
    const result = strictJson(resultPath, 'snapshot result');
    if (result.status === 'applied') return join(root, id);
  }
  throw new Error('No applied protected update snapshot found');
}

function rollback() {
  const lockPath = acquireLock();
  try {
    const root = latestAppliedSnapshot();
    const manifest = strictJson(join(root, 'manifest.json'), 'snapshot manifest');
    if (manifest.schema_version !== SNAPSHOT_SCHEMA || manifest.repository !== ROOT) {
      throw new Error('Snapshot does not belong to this repository or has an unsupported schema');
    }
    const paths = [];
    for (const item of manifest.changes) {
      if (item.action === 'stage_for_review') continue;
      const path = safeRelativePath(item.path, 'snapshot path');
      const destination = join(ROOT, path);
      if (item.local.kind === 'absent') {
        if (localPathExists(destination)) rmSync(destination, { force: true });
      } else if (item.local.kind === 'file') {
        const source = join(root, 'files', path);
        if (!existsSync(source) || sha256(readFileSync(source)) !== item.local.sha256) {
          throw new Error(`Snapshot bytes are missing or corrupt for ${path}`);
        }
        writeWorkingTreeState(destination, item.local, readFileSync(source));
      } else {
        throw new Error(`Cannot automatically restore snapshot path type for ${path}`);
      }
      paths.push(path);
    }
    copyFileSync(join(root, BASELINE_FILE), join(ROOT, BASELINE_FILE));
    paths.push(BASELINE_FILE);
    if (process.env.CAREER_OPS_UPDATE_NO_COMMIT !== '1') {
      git(['add', '-A', '--', ...paths]);
      git(['commit', '--only', '-m', `chore: rollback protected upstream update ${manifest.id}`, '--', ...paths]);
    }
    console.log(JSON.stringify({ status: 'rolled-back', snapshot: root, restored_paths: paths }, null, 2));
  } finally {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function dismiss() {
  writeFileSync(join(ROOT, '.update-dismissed'), new Date().toISOString());
  console.log(JSON.stringify({ status: 'dismissed' }));
}

const command = process.argv[2] || 'check';

try {
  if (command === 'check') await check();
  else if (command === 'preview') preview(process.argv[3] || 'upstream/main');
  else if (command === 'apply') apply();
  else if (command === 'rollback') rollback();
  else if (command === 'dismiss') dismiss();
  else {
    console.error('Usage: node update-system.mjs [check|preview [ref]|apply|rollback|dismiss]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'blocked', error: error.message }));
  process.exitCode = 1;
}
