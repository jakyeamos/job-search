import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BOARD_COLUMNS, readBoard, sanitizeCell } from '../tracker-board.mjs';

const HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];

/** @param {string[]} rows */
function fixture(rows) {
  const root = mkdtempSync(path.join(tmpdir(), 'tracker-board-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'applications.md'), `${[...HEADER, ...rows].join('\n')}\n`, 'utf8');
  return root;
}

test('the board exposes exactly the six post-application states', () => {
  assert.deepEqual([...BOARD_COLUMNS], ['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded']);
});

test('only rows in a board state become cards', () => {
  const root = fixture([
    '| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | [001](reports/001-acme-2026-07-01.md) | Sent via careers page |',
    '| 2 | 2026-07-02 | Globex | Data Engineer | 4.4/5 | Evaluated | ✅ | [002](reports/002-globex-2026-07-02.md) | Pending decision |',
    '| 3 | 2026-07-03 | Initech | SRE | 3.1/5 | SKIP | ❌ | — | Poor fit |',
    '| 4 | 2026-07-04 | Umbrella | Platform Engineer | 4.6/5 | Interview | ✅ | [004](reports/004-umbrella-2026-07-04.md) | Screen booked |',
  ]);
  try {
    const board = readBoard(root);
    assert.deepEqual(board.cards.map((card) => card.num), [4, 1]);
    assert.deepEqual(board.cards.map((card) => card.status), ['Interview', 'Applied']);
    assert.equal(board.cards[1].company, 'Acme');
    assert.equal(board.cards[1].role, 'Backend Engineer');
    assert.equal(board.cards[1].score, '4.2/5');
    assert.equal(board.cards[1].notes, 'Sent via careers page');
    assert.equal(board.cards[1].report, '[001](reports/001-acme-2026-07-01.md)');
    assert.deepEqual(board.columns, [...BOARD_COLUMNS]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status matching ignores case', () => {
  const root = fixture([
    '| 7 | 2026-07-05 | Acme | Backend Engineer | 4.2/5 | applied | ✅ | — | lowercase status |',
  ]);
  try {
    assert.deepEqual(readBoard(root).cards.map((card) => card.status), ['Applied']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing tracker is reported by name', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tracker-board-'));
  try {
    assert.throws(() => readBoard(root), /data\/applications\.md is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizeCell strips the characters that would split a row', () => {
  assert.equal(sanitizeCell('a | b\nc\r\nd'), 'a   b c  d');
  assert.equal(sanitizeCell(null), '');
});
