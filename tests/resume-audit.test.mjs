import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auditResume, extractMarkdownHeadings } from '../resume-audit.mjs';

test('audit accepts the canonical CV structure', () => {
  const report = auditResume({ cvPath: join(process.cwd(), 'cv.md') });
  assert.equal(report.passed, true);
  assert.equal(report.errors.length, 0);
});

test('audit catches unresolved template content in a generated HTML artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'career-ops-resume-audit-'));
  const cvPath = join(directory, 'cv.md');
  const htmlPath = join(directory, 'resume.html');
  writeFileSync(cvPath, [
    '# Jakye Amos',
    'jakyejobs@gmail.com | https://github.com/jakyeamos',
    '',
    '## Professional Summary',
    'Software engineer.',
    '## Work Experience',
    'Experience.',
    '## Projects',
    'Projects.',
    '## Education',
    'Education.',
    '## Skills',
    'Skills.',
  ].join('\n'));
  writeFileSync(htmlPath, '<html><body><div>{{SUMMARY_TEXT}}</div></body></html>');

  const report = auditResume({ cvPath, htmlPath });
  assert.equal(report.passed, false);
  assert.ok(report.errors.some((result) => result.name === 'html-placeholders'));
});

test('heading extraction preserves source line numbers and aliases', () => {
  const headings = extractMarkdownHeadings('# Name\n\n## TECHNICAL SKILLS\n\n## EXPERIENCE');
  assert.deepEqual(headings.map((heading) => [heading.line, heading.key]), [
    [1, null],
    [3, 'skills'],
    [5, 'experience'],
  ]);
});
