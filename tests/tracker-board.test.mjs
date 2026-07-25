import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BOARD_COLUMNS, readBoard, sanitizeCell, setRowNotes, setRowStatus } from '../tracker-board.mjs';

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

test('a status write round-trips and leaves the other rows byte-identical', () => {
  const before = [
    '| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | [001](reports/001-acme-2026-07-01.md) | Sent via careers page |',
    '| 2 | 2026-07-02 | Globex | Data Engineer | 4.4/5 | Applied | ✅ | [002](reports/002-globex-2026-07-02.md) | Referred |',
  ];
  const root = fixture(before);
  const file = path.join(root, 'data', 'applications.md');
  try {
    const board = setRowStatus(root, 1, 'Interview');
    assert.equal(board.cards.find((card) => card.num === 1).status, 'Interview');
    const lines = readFileSync(file, 'utf8').split('\n');
    assert.equal(lines[4], before[0].replace('| Applied |', '| Interview |'));
    assert.equal(lines[5], before[1]);
    assert.equal(lines[2], '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lowercase status is stored in canonical capitalization', () => {
  const root = fixture(['| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | — | note |']);
  try {
    setRowStatus(root, 1, 'offer');
    assert.match(readFileSync(path.join(root, 'data', 'applications.md'), 'utf8'), /\| Offer \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unrecognised status is rejected and the file is untouched', () => {
  const root = fixture(['| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | — | note |']);
  const file = path.join(root, 'data', 'applications.md');
  const original = readFileSync(file, 'utf8');
  try {
    assert.throws(() => setRowStatus(root, 1, 'Evaluated'), /unknown status/);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an absent row number is reported and the file is untouched', () => {
  const root = fixture(['| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | — | note |']);
  const file = path.join(root, 'data', 'applications.md');
  const original = readFileSync(file, 'utf8');
  try {
    assert.throws(() => setRowStatus(root, 99, 'Offer'), /row #99/);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('notes containing pipes and newlines are sanitized and the row still parses', () => {
  const root = fixture(['| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | — | note |']);
  try {
    const board = setRowNotes(root, 1, 'recruiter: Dana | phone screen\nThursday 3pm');
    assert.equal(board.cards[0].notes, 'recruiter: Dana   phone screen Thursday 3pm');
    assert.equal(board.cards[0].status, 'Applied');
    assert.equal(board.cards[0].company, 'Acme');
    assert.equal(readBoard(root).cards.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a row written without a trailing pipe survives a rewrite', () => {
  const root = fixture(['| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Applied | ✅ | — | note']);
  try {
    const board = setRowStatus(root, 1, 'Rejected');
    assert.equal(board.cards[0].status, 'Rejected');
    assert.equal(board.cards[0].notes, 'note');
    const line = readFileSync(path.join(root, 'data', 'applications.md'), 'utf8').split('\n')[4];
    assert.equal(line, '| 1 | 2026-07-01 | Acme | Backend Engineer | 4.2/5 | Rejected | ✅ | — | note |');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
