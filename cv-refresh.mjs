#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'output', 'cv-refresh');
const DEFAULT_ROOTS = [
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'Documents'),
];
const DEFAULT_MAX_DEPTH = 3;
const MAX_SOURCE_BYTES = 200_000;
const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  '.next',
  '.turbo',
  '.vite',
  'Library',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const SIGNAL_PATTERNS = [
  ['public-v1', /\bpublic\s+(?:v|version)?\s*1\b|\bv1\b/i],
  ['public', /\bpublic\b/i],
  ['live', /\blive\b/i],
  ['beta', /\bbeta\b/i],
  ['pilot-ready', /pilot[- ]ready/i],
  ['report-only', /report[- ]only/i],
  ['read-only', /read[- ]only/i],
  ['private-beta', /private[- ]beta|private[- ]personal/i],
  ['incomplete', /\b(?:working|project|product|pipeline|flow|prototype)\b[^.\n]{0,80}\bincomplete\b/i],
  ['planning-only', /planning[- ]only|planning only/i],
  ['superseded', /\bsuperseded\b/i],
];

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function parseArgs(argv) {
  const options = {
    roots: [],
    outputDir: DEFAULT_OUTPUT_DIR,
    maxDepth: DEFAULT_MAX_DEPTH,
    json: false,
    write: true,
    check: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a path');
      options.roots.push(expandHome(value));
      index += 1;
    } else if (argument === '--output-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--output-dir requires a path');
      options.outputDir = expandHome(value);
      index += 1;
    } else if (argument === '--max-depth') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--max-depth requires a non-negative integer');
      options.maxDepth = value;
      index += 1;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--no-write') {
      options.write = false;
    } else if (argument === '--check') {
      options.check = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.roots.length === 0) options.roots = [...DEFAULT_ROOTS];
  return options;
}

function printHelp() {
  console.log(`Usage: pnpm cv:refresh [options]

Report-only inventory of local Git projects that may need CV or proof-point review.

Options:
  --root <path>        Add a repository discovery root (repeatable)
  --output-dir <path>  Write reports and state here
  --max-depth <n>      Maximum discovery depth under each root (default: ${DEFAULT_MAX_DEPTH})
  --json               Print the structured report to stdout
  --no-write           Do not write report or state files
  --check              Exit 2 when review candidates or stale references exist
  --help               Show this help

The command never edits cv.md, article-digest.md, or the accomplishment ledger.
`);
}

function readText(filePath) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_SOURCE_BYTES) return '';
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function firstExisting(root, candidates) {
  for (const candidate of candidates) {
    const filePath = path.join(root, candidate);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function isGitRepository(directory) {
  const gitPath = path.join(directory, '.git');
  try {
    return existsSync(gitPath) && (statSync(gitPath).isDirectory() || statSync(gitPath).isFile());
  } catch {
    return false;
  }
}

function safeRealpath(directory) {
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

export function discoverRepositories(roots, maxDepth = DEFAULT_MAX_DEPTH) {
  const repositories = new Set();

  function visit(directory, depth) {
    if (!existsSync(directory)) return;
    if (isGitRepository(directory)) {
      repositories.add(safeRealpath(directory));
      return;
    }
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  }

  for (const root of roots) visit(safeRealpath(root), 0);
  return [...repositories].sort((left, right) => left.localeCompare(right));
}

function runGit(repository, args) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function parsePackageMetadata(repository, sourcePaths) {
  const packageText = sourcePaths.packageJson ? readText(sourcePaths.packageJson) : '';
  if (packageText) {
    try {
      const packageJson = JSON.parse(packageText);
      return {
        name: typeof packageJson.name === 'string' ? packageJson.name : '',
        version: typeof packageJson.version === 'string' ? packageJson.version : '',
        description: typeof packageJson.description === 'string' ? packageJson.description : '',
      };
    } catch {
      // Fall through to the other package metadata formats.
    }
  }

  const pyprojectText = sourcePaths.pyproject ? readText(sourcePaths.pyproject) : '';
  const cargoText = sourcePaths.cargo ? readText(sourcePaths.cargo) : '';
  const metadataText = pyprojectText || cargoText;
  const name = metadataText.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  const version = metadataText.match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  const description = metadataText.match(/^\s*description\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  return { name, version, description };
}

function firstMeaningfulLine(text) {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^#+\s+/, '').replace(/[`*_]/g, ''))
    .find((line) => line.length >= 40 && !/^https?:\/\//i.test(line)) || '';
}

function extractDescription(sourcePaths, metadata) {
  if (metadata.description) return metadata.description.trim();
  const truth = sourcePaths.projectTruth ? readText(sourcePaths.projectTruth) : '';
  const truthState = truth.split(/^##\s+/m).find((section) => /^Current State/i.test(section)) || truth;
  const truthLine = firstMeaningfulLine(truthState);
  if (truthLine) return truthLine;
  const readme = sourcePaths.readme ? readText(sourcePaths.readme) : '';
  return firstMeaningfulLine(readme);
}

function getSourcePaths(repository) {
  return {
    projectTruth: firstExisting(repository, ['.tracker/PROJECT_TRUTH.md', 'PROJECT_TRUTH.md']),
    readme: firstExisting(repository, ['README.md', 'readme.md']),
    packageJson: firstExisting(repository, ['package.json']),
    pyproject: firstExisting(repository, ['pyproject.toml']),
    cargo: firstExisting(repository, ['Cargo.toml']),
  };
}

function getLatestCommit(repository) {
  const value = runGit(repository, ['log', '-1', '--format=%cI%x09%H%x09%s']);
  const [date = '', hash = '', ...subjectParts] = value.split('\t');
  return { date, hash, subject: subjectParts.join('\t') };
}

function getRemoteSlug(remote) {
  if (!remote) return '';
  return remote
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '')
    .split('/')
    .pop() || '';
}

function collectSignals(evidenceText) {
  return SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(evidenceText)).map(([name]) => name);
}

function normalizeForMatch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function humanizeRepositoryName(name) {
  return String(name || '')
    .replace(/^@[^/]+\//, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function loadSourceCorpus() {
  const cvPath = path.join(ROOT, 'cv.md');
  const digestPath = path.join(ROOT, 'article-digest.md');
  const ledgerPath = path.join(ROOT, 'config', 'project-accomplishment-ledger.json');
  const files = [cvPath, digestPath, ledgerPath];
  const content = files.map((filePath) => readText(filePath)).join('\n');
  return { content, compact: normalizeForMatch(content), ledgerPath };
}

function buildRepresentation(repository, sourceCorpus) {
  const aliases = [
    repository.repositoryName,
    repository.packageName,
    repository.displayName,
    repository.remoteSlug,
  ].filter((alias) => normalizeForMatch(alias).length >= 4);
  const matchedAliases = [...new Set(aliases.filter((alias) => sourceCorpus.compact.includes(normalizeForMatch(alias))))];
  return {
    represented: matchedAliases.length > 0,
    matchedAliases,
  };
}

function buildFingerprint(repository, sourcePaths, latestCommit, tag) {
  const sourceContent = Object.entries(sourcePaths)
    .filter(([, filePath]) => filePath)
    .map(([key, filePath]) => `${key}:${filePath}\n${readText(filePath)}`)
    .join('\n');
  return createHash('sha256')
    .update(JSON.stringify({ head: latestCommit.hash, tag, sourceContent }))
    .digest('hex');
}

export function buildRepositoryRecord(repository, sourceCorpus, previousRecord = null) {
  const sourcePaths = getSourcePaths(repository);
  const metadata = parsePackageMetadata(repository, sourcePaths);
  const repositoryName = path.basename(repository);
  const packageName = metadata.name;
  const displayName = packageName && packageName !== packageName.toLowerCase()
    ? packageName
    : humanizeRepositoryName(repositoryName);
  const latestCommit = getLatestCommit(repository);
  const tag = runGit(repository, ['describe', '--tags', '--always']);
  const remote = runGit(repository, ['config', '--get', 'remote.origin.url']);
  const status = runGit(repository, ['status', '--short']);
  const evidenceText = [sourcePaths.projectTruth, sourcePaths.readme]
    .filter(Boolean)
    .map(readText)
    .join('\n');
  const representation = buildRepresentation({ repositoryName, packageName, displayName, remoteSlug: getRemoteSlug(remote) }, sourceCorpus);
  const fingerprint = buildFingerprint(repository, sourcePaths, latestCommit, tag);
  const evidenceSignals = collectSignals(evidenceText);
  const evidencePaths = Object.values(sourcePaths).filter(Boolean);
  const changed = Boolean(previousRecord && previousRecord.fingerprint !== fingerprint);
  const firstSeen = Boolean(!previousRecord);
  const newlyUnrepresented = Boolean(previousRecord?.represented && !representation.represented);
  const newlyRepresented = Boolean(previousRecord && !previousRecord.represented && representation.represented);
  const discoveryStatus = firstSeen ? 'baseline' : changed ? 'changed' : 'unchanged';
  const reviewReasons = [];

  if (firstSeen && !representation.represented) reviewReasons.push('not represented in cv.md, article-digest.md, or the accomplishment ledger');
  if (changed) reviewReasons.push('project evidence changed since the previous scan');
  if (newlyUnrepresented) reviewReasons.push('project is no longer matched by the canonical CV sources');
  if (newlyRepresented) reviewReasons.push('project now matches the canonical CV sources');
  if (status) reviewReasons.push('working tree has uncommitted changes; do not treat branch-only work as released');
  if (evidenceSignals.includes('planning-only')) reviewReasons.push('source documentation marks the project as planning-only');
  if (evidenceSignals.includes('superseded')) reviewReasons.push('source documentation marks the project as superseded');
  if (evidenceSignals.includes('incomplete')) reviewReasons.push('source documentation marks the project as incomplete');

  return {
    path: repository,
    repositoryName,
    packageName,
    displayName,
    version: metadata.version,
    description: extractDescription(sourcePaths, metadata).replace(/\s+/g, ' ').trim().slice(0, 280),
    branch: runGit(repository, ['branch', '--show-current']),
    remote,
    remoteSlug: getRemoteSlug(remote),
    tag,
    latestCommit,
    dirty: Boolean(status),
    evidenceSignals,
    evidencePaths,
    represented: representation.represented,
    matchedAliases: representation.matchedAliases,
    fingerprint,
    discoveryStatus,
    reviewReasons,
    previousFingerprint: previousRecord?.fingerprint || '',
  };
}

function loadState(statePath) {
  const content = readText(statePath);
  if (!content) return { schemaVersion: 1, repositories: {} };
  try {
    const parsed = JSON.parse(content);
    return {
      schemaVersion: 1,
      repositories: parsed && typeof parsed.repositories === 'object' ? parsed.repositories : {},
    };
  } catch {
    return { schemaVersion: 1, repositories: {} };
  }
}

function parseLedgerEntries(ledgerPath) {
  const content = readText(ledgerPath);
  if (!content) return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function collectStaleSourceReferences(ledgerPath) {
  return parseLedgerEntries(ledgerPath).flatMap((entry) => {
    const sourceRefs = Array.isArray(entry?.sourceRefs) ? entry.sourceRefs : [];
    return sourceRefs
      .filter((sourceRef) => typeof sourceRef === 'string' && path.isAbsolute(sourceRef) && !existsSync(sourceRef))
      .map((sourceRef) => ({
        id: String(entry.id || entry.name || 'unknown'),
        sourceRef,
      }));
  });
}

function truncate(value, length = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}

function markdownCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function candidateWording(record) {
  if (!record.description) return 'Review the source files before drafting a project description.';
  return `**${record.displayName}** — ${record.description}`;
}

export function renderRefreshReport(result) {
  const lines = [
    `# CV evidence refresh — ${result.date}`,
    '',
    'This is a report-only scan. It does not modify `cv.md`, `article-digest.md`, or the accomplishment ledger.',
    '',
    '## Summary',
    '',
    `- Discovery roots: ${result.roots.join(', ')}`,
    `- Repositories discovered: ${result.repositories.length}`,
    `- Review candidates: ${result.reviewCandidates.length}`,
    `- Stale source references: ${result.staleSourceReferences.length}`,
    `- Unchanged repositories: ${result.repositories.filter((repository) => repository.discoveryStatus === 'unchanged').length}`,
    '',
  ];

  if (result.reviewCandidates.length > 0) {
    lines.push('## Review candidates', '');
    for (const repository of result.reviewCandidates) {
      lines.push(
        `### ${repository.displayName}`,
        '',
        `- Classification: ${repository.discoveryStatus}`,
        `- Repository: \`${repository.path}\``,
        `- Branch: ${repository.branch || '(detached or unavailable)'}`,
        `- Version/tag: ${repository.version || '(no package version)'} / ${repository.tag || '(none)'}`,
        `- Latest commit: ${repository.latestCommit.date || '(unknown)'} — ${truncate(repository.latestCommit.subject, 160) || '(unknown)'}`,
        `- Working tree: ${repository.dirty ? 'dirty; review before claiming a release' : 'clean at scan time'}`,
        `- Canonical-source match: ${repository.represented ? `yes (${repository.matchedAliases.join(', ')})` : 'no'}`,
        `- Evidence signals: ${repository.evidenceSignals.length > 0 ? repository.evidenceSignals.join(', ') : '(none detected)'}`,
        `- Evidence files: ${repository.evidencePaths.length > 0 ? repository.evidencePaths.join(', ') : '(no recognized README, truth, or package metadata)'}`,
        `- Why it surfaced: ${repository.reviewReasons.join('; ')}`,
        '',
        '**Candidate wording — review before applying:**',
        '',
        `> ${candidateWording(repository)}`,
        '',
      );
    }
  } else {
    lines.push('## Review candidates', '', 'No new or changed project evidence requires review.', '');
  }

  lines.push('## Stale source references', '');
  if (result.staleSourceReferences.length === 0) {
    lines.push('No absolute source references in the accomplishment ledger point to missing files.', '');
  } else {
    lines.push('| Entry | Missing source |', '|---|---|');
    for (const stale of result.staleSourceReferences) {
      lines.push(`| ${markdownCell(stale.id)} | ${markdownCell(stale.sourceRef)} |`);
    }
    lines.push('');
  }

  lines.push(
    '## Safety boundary',
    '',
    '- Repository discovery and evidence collection are read-only.',
    '- The scanner never approves a project, invents metrics, infers customers or outcomes, or treats dirty-branch work as released.',
    '- Apply proposed wording only after human review, then run `pnpm sync-check` and regenerate the full CV PDF.',
    '',
  );
  return lines.join('\n');
}

export function scanWorkspace(options = {}) {
  const roots = (options.roots || DEFAULT_ROOTS).map(expandHome);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const date = formatDate();
  const statePath = path.join(outputDir, 'state.json');
  const previousState = loadState(statePath);
  const sourceCorpus = loadSourceCorpus();
  const repositoryPaths = discoverRepositories(roots, maxDepth);
  const repositories = repositoryPaths.map((repository) => buildRepositoryRecord(
    repository,
    sourceCorpus,
    previousState.repositories[repository] || null,
  ));
  const reviewCandidates = repositories.filter((repository) => {
    const previous = previousState.repositories[repository.path];
    return repository.reviewReasons.length > 0 && (
      !previous
      || repository.discoveryStatus === 'changed'
      || repository.reviewReasons.some((reason) => reason.includes('no longer matched'))
      || repository.reviewReasons.some((reason) => reason.includes('now matches'))
    );
  });
  const staleSourceReferences = collectStaleSourceReferences(sourceCorpus.ledgerPath);
  const result = {
    schemaVersion: 1,
    date,
    generatedAt: new Date().toISOString(),
    roots,
    maxDepth,
    repositories,
    reviewCandidates,
    staleSourceReferences,
    statePath,
  };
  return result;
}

function writeOutputs(result, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const state = {
    schemaVersion: 1,
    generatedAt: result.generatedAt,
    roots: result.roots,
    maxDepth: result.maxDepth,
    repositories: Object.fromEntries(result.repositories.map((repository) => [repository.path, {
      fingerprint: repository.fingerprint,
      represented: repository.represented,
      displayName: repository.displayName,
      latestCommit: repository.latestCommit,
    }])),
  };
  const reportPath = path.join(outputDir, `cv-refresh-${result.date}.md`);
  writeFileSync(reportPath, renderRefreshReport(result));
  writeFileSync(path.join(outputDir, 'latest.md'), renderRefreshReport(result));
  writeFileSync(path.join(outputDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(outputDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return reportPath;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  const result = scanWorkspace(options);
  let reportPath = '';
  if (options.write) reportPath = writeOutputs(result, options.outputDir);
  if (options.json) {
    console.log(JSON.stringify({ ...result, reportPath }, null, 2));
  } else {
    console.log(`CV refresh scanned ${result.repositories.length} repositories.`);
    console.log(`Review candidates: ${result.reviewCandidates.length}; stale references: ${result.staleSourceReferences.length}.`);
    if (reportPath) console.log(`Report: ${reportPath}`);
    console.log('No CV or proof-point files were modified.');
  }
  if (options.check && (result.reviewCandidates.length > 0 || result.staleSourceReferences.length > 0)) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
