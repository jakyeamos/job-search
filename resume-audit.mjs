#!/usr/bin/env node

/**
 * resume-audit.mjs — source and artifact checks for Career Ops resumes.
 *
 * The audit is deliberately conservative: content that needs human judgment
 * is reported as an advisory, while structural failures that can make a
 * resume unreadable or unsafe to submit fail the command.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

const SECTION_ALIASES = {
  summary: ['professional summary', 'summary'],
  experience: ['work experience', 'professional experience', 'experience'],
  projects: ['projects', 'selected projects', 'personal projects'],
  education: ['education', 'education & certifications'],
  skills: ['skills', 'technical skills'],
};

const REQUIRED_SECTIONS = ['summary', 'experience', 'education', 'skills'];
const ORDERED_SECTIONS = ['summary', 'experience', 'projects', 'education'];

function normalizeHeading(text) {
  return String(text || '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sectionKey(heading) {
  const normalized = normalizeHeading(heading);
  for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(normalized)) return key;
  }
  return null;
}

export function extractMarkdownHeadings(markdown) {
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (!match) return null;
      const title = match[1].trim();
      return { line: index + 1, title, key: sectionKey(title) };
    })
    .filter(Boolean);
}

function check(name, passed, detail, severity = passed ? 'pass' : 'error') {
  return { name, passed, detail, severity };
}

function firstNonEmptyLines(text, count) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, count);
}

function auditMarkdown(markdown, tier) {
  const results = [];
  const content = String(markdown || '');
  const headings = extractMarkdownHeadings(content);
  const keyed = headings.filter((heading) => heading.key);
  const firstByKey = new Map();

  for (const heading of keyed) {
    if (!firstByKey.has(heading.key)) firstByKey.set(heading.key, heading);
  }

  for (const key of REQUIRED_SECTIONS) {
    const heading = firstByKey.get(key);
    results.push(check(
      `section:${key}`,
      Boolean(heading),
      heading ? `found at line ${heading.line}: ${heading.title}` : `missing ${SECTION_ALIASES[key][0]}`
    ));
  }

  const projectHeading = firstByKey.get('projects');
  results.push(check(
    'section:projects',
    Boolean(projectHeading),
    projectHeading ? `found at line ${projectHeading.line}: ${projectHeading.title}` : 'projects section is recommended',
    projectHeading ? 'pass' : 'warning'
  ));

  const orderedPositions = ORDERED_SECTIONS
    .map((key) => firstByKey.get(key))
    .filter(Boolean)
    .map((heading) => headings.indexOf(heading));
  const ordered = orderedPositions.every((position, index) => index === 0 || position >= orderedPositions[index - 1]);
  results.push(check(
    'section-order',
    ordered,
    ordered
      ? 'summary, experience, projects, and education follow a linear order; skills may be placed before or after them'
      : 'summary, experience, projects, and education are out of order'
  ));

  const topLines = firstNonEmptyLines(content, 15).join('\n');
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(topLines);
  const hasLink = /https?:\/\/|(?:linkedin\.com|github\.com|[a-z0-9-]+\.(?:netlify\.app|com|org))/i.test(topLines);
  results.push(check(
    'contact-block',
    hasEmail && hasLink,
    hasEmail && hasLink
      ? 'email and at least one professional link appear in the first 15 non-empty lines'
      : 'put the email and at least one professional link in the top 15 non-empty lines'
  ));

  const tableLines = content.split(/\r?\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line));
  results.push(check(
    'source-layout',
    tableLines.length === 0,
    tableLines.length === 0
      ? 'source does not use Markdown tables for resume layout'
      : `${tableLines.length} Markdown table line(s) detected; keep the resume linear`,
    tableLines.length === 0 ? 'pass' : 'warning'
  ));

  const yearOnlyDates = content.match(/\b(?:19|20)\d{2}\s*(?:-|–|—)\s*(?:Present|(?:19|20)\d{2})\b/g) || [];
  results.push(check(
    'date-source-quality',
    yearOnlyDates.length === 0,
    yearOnlyDates.length > 0
      ? `${yearOnlyDates.length} year-only date range(s) found; use Month YYYY only when verified`
      : `tier ${tier} has no year-only date range advisory`,
    'warning'
  ));

  const placeholders = content.match(/\{\{[^}]+\}\}/g) || [];
  results.push(check(
    'source-placeholders',
    placeholders.length === 0,
    placeholders.length === 0 ? 'no template placeholders in cv.md' : `found ${placeholders.length} unresolved placeholder(s)`
  ));

  return results;
}

function visibleHtmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function auditHtml(html) {
  const results = [];
  const content = String(html || '');
  const visible = visibleHtmlText(content).toLowerCase();
  const placeholders = content.match(/\{\{[^}]+\}\}/g) || [];
  results.push(check(
    'html-placeholders',
    placeholders.length === 0,
    placeholders.length === 0 ? 'no unresolved template placeholders' : `found ${placeholders.length} unresolved placeholder(s)`
  ));

  const hasLinearSections = ['professional summary', 'work experience', 'education', 'skills']
    .every((heading) => visible.includes(heading));
  results.push(check(
    'html-sections',
    hasLinearSections,
    hasLinearSections ? 'required ATS headings are visible in the HTML' : 'one or more required ATS headings are missing'
  ));

  const hasEmail = /mailto:/i.test(content) || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(visible);
  const hasLink = /linkedin\.com|github\.com|https?:\/\//i.test(content);
  results.push(check(
    'html-contact-links',
    hasEmail && hasLink,
    hasEmail && hasLink ? 'email and professional links are present' : 'email and professional links are missing from the HTML'
  ));

  const suspiciousLayout = /grid-template-columns|columns\s*:/i.test(content);
  results.push(check(
    'html-layout',
    !suspiciousLayout,
    suspiciousLayout ? 'multi-column CSS detected; verify this is not a parallel resume layout' : 'no parallel-column CSS detected'
  ));

  return results;
}

function auditPdf(pdfPath, tier) {
  const results = [];
  if (!pdfPath) return results;

  if (!existsSync(pdfPath)) {
    return [check('pdf-exists', false, `PDF not found: ${pdfPath}`)];
  }

  const header = readFileSync(pdfPath).subarray(0, 5).toString('ascii');
  results.push(check('pdf-header', header === '%PDF-', header === '%PDF-' ? 'valid PDF header' : 'file does not start with %PDF-'));

  const info = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  if (info.status !== 0) {
    results.push(check('pdf-page-count', true, 'pdfinfo unavailable; inspect page count manually', 'warning'));
    return results;
  }

  const match = info.stdout.match(/^Pages:\s+(\d+)/m);
  const pages = match ? Number(match[1]) : null;
  const allowed = tier === 'evidence' ? pages !== null && pages <= 2 : pages === 1;
  results.push(check(
    'pdf-page-count',
    allowed,
    pages === null
      ? 'pdfinfo did not report a page count'
      : tier === 'evidence'
        ? `${pages} page(s); evidence master allows up to 2`
        : `${pages} page(s); standard resume requires exactly 1`,
    pages === null ? 'error' : allowed ? 'pass' : 'error'
  ));
  return results;
}

export function auditResume({ cvPath, htmlPath = '', pdfPath = '', tier = 'standard' }) {
  const results = [];
  if (!existsSync(cvPath)) {
    results.push(check('cv-exists', false, `CV not found: ${cvPath}`));
  } else {
    results.push(check('cv-exists', true, `read ${cvPath}`));
    results.push(...auditMarkdown(readFileSync(cvPath, 'utf8'), tier));
  }

  if (htmlPath && existsSync(htmlPath)) {
    results.push(...auditHtml(readFileSync(htmlPath, 'utf8')));
  } else if (htmlPath) {
    results.push(check('html-exists', false, `HTML not found: ${htmlPath}`));
  }

  results.push(...auditPdf(pdfPath, tier));

  const errors = results.filter((result) => !result.passed && result.severity === 'error');
  const warnings = results.filter((result) => !result.passed && result.severity === 'warning');
  return { tier, results, errors, warnings, passed: errors.length === 0 };
}

function parseArgs(argv) {
  const options = {
    cvPath: resolve(ROOT, 'cv.md'),
    htmlPath: '',
    pdfPath: '',
    tier: 'standard',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    if (arg === '--json') options.json = true;
    else if (arg === '--cv') options.cvPath = resolve(nextValue());
    else if (arg === '--html') options.htmlPath = resolve(nextValue());
    else if (arg === '--pdf') options.pdfPath = resolve(nextValue());
    else if (arg === '--tier') options.tier = nextValue();
    else if (arg.startsWith('--cv=')) options.cvPath = resolve(arg.slice(5));
    else if (arg.startsWith('--html=')) options.htmlPath = resolve(arg.slice(7));
    else if (arg.startsWith('--pdf=')) options.pdfPath = resolve(arg.slice(6));
    else if (arg.startsWith('--tier=')) options.tier = arg.slice(7);
  }

  if (!['standard', 'evidence'].includes(options.tier)) {
    throw new Error(`Invalid --tier ${options.tier}; use standard or evidence`);
  }
  return options;
}

function printReport(report) {
  console.log(`\n=== career-ops resume audit (${report.tier}) ===\n`);
  for (const result of report.results) {
    const icon = result.passed ? 'PASS' : result.severity === 'warning' ? 'WARN' : 'FAIL';
    console.log(`${icon.padEnd(4)} ${result.name}: ${result.detail}`);
  }
  console.log(`\n${report.passed ? 'Resume audit passed' : `Resume audit failed (${report.errors.length} error(s))`}; ${report.warnings.length} warning(s).\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = auditResume(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    process.exit(report.passed ? 0 : 1);
  } catch (error) {
    console.error(`Resume audit failed: ${error.message}`);
    process.exit(1);
  }
}
