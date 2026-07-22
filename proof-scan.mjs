#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = process.env.CAREER_OPS_REPO_ROOT || '/Users/jakyeamos/projects';
const EXCLUDED_REPOS = new Set(['career-ops', 'BIP-Console']);
const EXCLUDED_SEGMENTS = new Set(['.git', '.next', '.turbo', '.cache', 'build', 'coverage', 'dist', 'generated', 'node_modules', 'release']);
const EXCLUDED_FILES = new Set(['Cargo.lock', 'Gemfile.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

export function discoverProofRepos(root = DEFAULT_REPO_ROOT, { includeArchived = false } = {}) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && (includeArchived || !EXCLUDED_REPOS.has(entry.name)))
    .map((entry) => path.join(root, entry.name))
    .filter((repoPath) => existsSync(path.join(repoPath, '.git')))
    .sort();
}

export function scanProofRepos({ root = DEFAULT_REPO_ROOT, date = today(), includeUncommitted = false, includeArchived = false } = {}) {
  const normalizedDate = normalizeDate(date);
  const repos = discoverProofRepos(root, { includeArchived });
  const events = repos.flatMap((repoPath) => [
    ...collectCommittedEvents(repoPath, normalizedDate),
    ...(includeUncommitted ? collectUncommittedEvents(repoPath, normalizedDate) : []),
  ]).filter((event) => isScannablePath(event.filePath));
  const byRepo = new Map();
  for (const event of events) {
    const current = byRepo.get(event.repoName) || { repoName: event.repoName, eventCount: 0, riskCount: 0, fileKinds: {} };
    current.eventCount += 1;
    current.riskCount += event.riskFlags.length > 0 ? 1 : 0;
    current.fileKinds[event.fileKind] = (current.fileKinds[event.fileKind] || 0) + 1;
    byRepo.set(event.repoName, current);
  }
  return {
    generatedAt: new Date().toISOString(),
    date: normalizedDate,
    root: path.basename(path.resolve(root)),
    repoCount: repos.length,
    eventCount: events.length,
    riskCount: events.filter((event) => event.riskFlags.length > 0).length,
    repos: [...byRepo.values()].sort((left, right) => left.repoName.localeCompare(right.repoName)),
    events,
  };
}

export function writeProofScan(workspace = ROOT, options = {}) {
  const report = scanProofRepos(options);
  const outputDirectory = path.join(workspace, 'output', 'proof-scan');
  mkdirSync(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, `${report.date}.json`);
  const markdownPath = path.join(outputDirectory, `${report.date}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, `${renderProofScan(report)}\n`, 'utf8');
  return { report, jsonPath, markdownPath };
}

export function renderProofScan(report) {
  return [
    `# Career-Ops proof scan - ${report.date}`,
    '',
    `Scanned ${report.repoCount} repositories and found ${report.eventCount} public-safe change events. Risk flags: ${report.riskCount}.`,
    '',
    '## Repository summary',
    '',
    '| Repository | Events | Risk flags | File kinds |',
    '| --- | ---: | ---: | --- |',
    ...(report.repos.length > 0
      ? report.repos.map((repo) => `| ${repo.repoName} | ${repo.eventCount} | ${repo.riskCount} | ${Object.entries(repo.fileKinds).map(([kind, count]) => `${kind}: ${count}`).join(', ')} |`)
      : ['| - | 0 | 0 | No changes found |']),
    '',
    '## Public-safe evidence',
    '',
    ...(report.events.length > 0
      ? report.events.slice(0, 50).map((event) => `- **${event.repoName}** - ${event.publicSafeSummary}`)
      : ['- No repo change events found.']),
    '',
    'This report is a review input. It does not publish, submit, or infer adoption, customers, revenue, or readiness.',
  ].join('\n');
}

function collectCommittedEvents(repoPath, date) {
  const output = runGit(repoPath, ['log', `--since=${date}T00:00:00.000Z`, `--until=${nextDate(date)}T00:00:00.000Z`, '--name-status', '--format=__COMMIT__%H%x09%s']);
  if (!output.trim()) return [];
  const events = [];
  let commitSha = null;
  let commitSubject = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      [commitSha, commitSubject] = line.slice('__COMMIT__'.length).split('\t');
      continue;
    }
    if (!line.trim() || !commitSha) continue;
    const parsed = parseNameStatus(line);
    if (parsed) events.push(buildEvent(repoPath, commitSha, commitSubject, parsed.status, parsed.filePath, date));
  }
  return events;
}

function collectUncommittedEvents(repoPath, date) {
  return runGit(repoPath, ['status', '--short']).split('\n').map((line) => {
    if (!line.trim()) return null;
    const status = line.slice(0, 2).trim() || 'M';
    const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
    return filePath ? buildEvent(repoPath, null, 'Uncommitted workspace change', status, filePath, date) : null;
  }).filter(Boolean);
}

function buildEvent(repoPath, commitSha, commitSubject, status, filePath, date) {
  const repoName = path.basename(repoPath);
  const fileKind = classifyFileKind(filePath);
  const rawSummary = [commitSubject ? `Commit: ${commitSubject}` : 'Workspace change', `Status: ${status}`, `File: ${filePath}`, readRepoSnippet(repoPath, filePath)].filter(Boolean).join(' ');
  const redacted = redactSensitiveText(rawSummary);
  const safeSubject = sanitizePublicText(commitSubject || 'workspace change');
  return {
    repoName,
    date,
    commitSha: commitSha ? commitSha.slice(0, 12) : null,
    commitSubject: safeSubject,
    status,
    filePath: redactSensitiveText(filePath).text,
    fileKind,
    privateSummary: redacted.text,
    publicSafeSummary: `${repoName} had a ${fileKind} ${status.startsWith('D') ? 'removal' : 'change'} around ${safeSubject}.`,
    riskFlags: redacted.flags,
  };
}

function readRepoSnippet(repoPath, filePath) {
  const fullPath = path.join(repoPath, filePath);
  try {
    if (!existsSync(fullPath)) return '';
    const fileStat = statSync(fullPath);
    if (!fileStat.isFile() || fileStat.size > 20000 || isBinaryLikePath(filePath)) return '';
    const text = readFileSync(fullPath, 'utf8');
    if (text.includes('\u0000')) return '';
    return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 12).join(' ').slice(0, 700);
  } catch {
    return '';
  }
}

function isScannablePath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const fileName = segments.at(-1) || '';
  return !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)) && !EXCLUDED_FILES.has(fileName) && !/^\.env(?:\.|$)/.test(fileName) && !isBinaryLikePath(filePath);
}

function isBinaryLikePath(filePath) {
  return /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tar|tgz|dmg|sqlite|sqlite3|db|mp3|mp4|mov|wav|ttf|otf|woff2?)$/i.test(filePath);
}

function classifyFileKind(filePath) {
  const normalized = filePath.toLowerCase();
  const extension = path.extname(normalized);
  if (/(^|\/)(test|tests|spec|__tests__)\//.test(normalized) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return 'test';
  if (normalized.endsWith('.md') || normalized.startsWith('docs/') || normalized.includes('/docs/')) return 'docs';
  if (['package.json', 'tsconfig.json', 'vitest.config.ts', 'eslint.config.js'].includes(normalized) || ['.json', '.yml', '.yaml', '.toml'].includes(extension)) return 'config';
  if (/\.(?:svg|css|scss|html)$/.test(normalized)) return 'asset';
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|swift|kt|java|c|cpp|h|sql)$/.test(normalized)) return 'source';
  return 'other';
}

function redactSensitiveText(text) {
  const flags = new Set();
  let redacted = text;
  const replacements = [
    { pattern: /\/Users\/jakyeamos\/[^\s)]+/g, replacement: '[local-path-redacted]', flag: 'redacted-local-path' },
    { pattern: /\b(?:sk|xox[baprs]|ghp|github_pat|Bearer)[-_A-Za-z0-9]{10,}\b/g, replacement: '[secret-redacted]', flag: 'redacted-secret' },
    { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[email-redacted]', flag: 'redacted-email' },
    { pattern: /\.env(?:\.[A-Za-z0-9_-]+)?/g, replacement: '[env-file-redacted]', flag: 'redacted-env-file' },
    { pattern: /\b[a-z0-9_-]+\.db\b/gi, replacement: '[database-redacted]', flag: 'redacted-database' },
  ];
  for (const item of replacements) {
    if (item.pattern.test(redacted)) {
      flags.add(item.flag);
      redacted = redacted.replace(item.pattern, item.replacement);
    }
  }
  return { text: redacted, flags: [...flags].sort() };
}

function sanitizePublicText(text) {
  return redactSensitiveText(text).text.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

function parseNameStatus(line) {
  const parts = line.split('\t');
  if (parts.length < 2) return null;
  return { status: parts[0], filePath: parts.at(-1) };
}

function runGit(repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function normalizeDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).valueOf())) throw new Error(`Invalid date: ${value}; expected YYYY-MM-DD`);
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function today() { return new Date().toISOString().slice(0, 10); }

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const [key, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (args[index + 1] && !args[index + 1].startsWith('--')) { options[key] = args[index + 1]; index += 1; }
    else options[key] = true;
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  try {
    const result = writeProofScan(ROOT, {
      root: String(options.root || DEFAULT_REPO_ROOT),
      date: String(options.date || today()),
      includeUncommitted: options['include-uncommitted'] === true,
      includeArchived: options['include-archived'] === true,
    });
    console.log(options.json ? JSON.stringify({ ...result.report, jsonPath: result.jsonPath, markdownPath: result.markdownPath }, null, 2) : `Proof scan: ${result.report.eventCount} events across ${result.report.repoCount} repos.\nJSON: ${result.jsonPath}\nMarkdown: ${result.markdownPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
