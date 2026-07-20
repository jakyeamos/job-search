#!/usr/bin/env node

// Renders cv.md's full (non-tailored) content to a PDF, reusing the same
// ATS-safe rendering pipeline (font inlining, ligature fixes, page-break
// rules) that apply/application-artifacts.mjs uses for tailored one-page
// resumes, and the same visual language as templates/cv-template.html.
// Unlike the tailored generator this renders every project/job/section in
// cv.md verbatim — no lane selection, no truncation.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHtmlToPdf } from './generate-pdf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripMarkdown(value) {
  return normalize(String(value || '')
    .replace(/\*\*/g, '')
    .replace(/__|`/g, '')
    .replace(/\[[^\]]+\]\(([^)]+)\)/g, '$1'));
}

function normalizedKey(value) {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

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

function findSection(sections, wanted) {
  const key = normalizedKey(wanted);
  return sections.find((section) => normalizedKey(section.title) === key)
    || sections.find((section) => normalizedKey(section.title).includes(key));
}

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
    let tech = '';
    const stackIndex = descriptions.findIndex((line) => /^Stack:\s*/i.test(line));
    if (stackIndex !== -1) {
      tech = descriptions[stackIndex].replace(/^Stack:\s*/i, '');
      descriptions.splice(stackIndex, 1);
    }
    projects.push({ name, badge, description: descriptions.join(' '), tech });
  }
  return projects;
}

function bulletLines(section) {
  if (!section) return [];
  return section.lines
    .map((line) => normalize(line))
    .filter(Boolean)
    .map((line) => stripMarkdown(line.replace(/^[-*]\s+/, '')));
}

function parseOpenSource(sections) {
  const section = findSection(sections, 'OPEN-SOURCE & PUBLISHED DEVELOPER TOOLING');
  if (!section) return [];
  return bulletLines(section).map((line) => {
    // Split on the em-dash separator only — a plain hyphen can legitimately
    // appear inside a product name (e.g. "ESLint Anti-Slop", "Pre-CR Suite").
    const match = line.match(/^(.+?)\s*—\s*(.+)$/);
    return match ? { name: match[1], description: match[2] } : { name: '', description: line };
  });
}

function parseEducation(sections) {
  const section = findSection(sections, 'EDUCATION');
  if (!section) return null;
  const lines = section.lines.map(normalize).filter(Boolean);
  if (!lines.length) return null;
  const [org = '', detail = '', extra = ''] = lines;
  const [degree = '', ...rest] = detail.split('|').map(normalize);
  return { org, degree, subtitle: rest.join(' | '), extra };
}

function parseContactHeader(cv) {
  const lines = cv.split(/\r?\n/);
  const preHeading = [];
  for (const line of lines) {
    if (/^\s{0,3}#{1,6}\s+/.test(line)) break;
    preHeading.push(line);
  }
  const nonEmpty = preHeading.map(normalize).filter(Boolean);
  const name = nonEmpty[0] || 'Jakye Amos';
  // Keep cv.md's own line breaks (contact info line, then links line) instead
  // of flattening into one flex row — with 8 tokens a single row wraps
  // mid-sequence and leaves a stray "|" separator dangling at the line start.
  const rows = nonEmpty.slice(1).map((line) => line.split('|').map(normalize).filter(Boolean));
  return { name, rows };
}

function contactLinkHtml(token) {
  const text = htmlEscape(token);
  if (token.includes('@')) return `<a href="mailto:${htmlEscape(token)}">${text}</a>`;
  if (/^[\d+][\d\s()-]{6,}$/.test(token)) return `<a href="tel:${htmlEscape(token.replace(/[^\d+]/g, ''))}">${text}</a>`;
  if (/^(https?:\/\/|[\w-]+\.(com|app|io|org|net|dev)\b)/i.test(token)) {
    const href = /^https?:\/\//i.test(token) ? token : `https://${token}`;
    return `<a href="${htmlEscape(href)}">${text}</a>`;
  }
  return `<span>${text}</span>`;
}

function jobsHtml(jobs) {
  return jobs.map((job) => `<div class="job">
    <div class="job-header"><span class="job-company">${htmlEscape(job.company)}</span><span class="job-period">${htmlEscape(job.period)}</span></div>
    <div class="job-role">${htmlEscape(job.role)}</div>
    <ul>${job.bullets.map((bullet) => `<li>${htmlEscape(bullet)}</li>`).join('')}</ul>
  </div>`).join('\n');
}

function projectsHtml(projects) {
  return projects.map((project) => `<div class="project">
    <div><span class="project-title">${htmlEscape(project.name)}</span>${project.badge ? `<span class="project-badge">${htmlEscape(project.badge)}</span>` : ''}</div>
    <div class="project-desc">${htmlEscape(project.description)}</div>
    ${project.tech ? `<div class="project-tech">Stack: ${htmlEscape(project.tech)}</div>` : ''}
  </div>`).join('\n');
}

function openSourceHtml(entries) {
  return entries.map((entry) => `<div class="project">
    <div><span class="project-title">${htmlEscape(entry.name)}</span></div>
    <div class="project-desc">${htmlEscape(entry.description)}</div>
  </div>`).join('\n');
}

function skillsHtml(lines) {
  return lines.map((line) => {
    const [category, ...rest] = line.split(':');
    if (!rest.length) return `<div class="skill-item">${htmlEscape(line)}</div>`;
    return `<div class="skill-item"><span class="skill-category">${htmlEscape(category)}:</span> ${htmlEscape(rest.join(':').trim())}</div>`;
  }).join('\n');
}

function educationHtml(education) {
  if (!education) return '';
  return `<div class="edu-item">
    <div class="edu-header"><span class="edu-title">${htmlEscape(education.degree)}</span></div>
    <div class="edu-org">${htmlEscape(education.org)}</div>
    <div class="edu-desc">${htmlEscape(education.subtitle)}${education.extra ? ` | ${htmlEscape(education.extra)}` : ''}</div>
  </div>`;
}

function plainListHtml(items) {
  return `<ul class="plain-list">${items.map((item) => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`;
}

function section(title, bodyHtml) {
  if (!normalize(bodyHtml)) return '';
  return `<div class="section">
    <div class="section-title">${htmlEscape(title)}</div>
    ${bodyHtml}
  </div>`;
}

async function main() {
  const cv = readFileSync(resolve(__dirname, 'cv.md'), 'utf8');
  const templateHead = readFileSync(resolve(__dirname, 'templates', 'cv-template.html'), 'utf8')
    .match(/<head>[\s\S]*?<\/head>/)[0]
    .replace('{{LANG}}', 'en')
    .replace(/\{\{NAME\}\}/g, 'Jakye Amos')
    .replace(/\{\{PAGE_WIDTH\}\}/g, '8.5in')
    .replace('</head>', '<style>.plain-list{list-style:disc;padding-left:18px;margin-top:2px}.plain-list li{font-size:10.5px;line-height:1.6;color:#333;margin-bottom:4px}</style></head>');

  const sections = markdownSections(cv);
  const { name, rows } = parseContactHeader(cv);
  const summarySection = findSection(sections, 'PROFESSIONAL SUMMARY');
  const summary = stripMarkdown(bulletLines(summarySection).join(' '));
  const skillsSection = findSection(sections, 'SKILLS');
  const skills = skillsSection ? skillsSection.lines.map(normalize).filter(Boolean) : [];
  const jobs = parseExperience(sections);
  const openSource = parseOpenSource(sections);
  const projects = parseCvProjects(sections);
  const education = parseEducation(sections);
  const leadership = bulletLines(findSection(sections, 'LEADERSHIP & COMMUNITY'));
  const awards = bulletLines(findSection(sections, 'AWARDS & HONORS'));

  const body = `<body>
<div class="page">
  <div class="header">
    <h1>${htmlEscape(name)}</h1>
    <div class="header-gradient"></div>
    ${rows.map((tokens) => `<div class="contact-row">${tokens.map((token, i) => `${i > 0 ? '<span class="separator">|</span>' : ''}${contactLinkHtml(token)}`).join('\n')}</div>`).join('\n')}
  </div>
  ${section('Professional Summary', `<div class="summary-text">${htmlEscape(summary)}</div>`)}
  ${section('Skills', `<div class="skills-grid">${skillsHtml(skills)}</div>`)}
  ${section('Work Experience', jobsHtml(jobs))}
  ${section('Open-Source & Published Developer Tooling', openSourceHtml(openSource))}
  ${section('Projects', projectsHtml(projects))}
  ${section('Education', educationHtml(education))}
  ${section('Leadership & Community', plainListHtml(leadership))}
  ${section('Awards & Honors', plainListHtml(awards))}
</div>
</body>`;

  const html = `<!DOCTYPE html>\n<html lang="en">\n${templateHead}\n${body}\n</html>\n`;

  const outputDir = resolve(__dirname, 'output');
  mkdirSync(outputDir, { recursive: true });
  const htmlPath = resolve(outputDir, 'full-cv.html');
  const pdfPath = resolve(outputDir, 'Jakye_Amos_Full_CV.pdf');
  writeFileSync(htmlPath, html, 'utf8');

  const result = await renderHtmlToPdf(html, pdfPath, { format: 'letter', baseDir: outputDir, inputPath: htmlPath });
  console.log(`Jobs: ${jobs.length}, Projects: ${projects.length}, Open-source: ${openSource.length}, Leadership: ${leadership.length}, Awards: ${awards.length}`);
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error('Full CV generation failed:', err.message);
    process.exit(1);
  });
}

export { main };
