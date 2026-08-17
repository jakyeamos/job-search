import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATER = readFileSync(join(PROJECT, 'update-system.mjs'), 'utf8');
const UPDATE_CHECK = readFileSync(join(PROJECT, 'update-check.mjs'), 'utf8');
const UPDATE_PRIMITIVES = readFileSync(join(PROJECT, 'update-primitives.mjs'), 'utf8');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Career Ops Test',
  GIT_AUTHOR_EMAIL: 'career-ops-test@example.invalid',
  GIT_COMMITTER_NAME: 'Career Ops Test',
  GIT_COMMITTER_EMAIL: 'career-ops-test@example.invalid',
};

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...GIT_ENV, ...options.env },
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root, path, content) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function commitAll(root, message) {
  run('git', ['add', '-A'], root);
  run('git', ['commit', '-m', message], root);
  return run('git', ['rev-parse', 'HEAD'], root);
}

function fixture({ localCustomization = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-update-test-'));
  const upstream = join(root, 'upstream');
  const local = join(root, 'local');
  mkdirSync(upstream);
  run('git', ['init', '-b', 'main'], upstream);
  write(upstream, 'VERSION', '1.0.0\n');
  write(upstream, 'clean-system.txt', 'base clean\n');
  write(upstream, 'local-system.txt', 'base local\n');
  write(upstream, 'data/applications.md', 'base private\n');
  const baseline = commitAll(upstream, 'base');

  run('git', ['clone', upstream, local], root);
  write(local, '.local-overrides.json', '{"paths":[]}\n');
  write(local, '.upstream-baseline.json', `${JSON.stringify({
    schema_version: 'career-ops-upstream-baseline/v1',
    upstream_repo: upstream,
    upstream_branch: 'main',
    commit: baseline,
    version: '1.0.0',
    recorded_at: '2026-08-10T00:00:00Z',
  }, null, 2)}\n`);
  commitAll(local, 'install guarded updater');
  if (localCustomization) {
    write(local, 'local-system.txt', 'my local customization\n');
    commitAll(local, 'local system customization');
  }
  write(local, 'update-system.mjs', UPDATER);
  write(local, 'update-check.mjs', UPDATE_CHECK);
  write(local, 'update-primitives.mjs', UPDATE_PRIMITIVES);

  write(upstream, 'VERSION', '1.1.0\n');
  write(upstream, 'clean-system.txt', 'incoming clean\n');
  write(upstream, 'local-system.txt', 'incoming local\n');
  write(upstream, 'data/applications.md', 'incoming private\n');
  const incoming = commitAll(upstream, 'upstream release');

  return { root, upstream, local, baseline, incoming };
}

function applyUpdate(f) {
  return JSON.parse(run('node', ['update-system.mjs', 'apply'], f.local, {
    env: { CAREER_OPS_UPSTREAM_REPO: f.upstream },
  }));
}

test('apply preserves local, private, staged, and untracked work while committing exact upstream paths', () => {
  const f = fixture({ localCustomization: true });
  write(f.local, 'data/applications.md', 'my dirty private data\n');
  write(f.local, 'unrelated-stage.txt', 'keep staged\n');
  run('git', ['add', 'unrelated-stage.txt'], f.local);
  write(f.local, 'unrelated-untracked.txt', 'keep untracked\n');

  const result = applyUpdate(f);

  assert.equal(result.status, 'review-required');
  assert.equal(readFileSync(join(f.local, 'clean-system.txt'), 'utf8'), 'incoming clean\n');
  assert.equal(readFileSync(join(f.local, 'local-system.txt'), 'utf8'), 'my local customization\n');
  assert.equal(readFileSync(join(f.local, 'data/applications.md'), 'utf8'), 'my dirty private data\n');
  assert.equal(readFileSync(join(f.local, '.update-incoming/local-system.txt'), 'utf8'), 'incoming local\n');
  assert.equal(readFileSync(join(f.local, 'unrelated-untracked.txt'), 'utf8'), 'keep untracked\n');
  assert.match(run('git', ['diff', '--cached', '--name-only'], f.local), /unrelated-stage\.txt/);
  assert.equal(run('git', ['show', 'HEAD:clean-system.txt'], f.local), 'incoming clean');
  assert.equal(run('git', ['show', 'HEAD:local-system.txt'], f.local), 'my local customization');
  assert.ok(existsSync(result.snapshot));
  assert.ok(existsSync(join(result.snapshot, 'git-index')));
});

test('invalid protection configuration blocks before any update write', () => {
  const f = fixture();
  write(f.local, '.local-overrides.json', '{ invalid json');
  assert.throws(
    () => applyUpdate(f),
    (error) => /missing or invalid JSON/.test(`${error.stderr || error.message}`),
  );
  assert.equal(readFileSync(join(f.local, 'clean-system.txt'), 'utf8'), 'base clean\n');
  assert.equal(existsSync(join(f.local, '.update-incoming')), false);
});

test('a staged path is protected even when its bytes equal the recorded baseline', () => {
  const f = fixture();
  write(f.local, 'clean-system.txt', 'temporary staged choice\n');
  run('git', ['add', 'clean-system.txt'], f.local);
  write(f.local, 'clean-system.txt', 'base clean\n');

  const result = applyUpdate(f);

  assert.ok(result.protected_paths.includes('clean-system.txt'));
  assert.equal(readFileSync(join(f.local, 'clean-system.txt'), 'utf8'), 'base clean\n');
  assert.equal(run('git', ['show', ':clean-system.txt'], f.local), 'temporary staged choice');
  assert.equal(readFileSync(join(f.local, '.update-incoming/clean-system.txt'), 'utf8'), 'incoming clean\n');
});

test('rollback restores exact pre-update bytes from the verified snapshot', () => {
  const f = fixture();
  const result = applyUpdate(f);
  assert.equal(readFileSync(join(f.local, 'clean-system.txt'), 'utf8'), 'incoming clean\n');

  const rollback = JSON.parse(run('node', ['update-system.mjs', 'rollback'], f.local, {
    env: { CAREER_OPS_UPSTREAM_REPO: f.upstream },
  }));

  assert.equal(rollback.status, 'rolled-back');
  assert.equal(rollback.snapshot, result.snapshot);
  assert.equal(readFileSync(join(f.local, 'clean-system.txt'), 'utf8'), 'base clean\n');
  assert.equal(JSON.parse(readFileSync(join(f.local, '.upstream-baseline.json'), 'utf8')).commit, f.baseline);
});

test('no-commit mode preserves HEAD and the exact pre-update index', () => {
  const f = fixture();
  write(f.local, 'unrelated-stage.txt', 'keep staged\n');
  run('git', ['add', 'unrelated-stage.txt'], f.local);
  const headBefore = run('git', ['rev-parse', 'HEAD'], f.local);
  const indexBefore = run('git', ['write-tree'], f.local);

  const result = JSON.parse(run('node', ['update-system.mjs', 'apply'], f.local, {
    env: {
      CAREER_OPS_UPSTREAM_REPO: f.upstream,
      CAREER_OPS_UPDATE_NO_COMMIT: '1',
    },
  }));

  assert.equal(result.commit, null);
  assert.equal(run('git', ['rev-parse', 'HEAD'], f.local), headBefore);
  assert.equal(run('git', ['write-tree'], f.local), indexBefore);
  assert.equal(readFileSync(join(f.local, 'clean-system.txt'), 'utf8'), 'incoming clean\n');
  assert.equal(run('git', ['show', ':clean-system.txt'], f.local), 'base clean');
  assert.equal(JSON.parse(readFileSync(join(f.local, '.upstream-baseline.json'), 'utf8')).commit, f.incoming);
});

test('an explicitly protected test suite is staged for review instead of mixed into local behavior', () => {
  const f = fixture();
  write(f.local, '.local-overrides.json', '{"paths":["tests/"]}\n');
  write(f.upstream, 'tests/upstream-contract.txt', 'incoming behavior contract\n');
  commitAll(f.upstream, 'add upstream-only behavior contract');

  const result = applyUpdate(f);

  assert.ok(result.protected_paths.includes('tests/upstream-contract.txt'));
  assert.equal(existsSync(join(f.local, 'tests/upstream-contract.txt')), false);
  assert.equal(
    readFileSync(join(f.local, '.update-incoming/tests/upstream-contract.txt'), 'utf8'),
    'incoming behavior contract\n',
  );
});

test('check reports unresolved incoming review before claiming upstream currency', () => {
  const f = fixture({ localCustomization: true });
  applyUpdate(f);

  const result = JSON.parse(run('node', ['update-system.mjs', 'check'], f.local));

  assert.equal(result.status, 'review-required');
  assert.equal(result.local, '1.1.0');
  assert.equal(result.pending_review_count, 1);
  assert.equal(realpathSync(result.incoming_dir), realpathSync(join(f.local, '.update-incoming')));
});

test('an eligible upstream symlink remains a symlink in the working tree', () => {
  const f = fixture();
  write(f.upstream, 'skills/target.md', 'target\n');
  mkdirSync(join(f.upstream, 'skills'), { recursive: true });
  symlinkSync('target.md', join(f.upstream, 'skills/current.md'));
  commitAll(f.upstream, 'add upstream symlink');

  applyUpdate(f);

  assert.equal(lstatSync(join(f.local, 'skills/current.md')).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(f.local, 'skills/current.md')), 'target.md');
});

test('an upstream symlink is staged when its target is protected', () => {
  const f = fixture({ localCustomization: true });
  mkdirSync(join(f.upstream, 'skills'), { recursive: true });
  symlinkSync('../local-system.txt', join(f.upstream, 'skills/current.md'));
  commitAll(f.upstream, 'add symlink to customized target');

  const result = applyUpdate(f);

  assert.ok(result.protected_paths.includes('local-system.txt'));
  assert.ok(result.protected_paths.includes('skills/current.md'));
  assert.equal(existsSync(join(f.local, 'skills/current.md')), false);
  assert.equal(readFileSync(join(f.local, '.update-incoming/skills/current.md'), 'utf8'), '../local-system.txt');
});

test('no-commit rollback preserves HEAD and the exact pre-rollback index', () => {
  const f = fixture();
  applyUpdate(f);
  write(f.local, 'unrelated-stage.txt', 'keep staged through rollback\n');
  run('git', ['add', 'unrelated-stage.txt'], f.local);
  const headBefore = run('git', ['rev-parse', 'HEAD'], f.local);
  const indexBefore = run('git', ['write-tree'], f.local);

  const result = JSON.parse(run('node', ['update-system.mjs', 'rollback'], f.local, {
    env: {
      CAREER_OPS_UPSTREAM_REPO: f.upstream,
      CAREER_OPS_UPDATE_NO_COMMIT: '1',
    },
  }));

  assert.equal(result.status, 'rolled-back');
  assert.equal(run('git', ['rev-parse', 'HEAD'], f.local), headBefore);
  assert.equal(run('git', ['write-tree'], f.local), indexBefore);
  assert.equal(readFileSync(join(f.local, 'clean-system.txt'), 'utf8'), 'base clean\n');
  assert.equal(run('git', ['show', ':clean-system.txt'], f.local), 'incoming clean');
  assert.equal(JSON.parse(readFileSync(join(f.local, '.upstream-baseline.json'), 'utf8')).commit, f.baseline);
});
