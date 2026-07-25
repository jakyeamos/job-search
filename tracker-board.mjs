import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { rebuildRow } from './tracker-utils.mjs';

/** The six post-application states from templates/states.yml. Evaluated and SKIP are pre-application and live in the daily queue instead. */
export const BOARD_COLUMNS = Object.freeze(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded']);

const COLUMN_BY_KEY = new Map(BOARD_COLUMNS.map((name) => [name.toLowerCase(), name]));

/** @param {string} root */
function trackerFile(root) {
  return path.join(root, 'data', 'applications.md');
}

/** @param {string} root @returns {{ file: string, lines: string[] }} */
function readTracker(root) {
  const file = trackerFile(root);
  if (!existsSync(file)) throw new Error('data/applications.md is missing');
  return { file, lines: readFileSync(file, 'utf8').split('\n') };
}

/** Pipes and newlines would split a markdown row into new columns. @param {unknown} value */
export function sanitizeCell(value) {
  return String(value ?? '').replace(/[|\r\n]/g, ' ').trim();
}

/** @param {string} root @returns {{ columns: string[], cards: Array<Record<string, unknown>> }} */
export function readBoard(root) {
  const { lines } = readTracker(root);
  const colmap = resolveColumns(lines);
  const cards = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const status = COLUMN_BY_KEY.get(String(row.status || '').trim().toLowerCase());
    if (!status) continue;
    cards.push({
      num: row.num,
      date: row.date,
      company: row.company,
      role: row.role,
      score: row.score,
      status,
      report: row.report,
      notes: row.notes,
    });
  }
  cards.sort((left, right) => right.num - left.num);
  return { columns: [...BOARD_COLUMNS], cards };
}

/**
 * Rewrite one cell of one tracker row. The file is re-read on every call: several
 * scripts mutate data/applications.md, so nothing is cached between requests.
 * @param {string} root @param {number} num @param {'status'|'notes'} key @param {string} value
 */
function setCell(root, num, key, value) {
  const { file, lines } = readTracker(root);
  const colmap = resolveColumns(lines);
  const index = lines.findIndex((line) => parseTrackerRow(line, colmap)?.num === num);
  if (index === -1) throw new Error(`tracker row #${num} not found in data/applications.md`);
  const parts = lines[index].split('|').map((cell) => cell.trim());
  parts[colmap[key]] = value;
  lines[index] = rebuildRow(parts);
  writeFileSync(file, lines.join('\n'), 'utf8');
  return readBoard(root);
}

/** @param {string} root @param {number} num @param {string} status */
export function setRowStatus(root, num, status) {
  const column = COLUMN_BY_KEY.get(String(status ?? '').trim().toLowerCase());
  if (!column) throw new Error(`unknown status "${status}"; expected one of ${BOARD_COLUMNS.join(', ')}`);
  return setCell(root, num, 'status', column);
}

/** @param {string} root @param {number} num @param {string} notes */
export function setRowNotes(root, num, notes) {
  return setCell(root, num, 'notes', sanitizeCell(notes));
}
