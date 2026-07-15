/**
 * Build a non-destructive packet for the configured Google Sheets tracker.
 *
 * The generated queue is an evaluation snapshot. It intentionally does not
 * overwrite the manually maintained Applications or Outreach tabs, and it
 * never promotes an evaluated role to an application.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_PATH = path.join(ROOT, 'data', 'applications.md');
const SEARCH_OPS_PATH = path.join(ROOT, 'data', 'search-ops.md');
const CONFIG_PATH = path.join(ROOT, 'config', 'google-sheets.json');
const OUTPUT_DIR = path.join(ROOT, 'output', 'sheets');

const QUEUE_HEADERS = [
  'Tracker #',
  'Date Evaluated',
  'Company',
  'Role',
  'Lane',
  'Fit Score',
  'Evaluation Status',
  'Application Stage',
  'Report ID',
  'Notes',
  'Source',
];

const WEEKLY_HEADERS = [
  'Week of',
  'Metric',
  'Target',
  'Actual',
  'Evidence / next step',
];

const LANE_HEADERS = ['Priority', 'Lane', 'Use these projects', 'Resume move'];

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { spreadsheetUrl: '', tabs: {}, syncPolicy: {} };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function readTrackerRows() {
  const lines = fs.readFileSync(TRACKER_PATH, 'utf8').split(/\r?\n/);
  const columns = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean);
}

function scoreValue(value) {
  if (String(value).toUpperCase() === 'N/A') return '';
  const match = String(value).match(/[0-9]+(?:\.[0-9]+)?/);
  return match ? Number(match[0]) : '';
}

function reportId(value) {
  const match = String(value).match(/\[([^\]]+)\]/);
  return match ? match[1] : '';
}

function laneFor(row) {
  const text = `${row.role} ${row.notes}`.toLowerCase();
  if (/(forward[- ]deployed|solutions engineer|customer engineer|implementation|sales engineer|gtm)/.test(text)) {
    return 'Solutions / forward-deployed';
  }
  if (/(data|analytics|database|machine learning|\bml\b|quant|search feed|data platform)/.test(text)) {
    return 'Data / analytics';
  }
  if (/(agent|agents|automation|ai engineer|applied ai|genai|llm)/.test(text)) {
    return 'Applied AI / client delivery';
  }
  if (/(full[- ]stack|frontend|front end|product engineer)/.test(text)) {
    return 'Product / full-stack';
  }
  if (/(backend|platform|infrastructure|software engineer|software developer)/.test(text)) {
    return 'Backend / AI / platform';
  }
  return 'Product / full-stack';
}

function parseTable(markdown, headerMatcher) {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => headerMatcher.test(line));
  if (headerIndex < 0) return [];

  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) break;
    const cells = trimmed.split('|').slice(1);
    if (cells.at(-1) === '') cells.pop();
    const values = cells.map((cell) => cell.trim());
    if (values.length > 0 && values.every((value) => /^-+$/.test(value))) continue;
    rows.push(values);
  }
  return rows;
}

function parseSearchOps() {
  const markdown = fs.readFileSync(SEARCH_OPS_PATH, 'utf8');
  const weekOf = markdown.match(/Week of \*\*(.+?)\*\*/)?.[1] ?? '';
  const metrics = parseTable(markdown, /\| Metric \| Target \| Actual \| Evidence \/ next step \|/).map((values) => ({
    metric: values[0] ?? '',
    target: values[1] ?? '',
    actual: values[2] ?? '',
    evidence: values[3] ?? '',
  }));
  const lanes = parseTable(markdown, /\| Priority \| Lane \| Use these projects \| Resume move \|/).map((values) => ({
    priority: values[0] ?? '',
    lane: values[1] ?? '',
    projects: values[2] ?? '',
    resumeMove: values[3] ?? '',
  }));
  return { weekOf, metrics, lanes };
}

function toTsv(headers, rows) {
  const normalize = (value) => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  return [headers, ...rows].map((row) => row.map(normalize).join('\t')).join('\n') + '\n';
}

function writeOutput(fileName, contents) {
  fs.writeFileSync(path.join(OUTPUT_DIR, fileName), contents, 'utf8');
}

const config = readConfig();
const trackerRows = readTrackerRows();
const weekly = parseSearchOps();
const queueRows = trackerRows.map((row) => [
  row.num,
  row.date,
  row.company,
  row.role,
  laneFor(row),
  scoreValue(row.score),
  row.status,
  '',
  reportId(row.report),
  row.notes,
  'Career Ops',
]);
const weeklyRows = weekly.metrics.map((metric) => [
  weekly.weekOf,
  metric.metric,
  metric.target,
  metric.actual,
  metric.evidence,
]);
const laneRows = weekly.lanes.map((lane) => [
  lane.priority,
  lane.lane,
  lane.projects,
  lane.resumeMove,
]);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
writeOutput('career-ops-queue.tsv', toTsv(QUEUE_HEADERS, queueRows));
writeOutput('weekly-ops.tsv', toTsv(WEEKLY_HEADERS, weeklyRows));
writeOutput('lane-queue.tsv', toTsv(LANE_HEADERS, laneRows));
writeOutput('sync-manifest.json', `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  spreadsheetUrl: config.spreadsheetUrl ?? '',
  tabs: config.tabs ?? {},
  syncPolicy: config.syncPolicy ?? {},
  sourceFiles: ['data/applications.md', 'data/search-ops.md'],
  queueRowCount: queueRows.length,
  weeklyMetricCount: weeklyRows.length,
  laneCount: laneRows.length,
  manualTabs: ['Applications', 'Outreach'],
  generatedFiles: ['career-ops-queue.tsv', 'weekly-ops.tsv', 'lane-queue.tsv'],
}, null, 2)}\n`);

console.log(`Exported ${queueRows.length} Career Ops evaluations and ${weeklyRows.length} weekly metrics.`);
console.log(`Output directory: ${path.relative(ROOT, OUTPUT_DIR)}`);
if (config.spreadsheetUrl) {
  console.log(`Configured spreadsheet: ${config.spreadsheetUrl}`);
} else {
  console.log('No spreadsheet URL configured; copy config/google-sheets.example.json to config/google-sheets.json first.');
}
