#!/usr/bin/env node

/**
 * Build truthful, job-specific application artifacts from Career Ops' source
 * documents. The generator is deterministic by default: it selects and
 * reorders verified evidence, but it does not invent claims or call an LLM in
 * the per-application path.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { renderHtmlToPdf } from '../generate-pdf.mjs';
import { auditResume } from '../resume-audit.mjs';
import { fetchAtsJobDescription } from './public-job-description.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_ARTIFACT_ROOT = path.join(ROOT, 'output', 'application-artifacts');
const SOURCE_FILES = ['cv.md', 'article-digest.md', 'config/profile.yml', 'modes/_profile.md'];

const LANE_PHRASES = {
  backend_ai_platform: 'backend services, data workflows, and applied AI',
  developer_tools_infrastructure: 'developer tooling, quality systems, and platform workflows',
  applied_ai_client_delivery: 'applied AI, client delivery, and reliable product systems',
  product_full_stack: 'full-stack product systems and customer workflows',
  data_analytics: 'data pipelines, analytics, and decision-support products',
  solutions_forward_deployed: 'customer-facing systems, integrations, and rapid product delivery',
  sports_analytics: 'basketball and sports analytics, player-evaluation modeling, and decision-support products',
};

const FALLBACK_PROJECTS = {
  backend_ai_platform: ['Tenure', 'BidCamp', 'Quality Runner'],
  developer_tools_infrastructure: ['Quality Runner', 'Pre-CR Suite', 'AIOS'],
  applied_ai_client_delivery: ['Tenure', 'BidCamp', 'Forward Automations'],
  product_full_stack: ['BidCamp', 'Hoopscout', 'Court Vision'],
  data_analytics: ['Dsci-proj', 'BBDSE/CourtIQ', 'Tenure'],
  solutions_forward_deployed: ['Forward Automations', 'Tenure', 'BidCamp'],
  sports_analytics: ['BBDSE/CourtIQ', 'Court Vision', 'BidCamp'],
};

const PROJECT_ALIASES = {
  'quality runner': ['quality runner', 'quality-runner'],
  'pre-cr suite': ['pre-cr suite', 'pre-cr-suite', 'pre-cr'],
  aios: ['aios'],
  tenure: ['tenure'],
  bidcamp: ['bidcamp'],
  hoopscout: ['hoopscout'],
  'court vision': ['court vision', 'bball'],
  'bbdse/courtiq': ['bbdse', 'court iq', 'courtiq', 'court vision'],
  'dsci-proj': ['dsci-proj', 'github issue resolution', 'survival-analysis'],
  crimclock: ['crimclock'],
  remodelvision: ['remodelvision'],
  soundscape: ['soundscape'],
  'forward automations': ['forward automations'],
  fantasy: ['fantasy', 'dynasty fantasy', 'fantasy football'],
};

const TARGET_KEYWORDS = [
  ['Python', /\bpython\b/i],
  ['TypeScript', /\btypescript\b/i],
  ['JavaScript', /\bjavascript\b/i],
  ['Go', /\bgo\b|golang/i],
  ['SQL', /\bsql\b/i],
  ['AWS', /\baws\b|amazon web services/i],
  ['REST APIs', /\brest(?:ful)?\s+api(?:s)?\b/i],
  ['data pipelines', /\bdata\s+pipeline(?:s)?\b/i],
  ['event-driven workflows', /event[- ]driven|event-driven workflows/i],
  ['serverless', /\bserverless\b/i],
  ['Snowflake', /\bsnowflake\b/i],
  ['LLM workflows', /\bllm(?:s)?\b|large language model/i],
  ['RAG', /\brag\b|retrieval[- ]augmented/i],
  ['embeddings', /\bembedding(?:s)?\b|vector database/i],
  ['agent workflows', /\bagent(?:ic)?\s+workflow(?:s)?\b/i],
  ['automated testing', /automated test(?:ing|s)|test automation/i],
  ['CI/CD', /\bci\s*\/\s*cd\b|continuous integration|continuous delivery/i],
  ['observability', /\bobservability\b|structured logging|monitoring/i],
  ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
  ['Supabase', /\bsupabase\b/i],
  ['SQLite', /\bsqlite\b/i],
  ['Docker', /\bdocker\b/i],
  ['MCP', /\bmcp\b|model context protocol/i],
  ['LSP', /\blsp\b|language server/i],
];

const LANE_COMPETENCIES = {
  backend_ai_platform: ['Backend APIs', 'Data workflows', 'Applied AI', 'TypeScript/Python', 'PostgreSQL', 'Testing and observability'],
  developer_tools_infrastructure: ['Developer tooling', 'CLI and MCP servers', 'LSP workflows', 'Quality gates', 'CI/CD', 'Evidence-driven automation'],
  applied_ai_client_delivery: ['Applied AI', 'LLM workflows', 'Human review gates', 'Client delivery', 'Full-stack architecture', 'Data workflows'],
  product_full_stack: ['Full-stack product engineering', 'TypeScript/React/Node', 'API design', 'PostgreSQL', 'Real-time systems', 'Customer workflows'],
  data_analytics: ['Data pipelines', 'Analytics', 'SQL', 'Decision-support systems', 'Python modeling', 'Evidence-based reporting'],
  solutions_forward_deployed: ['Client-facing engineering', 'Rapid prototyping', 'System integrations', 'Applied AI', 'Product delivery', 'Technical communication'],
  sports_analytics: ['Basketball and sports analytics', 'Player-evaluation modeling', 'Python/R data pipelines', 'Full-stack product delivery', 'SQL and relational data', 'Decision-support systems'],
};

const GENERATED_RESUME_COMPACT_CSS = `<style id="career-ops-generated-compact">
.header{margin-bottom:12px}.section{margin-bottom:10px}.section-title{padding-bottom:3px;margin-bottom:6px}
.summary-text{line-height:1.35}.competencies-grid{gap:4px}.competency-tag{padding:2px 7px}
.job{margin-bottom:8px}.job-role{margin-bottom:3px}.job ul{margin-top:3px}.job li{line-height:1.3;margin-bottom:2px}
.project{margin-bottom:6px}.project-desc{margin-top:2px;line-height:1.25}.project-tech{margin-top:2px}
.edu-desc{line-height:1.25}.skills-grid{gap:3px 10px}
</style>`;

const RESUME_PROJECT_SUMMARIES = {
  tenure: 'Built a pilot-ready organizational-intelligence platform that turns specialist knowledge into reviewed SOPs, cited Q&A, and process reports.',
  bidcamp: 'Built a live closed-beta government-contracting SaaS with Claude-powered RFP analysis, proposal drafting, and procurement workflows.',
  'quality runner': 'Built and published a local-first Python CLI/MCP quality orchestrator with evidence-backed findings and ordered remediation plans.',
  'pre cr suite': 'Built a TypeScript monorepo with shared coverage evaluation across VS Code, Neovim, and a headless CLI via LSP.',
  aios: 'Designed a local-first Python/SQLite operating layer for agent sessions, project memory, and human-reviewed automation artifacts.',
  terrace: 'Published a Node CLI for spec-driven, test-governed AI-assisted development with deterministic quality gates.',
  tmcp: 'Built an MCP server that compiles task-specific skill and evidence packets from scattered agent instructions.',
  'dsci proj': 'Built a reproducible survival-analysis pipeline and triage dashboard modeling GitHub issue-resolution risk.',
  'bbdse courtiq': 'Built a basketball analytics and simulator product suite with modeling, decision-support, and user-facing workflows.',
  hoopscout: 'Built a private-beta recruiting-intelligence workflow with coach-specific fit weighting, ranked school signals, and trust controls.',
  'court vision': 'Built a basketball IQ platform with lessons, simulations, and real-time product workflows.',
  crimclock: 'Built a legal-time intelligence platform with explainable procedural timing calculations and decision-support outputs.',
  remodelvision: 'Built a working AI remodeling visualization and rough-cost-estimation pipeline with a Next.js product surface.',
  soundscape: 'Built a full-stack music social platform with Next.js, tRPC, Prisma, and web/mobile product surfaces.',
  'forward automations': 'Delivered client-facing MVPs and automation systems across healthcare, architecture, live events, and startup marketing.',
  fantasy: 'Built a local-first dynasty fantasy-football intelligence app with a trade engine, dashboards, draft room, and ingestion workflows.',
};

/** @param {string} value */
function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {string} value */
function normalizedKey(value) {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @param {string} value */
function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** @param {string} value */
function stripMarkdown(value) {
  return normalize(String(value || '')
    .replace(/\*\*/g, '')
    .replace(/__|`/g, '')
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1'));
}

/** @param {string} value @param {number} limit */
function compactText(value, limit = 220) {
  const text = normalize(value);
  if (text.length <= limit) return text;
  const firstSentence = text.match(/^(.{40,}?\.)\s/);
  if (firstSentence && firstSentence[1].length <= limit) return firstSentence[1];
  return `${text.slice(0, Math.max(0, limit - 3)).replace(/\s+\S*$/, '')}...`;
}

/** @param {Record<string, unknown>} project */
function resumeProjectDescription(project) {
  return RESUME_PROJECT_SUMMARIES[normalizedKey(String(project.name || ''))]
    || compactText(String(project.description || ''), 130);
}

/** @param {string} value */
function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

/** @param {string} file */
function readRootFile(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

function sourceHash() {
  return hash(SOURCE_FILES.map((file) => `${file}\n${readRootFile(file)}`).join('\n'));
}

/** @param {Record<string, unknown>} item */
export function jobHash(item) {
  return hash([
    item.id,
    item.company,
    item.title,
    item.location,
    item.lane,
    item.description,
    item.applyUrl || item.canonicalUrl,
  ].map((value) => normalize(String(value || ''))).join('\n'));
}

/** @param {string} value */
function slug(value) {
  return normalizedKey(value).replace(/\s+/g, '-').slice(0, 80) || 'application';
}

/** @param {Record<string, unknown>} item @param {{ outputRoot?: string }} [options] */
export function artifactPathsForItem(item, options = {}) {
  const jd = jobHash(item);
  const directory = path.join(options.outputRoot || DEFAULT_ARTIFACT_ROOT, `${slug(`${item.company || 'company'} ${item.title || 'role'}`)}-${jd.slice(0, 12)}`);
  return {
    directory,
    resumeMarkdown: path.join(directory, 'resume.md'),
    resumeHtml: path.join(directory, 'resume.html'),
    resumePdf: path.join(directory, 'resume.pdf'),
    coverLetterText: path.join(directory, 'cover-letter.txt'),
    coverLetterHtml: path.join(directory, 'cover-letter.html'),
    coverLetterPdf: path.join(directory, 'cover-letter.pdf'),
    manifest: path.join(directory, 'manifest.json'),
  };
}

/** @param {string} markdown */
function markdownSections(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      current = { level: match[1].length, title: stripMarkdown(match[2]), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

/** @param {string} title */
function sectionKey(title) {
  return normalizedKey(title).replace(/ and /g, ' & ');
}

/** @param {Array<{title:string, lines:string[]}>} sections @param {string} wanted */
function findSection(sections, wanted) {
  const key = normalizedKey(wanted);
  return sections.find((section) => normalizedKey(section.title) === key)
    || sections.find((section) => normalizedKey(section.title).includes(key));
}

/** @param {Array<{title:string, lines:string[]}>} sections */
function parseExperience(sections) {
  const section = findSection(sections, 'WORK EXPERIENCE');
  if (!section) return [];
  const lines = section.lines;
  const jobs = [];
  for (let index = 0; index < lines.length;) {
    if (!normalize(lines[index])) { index += 1; continue; }
    const role = normalize(lines[index]);
    let companyIndex = index + 1;
    while (companyIndex < lines.length && !normalize(lines[companyIndex])) companyIndex += 1;
    const companyLine = normalize(lines[companyIndex]);
    if (!companyLine.includes('|')) { index += 1; continue; }
    const [company, period] = companyLine.split('|').map(normalize);
    const bullets = [];
    index = companyIndex + 1;
    while (index < lines.length) {
      if (!normalize(lines[index])) { index += 1; continue; }
      const maybeRole = normalize(lines[index]);
      let maybeCompanyIndex = index + 1;
      while (maybeCompanyIndex < lines.length && !normalize(lines[maybeCompanyIndex])) maybeCompanyIndex += 1;
      if (maybeCompanyIndex < lines.length && normalize(lines[maybeCompanyIndex]).includes('|')) break;
      bullets.push(stripMarkdown(maybeRole.replace(/^[-*]\s+/, '')));
      index += 1;
    }
    jobs.push({ role, company, period, bullets });
  }
  return jobs;
}

/** @param {Array<{title:string, lines:string[]}>} sections */
function parseCvProjects(sections) {
  const section = findSection(sections, 'PROJECTS');
  if (!section) return [];
  const lines = section.lines;
  const projects = [];
  for (let index = 0; index < lines.length;) {
    if (!normalize(lines[index])) { index += 1; continue; }
    const heading = normalize(lines[index]);
    if (!heading.includes('|')) { index += 1; continue; }
    const [name, badge] = heading.split('|').map(normalize);
    index += 1;
    const descriptions = [];
    while (index < lines.length) {
      if (!normalize(lines[index])) { index += 1; continue; }
      if (normalize(lines[index]).includes('|')) break;
      descriptions.push(stripMarkdown(lines[index].replace(/^[-*]\s+/, '')));
      index += 1;
    }
    projects.push({ name, badge, description: descriptions.join(' ') });
  }
  return projects;
}

/** @param {string} digest */
function parseDigestEntries(digest) {
  const sections = markdownSections(digest);
  const entries = [];
  for (const section of sections.filter((candidate) => candidate.level >= 3)) {
    const content = section.lines
      .map((line) => stripMarkdown(line.replace(/^[-*]\s+/, '')))
      .filter(Boolean);
    if (content.length) entries.push({ title: section.title, lines: content });
  }
  for (const line of String(digest || '').split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+`([^`]+)`\s*[—-]\s*(.+)$/);
    if (match) entries.push({ title: stripMarkdown(match[1]), lines: [stripMarkdown(match[2])] });
  }
  return entries;
}

/** @param {string} name @param {string} title */
function matchesProject(name, title) {
  const requested = normalizedKey(name);
  const aliases = PROJECT_ALIASES[requested] || [requested];
  const candidate = normalizedKey(title);
  return aliases.some((alias) => candidate.includes(normalizedKey(alias)) || normalizedKey(alias).includes(candidate));
}

/** @param {string} name @param {Array<Record<string, string>>} cvProjects @param {Array<Record<string, unknown>>} digestEntries */
function selectProject(name, cvProjects, digestEntries) {
  const cv = cvProjects.find((project) => matchesProject(name, project.name));
  if (cv) return { requestedName: name, name: cv.name, badge: cv.badge, description: cv.description, source: 'cv.md' };
  const digest = digestEntries.find((entry) => matchesProject(name, String(entry.title || '')));
  if (!digest) return { requestedName: name, missing: true };
  const lines = digest.lines.map(String).filter(Boolean);
  const publicSafe = lines.find((line) => /public-safe framing/i.test(line));
  const stack = lines.find((line) => /^stack:/i.test(line));
  const body = lines.filter((line) => !/^stack:/i.test(line) && !/public-safe framing/i.test(line)).slice(0, 2);
  return {
    requestedName: name,
    name: stripMarkdown(String(digest.title || name)).split(' — ')[0].split(' - ')[0].trim(),
    badge: publicSafe ? publicSafe.replace(/^public-safe framing:\s*/i, '').replace(/;.*$/, '') : '',
    description: body.join(' '),
    tech: stack ? stack.replace(/^stack:\s*/i, '') : '',
    source: 'article-digest.md',
  };
}

/** @param {Record<string, unknown>} profile @param {string} lane */
function projectNamesForLane(profile, lane) {
  const configured = profile?.search_strategy?.lane_matrix?.[lane]?.resume_projects
    || profile?.target_roles?.lane_matrix?.[lane]?.resume_projects;
  return Array.isArray(configured) && configured.length ? configured.map(String) : (FALLBACK_PROJECTS[lane] || FALLBACK_PROJECTS.backend_ai_platform);
}

/** @param {Record<string, unknown>} item @param {Record<string, unknown>} profile */
export function laneForItem(item, profile) {
  if (typeof item.lane === 'string' && item.lane) return item.lane;
  const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  if (/\bsport|basketball|football|baseball|hockey|soccer|\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bathletic|\bfront office\b/i.test(text)) return 'sports_analytics';
  if (/data|analytics|sql|warehouse|pipeline/.test(text)) return 'data_analytics';
  if (/client|solutions|forward|implementation|consult/.test(text)) return 'solutions_forward_deployed';
  if (/frontend|full[- ]stack|product/.test(text)) return 'product_full_stack';
  if (/developer tools|platform|infrastructure|quality|cli|lsp/.test(text)) return 'developer_tools_infrastructure';
  if (/ai|llm|machine learning|applied/.test(text)) return 'applied_ai_client_delivery';
  return profile?.search_strategy?.lane_order?.[0]
    || profile?.target_roles?.lane_order?.[0]
    || 'backend_ai_platform';
}

/** @param {string} jobDescription @param {string} evidence */
function matchedKeywords(jobDescription, evidence) {
  return TARGET_KEYWORDS
    .filter(([, pattern]) => pattern.test(jobDescription) && pattern.test(evidence))
    .map(([label]) => label);
}

/** @param {string} lane @param {string[]} matched @param {string} evidence */
function competenciesForLane(lane, matched, evidence) {
  const base = LANE_COMPETENCIES[lane] || LANE_COMPETENCIES.backend_ai_platform;
  const supported = base.filter((value) => {
    const tokens = value.toLowerCase().split(/[\s/]+/).filter((token) => token.length > 2);
    return tokens.some((token) => evidence.toLowerCase().includes(token)) || /client|product|analytics|backend|tooling|workflow|testing|delivery/i.test(value);
  });
  return [...new Set([...matched, ...supported])].slice(0, 6);
}

/** @param {Array<Record<string, unknown>>} jobs @param {string} description @param {string} lane */
function tailorExperience(jobs, description, lane) {
  const signal = `${description} ${LANE_PHRASES[lane] || ''}`.toLowerCase();
  return jobs.map((job) => {
    const company = String(job.company || '').toLowerCase();
    const cap = company.includes('deepr') ? 1 : company.includes('amazon') ? 3 : company.includes('forward automations') ? 3 : 2;
    const bullets = Array.isArray(job.bullets) ? job.bullets : [];
    const ranked = bullets.map((bullet, index) => ({
      bullet,
      index,
      score: String(bullet).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2 && signal.includes(token)).length,
    })).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, cap).sort((left, right) => left.index - right.index);
    return { ...job, bullets: ranked.map((entry) => entry.bullet) };
  });
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {string} lane @param {string[]} projects @param {string[]} keywords */
function buildSummary(profile, item, lane, projects, keywords) {
  const focus = keywords.slice(0, 2).join(' and ') || LANE_PHRASES[lane] || 'backend and product systems';
  const projectText = projects.slice(0, 3).join(', ');
  const role = normalize(String(item.title || 'software engineering'));
  return `Software engineer targeting ${role} roles, with three Amazon SDE internships and CTO-level client delivery experience. Builds ${focus} across ${projectText}. Available full-time now.`;
}

/** @param {Array<Record<string, string>>} jobs */
function experienceMarkdown(jobs) {
  return jobs.map((job) => [
    job.role,
    `${job.company} | ${job.period}`,
    ...job.bullets,
    '',
  ].join('\n')).join('\n').trim();
}

/** @param {Array<Record<string, unknown>>} projects */
function projectsMarkdown(projects) {
  return projects.filter((project) => !project.missing).map((project) => [
    `${project.name} | ${project.badge || 'Selected project'}`,
    resumeProjectDescription(project),
    project.tech ? `Stack: ${project.tech}` : '',
    '',
  ].filter((line, index) => line || index === 0).join('\n')).join('\n').trim();
}

/** @param {string[]} lines */
function skillsMarkdown(lines, competencies) {
  const existing = lines.filter((line) => normalize(line));
  const targeted = competencies.length ? `Targeted strengths: ${competencies.join(', ')}` : '';
  return [...existing, targeted].filter(Boolean).join('\n');
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {string} lane @param {Array<Record<string, unknown>>} projects @param {string[]} competencies @param {Array<Record<string, unknown>>} jobs @param {string[]} education @param {string[]} skills */
export function buildResumeMarkdown({ profile, item, lane, projects, competencies, jobs, education, skills }) {
  const evidence = projects.filter((project) => !project.missing).map((project) => project.description).join(' ');
  const keywords = competencies.filter((value) => evidence.toLowerCase().includes(value.toLowerCase().split('/')[0]));
  const sections = [
    'JAKYE AMOS',
    '',
    `${profile?.candidate?.email || 'jakyejobs@gmail.com'} | ${profile?.candidate?.phone || ''} | ${profile?.candidate?.location || 'Buffalo, NY'}`,
    `${profile?.candidate?.linkedin || ''} | ${profile?.candidate?.github || ''} | ${profile?.candidate?.portfolio_url || ''}`,
    '',
    '## PROFESSIONAL SUMMARY',
    buildSummary(profile, item, lane, projects.filter((project) => !project.missing).map((project) => project.name), keywords),
    '',
    '## SKILLS',
    skillsMarkdown(skills, competencies),
    '',
    '## WORK EXPERIENCE',
    experienceMarkdown(jobs),
    '',
    '## PROJECTS',
    projectsMarkdown(projects),
    '',
    '## EDUCATION',
    education.filter((line) => normalize(line)).join('\n'),
    '',
  ];
  return `${sections.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {string} lane @param {Array<Record<string, unknown>>} projects @param {string[]} competencies */
export function buildCoverLetter({ profile, item, lane, projects, competencies }) {
  const company = normalize(String(item.company || 'your team'));
  const title = normalize(String(item.title || 'software engineering role'));
  const focusValues = competencies.slice(0, 3);
  const focus = focusValues.length === 3
    ? `${focusValues[0]}, ${focusValues[1]}, and ${focusValues[2]}`
    : focusValues.join(' and ') || LANE_PHRASES[lane] || 'backend and product systems';
  const selected = projects.filter((project) => !project.missing).slice(0, 2);
  const achievementSentences = selected.map((project) => {
    const description = String(project.description || '');
    const firstSentence = description.match(/^(.+?[.!?])(?:\s|$)/)?.[1] || description;
    return `${project.name}: ${compactText(firstSentence, 280)}`;
  }).filter(Boolean);
  const opening = `What caught my attention about the ${title} role at ${company} is the combination of ${focus}. That is the intersection I have been moving toward: taking an unclear problem, finding the right system boundary, and shipping something people can use.`;
  const profileIntro = `As CTO of Forward Automations, I have spent the last few years turning loosely defined client workflows into working software on short timelines. That includes a Cleveland Clinic clinical-coaching MVP delivered in two weeks, productivity software for a Cleveland architecture firm, and AI marketing automation for startup clients.`;
  const problemParagraph = `I would bring the engineering foundation of three Amazon SDE internships, the product judgment that comes from client delivery, and a practical approach to reliability. I like making data contracts, APIs, review points, tests, and operational limits explicit before a system becomes difficult to change.`;
  const closing = `I would welcome the chance to walk through the systems behind these projects and discuss where I could contribute quickly at ${company}. Thank you for your time.`;
  const text = [
    `Dear Hiring Team,`,
    '',
    opening,
    '',
    profileIntro,
    '',
    ...achievementSentences.map((sentence) => `- ${sentence}`),
    '',
    problemParagraph,
    '',
    closing,
    '',
    'Best,',
    profile?.candidate?.full_name || 'Jakye Amos',
  ].join('\n');
  return {
    text,
    opening,
    profileIntro,
    achievementSentences,
    problemParagraph,
    closing,
    company,
    title,
  };
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {string} lane @param {string[]} competencies */
function buildResumeHtml({ profile, item, lane, summary, competencies, jobs, projects, education, skills }) {
  const candidate = profile?.candidate || {};
  const template = readRootFile('templates/resume-template.html');
  const htmlJobs = jobs.map((job) => `<div class="job"><div class="job-header"><span class="job-company">${htmlEscape(job.company)}</span><span class="job-period">${htmlEscape(job.period)}</span></div><div class="job-role">${htmlEscape(job.role)}</div><ul>${job.bullets.map((bullet) => `<li>${htmlEscape(bullet)}</li>`).join('')}</ul></div>`).join('\n');
  const htmlProjects = projects.filter((project) => !project.missing).map((project) => `<div class="project"><div><span class="project-title">${htmlEscape(project.name)}</span><span class="project-badge">${htmlEscape(project.badge || 'Selected project')}</span></div><div class="project-desc">${htmlEscape(resumeProjectDescription(project))}</div>${project.tech ? `<div class="project-tech">Stack: ${htmlEscape(compactText(project.tech, 140))}</div>` : ''}</div>`).join('\n');
  const htmlEducation = `<div class="edu-item"><div class="edu-header"><span class="edu-title">B.A. in Computer Science</span></div><div class="edu-org">Case Western Reserve University, Cleveland, OH</div><div class="edu-desc">Minors: Artificial Intelligence, Applied Data Science, Statistics | Available for full-time work immediately</div></div>`;
  const htmlSkills = skills.filter((line) => normalize(line) && !/English \(Fluent\)/i.test(line)).slice(0, 2).map((line) => {
    const [category, ...rest] = line.split(':');
    return `<div class="skill-item"><span class="skill-category">${htmlEscape(category)}:</span> ${htmlEscape(rest.join(':').trim())}</div>`;
  }).join('\n');
  const values = {
    LANG: 'en',
    PAGE_WIDTH: /\b(canada|europe|uk|germany|france|ireland|netherlands|spain|sweden|switzerland)\b/i.test(String(item.location || '')) ? '210mm' : '8.5in',
    PHOTO: '',
    NAME: candidate.full_name || 'Jakye Amos',
    PHONE: candidate.phone || '',
    EMAIL: candidate.email || '',
    LINKEDIN_URL: candidate.linkedin || '',
    LINKEDIN_DISPLAY: String(candidate.linkedin || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    GITHUB_URL: candidate.github || '',
    GITHUB_DISPLAY: String(candidate.github || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    PORTFOLIO_URL: candidate.portfolio_url || '',
    PORTFOLIO_DISPLAY: String(candidate.portfolio_url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    LOCATION: candidate.location || 'Buffalo, NY',
    SECTION_SUMMARY: 'Professional Summary',
    SUMMARY_TEXT: htmlEscape(summary),
    SECTION_COMPETENCIES: 'Core Competencies',
    COMPETENCIES: competencies.map((value) => `<span class="competency-tag">${htmlEscape(value)}</span>`).join('\n'),
    SECTION_EXPERIENCE: 'Work Experience',
    EXPERIENCE: htmlJobs,
    SECTION_PROJECTS: 'Projects',
    PROJECTS: htmlProjects,
    SECTION_EDUCATION: 'Education',
    EDUCATION: htmlEducation,
    SECTION_SKILLS: 'Skills',
    SKILLS: htmlSkills,
  };
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined ? '' : String(value);
  });
  return rendered.replace('</head>', `${GENERATED_RESUME_COMPACT_CSS}</head>`);
}

/** @param {Record<string, unknown>} profile @param {Record<string, unknown>} item @param {string} lane @param {Array<Record<string, unknown>>} projects @param {Record<string, unknown>} cover */
function buildCoverLetterHtml({ profile, item, lane, projects, cover }) {
  const template = readRootFile('templates/cover-letter-template.html');
  const candidate = profile?.candidate || {};
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const achievements = cover.achievementSentences.map((sentence) => `<li>${htmlEscape(sentence)}</li>`).join('');
  const values = {
    NAME: candidate.full_name || 'Jakye Amos',
    CONTACT_LINE: `${candidate.email || ''} | ${candidate.linkedin || ''} | ${candidate.portfolio_url || ''}`,
    CREDENTIALS_BLOCK: `<div class="credentials">3x Amazon SDE intern | CTO, Forward Automations | ${htmlEscape(LANE_PHRASES[lane] || 'backend and product systems')}</div>`,
    ROLE_TITLE: htmlEscape(cover.title),
    DATELINE: date,
    GREETING_BLOCK: '<p class="greeting">Dear Hiring Team,</p>',
    OPENING: htmlEscape(cover.opening),
    PROFILE_INTRO: htmlEscape(cover.profileIntro),
    ACHIEVEMENTS_BLOCK: achievements ? `<ul class="achievements">${achievements}</ul>` : '',
    PROBLEMS_BLOCK: `<p>${htmlEscape(cover.problemParagraph)}</p>`,
    CLOSING_BLOCK: `<p>${htmlEscape(cover.closing)}</p>`,
    LANGUAGE_CLOSING_BLOCK: '<p class="language-closing">Best,</p><p>Jakye Amos</p>',
    FOOTNOTES_BLOCK: '',
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined ? '' : String(value);
  });
}

/** @param {string} file */
function pageCount(file) {
  const result = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const match = String(result.stdout || '').match(/^Pages:\s+(\d+)/m);
  return match ? Number(match[1]) : null;
}

/** @param {string} text @param {string} company @param {string} title */
function validateCoverText(text, company, title) {
  const errors = [];
  if (text.length < 300) errors.push('cover letter is too short to be useful');
  if (text.length > 5000) errors.push('cover letter is longer than the one-page target');
  if (/\{\{[^}]+\}\}/.test(text)) errors.push('cover letter contains unresolved template placeholders');
  if (company && !text.toLowerCase().includes(company.toLowerCase())) errors.push('cover letter does not name the target company');
  if (title && !text.toLowerCase().includes(title.toLowerCase())) errors.push('cover letter does not name the target role');
  return errors;
}

/** @param {Record<string, unknown>} item @param {{ outputRoot?: string, renderPdf?: boolean, includeCoverLetter?: boolean, force?: boolean, fetchJobDescription?: boolean }} [options] */
export async function generateApplicationArtifacts(item, options = {}) {
  const cv = readRootFile('cv.md');
  const digest = readRootFile('article-digest.md');
  const profile = /** @type {Record<string, unknown>} */ (loadYaml(readRootFile('config/profile.yml')) || {});
  let description = normalize(String(item.description || ''));
  let descriptionSource = description.length >= 120 ? 'queue' : 'missing';
  let descriptionEndpoint = '';
  if (description.length < 120 && options.fetchJobDescription !== false && item.applyUrl) {
    const atsResult = await fetchAtsJobDescription(String(item.applyUrl));
    if (atsResult) {
      description = atsResult.description;
      descriptionSource = 'ats-api';
      descriptionEndpoint = atsResult.endpoint;
    }
    try {
      if (description.length < 120) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          const response = await fetch(String(item.applyUrl), { signal: controller.signal, redirect: 'follow' });
          if (response.ok) {
            const html = await response.text();
            const fetched = normalize(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
            if (fetched.length > description.length) {
              description = fetched.slice(0, 40_000);
              descriptionSource = 'live-posting';
              descriptionEndpoint = '';
            }
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch { /* the queue records a missing/short description below */ }
  }
  if (!description) return { ok: false, reason: 'job description is missing; cannot tailor artifacts safely' };
  if (description.length < 120) return { ok: false, reason: 'job description is too short to tailor artifacts safely' };
  const effectiveItem = { ...item, description };
  const output = artifactPathsForItem(effectiveItem, options);
  const currentSourceHash = sourceHash();
  const effectiveJobHash = jobHash(effectiveItem);
  if (!options.force && existsSync(output.manifest)) {
    try {
      const cached = JSON.parse(readFileSync(output.manifest, 'utf8'));
      const needsPdf = options.renderPdf !== false;
      const needsCoverLetter = options.includeCoverLetter !== false;
      const requiredPdfPaths = [cached.resume?.pdfPath, ...(needsCoverLetter ? [cached.coverLetter?.pdfPath] : [])];
      const filesReady = requiredPdfPaths.every((file) => !needsPdf || (file && existsSync(file)));
      const statusReady = cached.status === 'ready' || (options.renderPdf === false && cached.status === 'unrendered');
      if (cached.jdHash === effectiveJobHash && cached.sourceHash === currentSourceHash && statusReady && filesReady) {
        return {
          ok: true,
          cached: true,
          ...cached,
          jobDescription: description,
          resumeMarkdown: cached.resume?.markdownPath || '',
          resumeHtml: cached.resume?.htmlPath || '',
          resumePdf: cached.resume?.pdfPath || '',
          coverLetterHtml: cached.coverLetter?.htmlPath || '',
          coverLetterPdf: cached.coverLetter?.pdfPath || '',
          coverLetterText: cached.coverLetter?.textPath || '',
          manifestPath: output.manifest,
        };
      }
    } catch { /* stale or partial artifacts are rebuilt below */ }
  }

  const sections = markdownSections(cv);
  const jobs = parseExperience(sections);
  const cvProjects = parseCvProjects(sections);
  const digestEntries = parseDigestEntries(digest);
  const lane = laneForItem(effectiveItem, profile);
  const requestedProjects = projectNamesForLane(profile, lane);
  const projects = requestedProjects.map((name) => selectProject(name, cvProjects, digestEntries));
  const usableProjects = projects.filter((project) => !project.missing && project.description);
  if (usableProjects.length < 2) {
    return { ok: false, reason: `only ${usableProjects.length} verified project(s) were found for lane ${lane}; refusing to generate a thin or invented resume` };
  }
  const evidence = `${cv}\n${digest}`;
  const keywords = matchedKeywords(description, evidence);
  const competencies = competenciesForLane(lane, keywords, evidence);
  const tailoredJobs = tailorExperience(jobs, description, lane);
  const summary = buildSummary(profile, effectiveItem, lane, usableProjects.map((project) => project.name), keywords);
  const educationSection = findSection(sections, 'EDUCATION');
  const skillsSection = findSection(sections, 'SKILLS');
  const education = educationSection?.lines || [];
  const skills = skillsSection?.lines || [];
  const resumeMarkdown = buildResumeMarkdown({ profile, item: effectiveItem, lane, projects: usableProjects, competencies, jobs: tailoredJobs, education, skills });
  const resumeHtml = buildResumeHtml({ profile, item: effectiveItem, lane, summary, competencies, jobs: tailoredJobs, projects: usableProjects, education, skills });
  const cover = buildCoverLetter({ profile, item: effectiveItem, lane, projects: usableProjects, competencies });
  const coverErrors = options.includeCoverLetter === false ? [] : validateCoverText(cover.text, String(item.company || ''), String(item.title || ''));
  if (coverErrors.length) return { ok: false, reason: coverErrors.join('; ') };

  mkdirSync(output.directory, { recursive: true });
  writeFileSync(output.resumeMarkdown, resumeMarkdown, 'utf8');
  writeFileSync(output.resumeHtml, resumeHtml, 'utf8');
  if (options.includeCoverLetter !== false) {
    writeFileSync(output.coverLetterText, cover.text, 'utf8');
    writeFileSync(output.coverLetterHtml, buildCoverLetterHtml({ profile, item: effectiveItem, lane, projects: usableProjects, cover }), 'utf8');
  }

  let resumePdf = '';
  let coverLetterPdf = '';
  let resumeAudit = { passed: true, errors: [], warnings: [] };
  let coverPageCount = null;
  if (options.renderPdf !== false) {
    await renderHtmlToPdf(resumeHtml, output.resumePdf, { format: /\b(canada|europe|uk|germany|france|ireland|netherlands|spain|sweden|switzerland)\b/i.test(String(item.location || '')) ? 'a4' : 'letter', baseDir: output.directory, inputPath: output.resumeHtml });
    resumePdf = output.resumePdf;
    resumeAudit = auditResume({ cvPath: output.resumeMarkdown, htmlPath: output.resumeHtml, pdfPath: output.resumePdf, tier: 'standard' });
    if (!resumeAudit.passed) return { ok: false, reason: `generated resume failed audit: ${resumeAudit.errors.map((error) => error.detail).join('; ')}` };
    if (options.includeCoverLetter !== false) {
      await renderHtmlToPdf(readFileSync(output.coverLetterHtml, 'utf8'), output.coverLetterPdf, { format: 'letter', baseDir: output.directory, inputPath: output.coverLetterHtml });
      coverLetterPdf = output.coverLetterPdf;
      coverPageCount = pageCount(output.coverLetterPdf);
      if (coverPageCount !== null && coverPageCount > 1) return { ok: false, reason: `generated cover letter is ${coverPageCount} pages; one page is required` };
    }
  }

  const manifest = {
    schemaVersion: 1,
    status: options.renderPdf === false ? 'unrendered' : 'ready',
    generatedAt: new Date().toISOString(),
    applicationKey: `${normalizedKey(String(item.company || ''))}::${normalizedKey(String(item.title || ''))}`,
    job: {
      id: item.id || null,
      company: item.company || '',
      title: item.title || '',
      location: item.location || '',
      applyUrl: item.applyUrl || item.canonicalUrl || '',
      descriptionSource,
      ...(descriptionEndpoint ? { descriptionEndpoint } : {}),
    },
    lane,
    jdHash: effectiveJobHash,
    sourceHash: currentSourceHash,
    sourceFiles: SOURCE_FILES,
    selectedProjects: usableProjects.map((project) => ({ name: project.name, source: project.source, badge: project.badge || '' })),
    missingProjects: projects.filter((project) => project.missing).map((project) => project.requestedName),
    matchedKeywords: keywords,
    competencies,
    resume: {
      markdownPath: output.resumeMarkdown,
      htmlPath: output.resumeHtml,
      pdfPath: resumePdf,
      audit: resumeAudit,
    },
    coverLetter: options.includeCoverLetter === false ? null : {
      textPath: output.coverLetterText,
      htmlPath: output.coverLetterHtml,
      pdfPath: coverLetterPdf,
      pageCount: coverPageCount,
    },
  };
  writeFileSync(output.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    cached: false,
    ...manifest,
    jobDescription: description,
    resumeMarkdown: output.resumeMarkdown,
    resumeHtml: output.resumeHtml,
    resumePdf,
    coverLetterHtml: output.coverLetterHtml,
    coverLetterPdf,
    coverLetterText: options.includeCoverLetter === false ? '' : output.coverLetterText,
    manifestPath: output.manifest,
  };
}

/** @param {Record<string, unknown>} item @param {{ outputRoot?: string }} [options] */
export function inspectArtifactCache(item, options = {}) {
  const output = artifactPathsForItem(item, options);
  if (!existsSync(output.manifest)) return { status: 'will-generate', manifestPath: output.manifest };
  try {
    const manifest = JSON.parse(readFileSync(output.manifest, 'utf8'));
    const current = jobHash(item);
    const coverReady = !manifest.coverLetter || existsSync(manifest.coverLetter.pdfPath || '');
    const fresh = manifest.status === 'ready' && manifest.jdHash === current && manifest.sourceHash === sourceHash() && existsSync(manifest.resume?.pdfPath || '') && coverReady;
    return { status: fresh ? 'ready' : 'stale', manifestPath: output.manifest, lane: manifest.lane, selectedProjects: manifest.selectedProjects || [] };
  } catch {
    return { status: 'stale', manifestPath: output.manifest };
  }
}

function findQueueItem(id) {
  const file = path.join(ROOT, 'data', 'job-queue.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const item = (state.items || []).find((candidate) => String(candidate.id) === String(id));
  if (!item) throw new Error(`queue item not found: ${id}`);
  return item;
}

if (import.meta.url === new URL(process.argv[1] || '', 'file:').href) {
  const args = process.argv.slice(2);
  const command = args[0] || 'build';
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : '';
  };
  if (command !== 'build') {
    console.error('Usage: node apply/application-artifacts.mjs build --queue-id <id> [--force] [--no-pdf] [--no-cover]');
    process.exitCode = 1;
  } else {
    try {
      const item = findQueueItem(valueAfter('--queue-id'));
      const result = await generateApplicationArtifacts(item, {
        force: args.includes('--force'),
        renderPdf: !args.includes('--no-pdf'),
        includeCoverLetter: !args.includes('--no-cover'),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 2;
    } catch (error) {
      console.error(`Artifact generation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
