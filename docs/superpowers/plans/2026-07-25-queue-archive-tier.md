# Queue Archive Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move dead queue rows (`excluded`, `archived`) out of `data/job-queue.json` into a sidecar archive, leaving a small stub index behind that keeps dedup, suppression, and the UI counts honest.

**Architecture:** A new standalone module `queue-archive.mjs` owns the stub shape, the eviction transform, and strict archive I/O. `saveQueue` in `queue.mjs` becomes the single eviction point: it reads the archive, evicts, and writes both files. `buildQueue` in `queue-lib.mjs` carries the `archivedIndex` forward and consumes it — an archived id that is not observed again is dropped from the merge, an archived id that *is* observed re-enters live items with its `firstSeenAt` carried over. A `rehydrate` command pulls records back out for rescoring. `verifyQueue` gains archive integrity checks, and the UI reads its dead-end counts from the index instead of from `items`.

**Tech Stack:** Node.js ESM (`.mjs`), no runtime dependencies, `node:test` + `node:assert/strict`.

## Global Constraints

- Implements Feature 3 of `docs/superpowers/specs/2026-07-25-queue-refill-and-application-board-design.md` (lines 198-359). That section is binding; read it if a detail here is ambiguous.
- **Never evict `skipped` or `applied`.** That record is the only thing standing between the user and a job they already rejected walking back into the daily selection. No age rule applies to them.
- **Eviction triggers on status, not age.** Only `excluded` and `archived` are evicted. `stale` stays live — it is the 45-to-60-day waiting room and reactivates on re-observation. `ready`, `in_review`, `snoozed` stay live.
- **Nothing is deleted.** The archive holds the full record, descriptions included.
- Archive file path: `data/job-queue-archive.json`. Live file path: `data/job-queue.json`. Both live under `data/`, which is gitignored.
- Missing archive file → treat as empty, create on first eviction. A fresh clone has no archive and must not fail.
- Archive present but unparseable → `saveQueue` **aborts before writing either file**. Do not reuse `readQueueState`'s forgiving `catch { return default }` path for the archive.
- The archive write is read-modify-write, appending by id. A record evicted twice must not duplicate.
- Stub shape, exactly these keys: `{ id, company, title, url, status, fitScore, blockers, lane, firstSeenAt, lastSeenAt, archivedAt }`.
- `buildQueue` returns a fresh object literal that does **not** spread `previous`. Any new top-level key must be carried explicitly or it is silently destroyed on every refresh.
- Tests run with `node --test 'tests/*.test.mjs'` from the repo root. The quoted glob is required — a bare directory argument fails on Node 24. There is no `test` or `lint` script in `package.json`.
- Tests build their own fixtures in `mkdtempSync` temp directories. Never read or write the real `data/` tree from a test.
- Existing suite is 246 tests passing at `95462cc`. It must still pass at every commit.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `queue-archive.mjs` | Create | Stub shape, eviction transform, strict archive read/write. Imports only `fs` and `path` — no dependency on `queue-lib.mjs`, so no import cycle. |
| `queue-lib.mjs` | Modify (`buildQueue`, ~551-628) | Carry `archivedIndex` through the return; suppress unobserved archived ids; reactivate observed ones. |
| `queue.mjs` | Modify (`saveQueue` ~275, `refresh` ~368-373, `verifyQueue` ~481, `main` ~547) + add `rehydrateQueue` | Eviction on write, archive integrity checks, the `rehydrate` command. |
| `queue-ui.mjs` | Modify (`queuePayload` ~188-262) | Dead-end counts sourced from `archivedIndex`; keep the stub array out of the HTTP payload. |
| `queue-ui/index.html` | Modify (summary strip, 32-45) | Fourth summary tile: `Filtered` disclosure. |
| `queue-ui/app.js` | Modify (`elements` 1-29, `renderSummary` 202-211) | Populate the filtered count and its breakdown. |
| `queue-ui/styles.css` | Modify (`.summary-strip` 138-141) | Four columns; disclosure styling. |
| `tests/queue-archive.test.mjs` | Create | Covers Tasks 1-5. |
| `tests/queue-ui-payload.test.mjs` | Create | Covers Task 6's server side. |

**Deliberately unchanged:** `application-queue.mjs`'s local `saveQueue` (line 82), `backfill-descriptions.mjs:197`, and `outreach.mjs:448` all call `writeQueueState` directly with a spread of the state they read. Eviction does not fire on those paths, which is correct — they set `applied`/`skipped`/contact data, none of which is evictable — and `archivedIndex` survives their spread untouched.

---

### Task 1: The archive module

**Files:**
- Create: `queue-archive.mjs`
- Test: `tests/queue-archive.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `ARCHIVE_SCHEMA_VERSION: number` (= 1)
  - `EVICTABLE_STATUSES: readonly string[]` (= `['excluded', 'archived']`)
  - `archiveStub(item: object, now?: string) -> object`
  - `evictToArchive(state: object, archive?: object, options?: { now?: string }) -> { state, archive, evicted: number, index: object[] }`
  - `readArchive(file: string) -> { schemaVersion, updatedAt, records: object[] }` — throws on unparseable
  - `writeArchive(file: string, archive: object) -> void`

- [ ] **Step 1: Write the failing tests**

Create `tests/queue-archive.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  ARCHIVE_SCHEMA_VERSION,
  EVICTABLE_STATUSES,
  archiveStub,
  evictToArchive,
  readArchive,
  writeArchive,
} from '../queue-archive.mjs';

/** @param {Record<string, unknown>} overrides */
function item(overrides) {
  return {
    id: 'x',
    company: 'Acme',
    title: 'Backend Engineer',
    applyUrl: 'https://example.com/jobs/1',
    canonicalUrl: 'https://example.com/jobs/1',
    status: 'ready',
    fitScore: 4.5,
    blockers: [],
    lane: 'backend',
    description: 'a long job description',
    firstSeenAt: '2026-07-04T00:00:00.000Z',
    lastSeenAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'queue-archive-'));
}

test('the evictable set is exactly excluded and archived', () => {
  assert.deepEqual([...EVICTABLE_STATUSES].sort(), ['archived', 'excluded']);
});

test('a stub carries the documented keys and nothing else', () => {
  const stub = archiveStub(item({ status: 'excluded' }), '2026-07-25T00:00:00.000Z');
  assert.deepEqual(Object.keys(stub).sort(), [
    'archivedAt', 'blockers', 'company', 'firstSeenAt', 'fitScore',
    'id', 'lane', 'lastSeenAt', 'status', 'title', 'url',
  ]);
  assert.equal(stub.url, 'https://example.com/jobs/1');
  assert.equal(stub.archivedAt, '2026-07-25T00:00:00.000Z');
});

test('a stub keeps an existing archivedAt rather than restamping it', () => {
  const stub = archiveStub(item({ status: 'archived', archivedAt: '2026-07-10T00:00:00.000Z' }), '2026-07-25T00:00:00.000Z');
  assert.equal(stub.archivedAt, '2026-07-10T00:00:00.000Z');
});

test('excluded and archived rows are evicted, everything else stays live', () => {
  const state = {
    items: [
      item({ id: 'ready', status: 'ready' }),
      item({ id: 'in_review', status: 'in_review' }),
      item({ id: 'snoozed', status: 'snoozed' }),
      item({ id: 'stale', status: 'stale' }),
      item({ id: 'skipped', status: 'skipped' }),
      item({ id: 'applied', status: 'applied' }),
      item({ id: 'excluded', status: 'excluded' }),
      item({ id: 'archived', status: 'archived' }),
    ],
  };
  const result = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.equal(result.evicted, 2);
  assert.deepEqual(
    result.state.items.map((entry) => entry.id),
    ['ready', 'in_review', 'snoozed', 'stale', 'skipped', 'applied'],
  );
  assert.deepEqual(result.index.map((stub) => stub.id).sort(), ['archived', 'excluded']);
});

test('the archive keeps the full record, description included', () => {
  const state = { items: [item({ id: 'excluded', status: 'excluded' })] };
  const result = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.equal(result.archive.records.length, 1);
  assert.equal(result.archive.records[0].description, 'a long job description');
  assert.equal(result.archive.schemaVersion, ARCHIVE_SCHEMA_VERSION);
});

test('evicting the same record twice does not duplicate it', () => {
  const state = { items: [item({ id: 'excluded', status: 'excluded' })] };
  const first = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  const second = evictToArchive(state, first.archive, { now: '2026-07-26T00:00:00.000Z' });
  assert.equal(second.archive.records.length, 1);
  assert.equal(second.index.length, 1);
});

test('an existing archivedIndex survives an eviction that adds to it', () => {
  const state = {
    archivedIndex: [archiveStub(item({ id: 'old', status: 'excluded' }), '2026-07-01T00:00:00.000Z')],
    items: [item({ id: 'new', status: 'excluded' })],
  };
  const result = evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.deepEqual(result.index.map((stub) => stub.id).sort(), ['new', 'old']);
});

test('the input state is not mutated', () => {
  const state = { items: [item({ id: 'excluded', status: 'excluded' })] };
  evictToArchive(state, { records: [] }, { now: '2026-07-25T00:00:00.000Z' });
  assert.equal(state.items.length, 1);
  assert.equal(state.archivedIndex, undefined);
});

test('a missing archive file reads as empty', () => {
  const dir = tempDir();
  const archive = readArchive(path.join(dir, 'job-queue-archive.json'));
  assert.deepEqual(archive.records, []);
  assert.equal(archive.schemaVersion, ARCHIVE_SCHEMA_VERSION);
});

test('an unparseable archive throws instead of reading as empty', () => {
  const dir = tempDir();
  const file = path.join(dir, 'job-queue-archive.json');
  writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => readArchive(file), /unreadable/);
});

test('an archive without a records array throws', () => {
  const dir = tempDir();
  const file = path.join(dir, 'job-queue-archive.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1 }), 'utf8');
  assert.throws(() => readArchive(file), /not a valid archive/);
});

test('an archive round-trips through write and read', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'job-queue-archive.json');
  writeArchive(file, { schemaVersion: 1, updatedAt: '2026-07-25T00:00:00.000Z', records: [item({ id: 'excluded', status: 'excluded' })] });
  const archive = readArchive(file);
  assert.equal(archive.records.length, 1);
  assert.equal(archive.records[0].id, 'excluded');
  assert.equal(archive.updatedAt, '2026-07-25T00:00:00.000Z');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: FAIL — `Cannot find module .../queue-archive.mjs`

- [ ] **Step 3: Write the module**

Create `queue-archive.mjs`:

```js
// @ts-check

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

export const ARCHIVE_SCHEMA_VERSION = 1;

/**
 * Statuses evicted from the live queue on the next write. `skipped` and
 * `applied` are never evicted: that record is the only thing standing between
 * the user and a job they already rejected walking back into the daily
 * selection. `stale` stays live as the 45-to-60-day waiting room.
 */
export const EVICTABLE_STATUSES = Object.freeze(['excluded', 'archived']);

const EVICTABLE = new Set(EVICTABLE_STATUSES);

/** @param {Record<string, unknown>} item @param {string} [now] */
export function archiveStub(item, now = new Date().toISOString()) {
  return {
    id: item.id,
    company: item.company || '',
    title: item.title || '',
    url: item.applyUrl || item.canonicalUrl || null,
    status: item.status,
    fitScore: typeof item.fitScore === 'number' ? item.fitScore : null,
    blockers: Array.isArray(item.blockers) ? item.blockers : [],
    lane: item.lane || null,
    firstSeenAt: item.firstSeenAt || null,
    lastSeenAt: item.lastSeenAt || null,
    archivedAt: item.archivedAt || now,
  };
}

/** @param {Array<Record<string, unknown>>} entries */
function byId(entries) {
  return new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
}

/**
 * Splits evictable rows out of the live state into the archive sidecar,
 * leaving a stub behind in `archivedIndex`. Read-modify-write on the archive,
 * keyed by id, so a record evicted twice does not duplicate.
 *
 * @param {Record<string, unknown>} state
 * @param {Record<string, unknown>} [archive]
 * @param {{ now?: string }} [options]
 */
export function evictToArchive(state, archive = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const items = Array.isArray(state.items) ? state.items : [];
  const live = [];
  const stubs = [];
  const evicted = [];
  for (const item of items) {
    if (!item?.id || !EVICTABLE.has(String(item.status || ''))) { live.push(item); continue; }
    stubs.push(archiveStub(item, now));
    evicted.push(item);
  }

  const index = byId(Array.isArray(state.archivedIndex) ? state.archivedIndex : []);
  for (const stub of stubs) index.set(stub.id, stub);
  const nextIndex = [...index.values()];

  const records = byId(Array.isArray(archive.records) ? archive.records : []);
  for (const record of evicted) records.set(record.id, record);

  return {
    state: { ...state, items: live, archivedIndex: nextIndex },
    archive: {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      updatedAt: now,
      records: [...records.values()],
    },
    evicted: stubs.length,
    index: nextIndex,
  };
}

/**
 * Strict read. Unlike `readQueueState`, an unparseable archive throws — the
 * caller must abort rather than evict live records into a void.
 *
 * @param {string} file
 */
export function readArchive(file) {
  if (!existsSync(file)) return { schemaVersion: ARCHIVE_SCHEMA_VERSION, updatedAt: null, records: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`archive at ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
    throw new Error(`archive at ${file} is not a valid archive document`);
  }
  return {
    schemaVersion: parsed.schemaVersion ?? ARCHIVE_SCHEMA_VERSION,
    updatedAt: parsed.updatedAt || null,
    records: parsed.records,
  };
}

/** @param {string} file @param {Record<string, unknown>} archive */
export function writeArchive(file, archive) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: PASS, 12/12.

- [ ] **Step 5: Run the full suite**

Run: `node --test 'tests/*.test.mjs'`
Expected: PASS, 258/258 (246 existing + 12 new).

- [ ] **Step 6: Commit**

```bash
git add queue-archive.mjs tests/queue-archive.test.mjs && git commit -m "feat(queue): add archive sidecar module with stub eviction"
```

---

### Task 2: buildQueue carries and consumes the archived index

**Files:**
- Modify: `queue-lib.mjs:551-628` (`buildQueue`)
- Test: `tests/queue-archive.test.mjs` (append)

**Interfaces:**
- Consumes: `archiveStub` from Task 1 (test fixtures only — `queue-lib.mjs` itself imports nothing from `queue-archive.mjs`).
- Produces: `buildQueue(candidates, previous, options)` now reads `previous.archivedIndex` and returns `archivedIndex` as a top-level key on the result.

**Behaviour to implement, from the spec:**
- Candidate id hits the index and is **not observed now** → dropped from the merge, stays archived.
- Candidate id hits the index and **is observed now** → re-enters live `items`, `firstSeenAt` carried from the stub, `reactivatedAt` stamped, stub removed from the index. No archive read.
- A reactivated row is rescored upstream by `scoreCandidate`, so it may be excluded and evicted again on the same write. That is intended.

- [ ] **Step 1: Write the failing tests**

Append to `tests/queue-archive.test.mjs`:

```js
import { buildQueue } from '../queue-lib.mjs';

/** @param {Record<string, unknown>} overrides */
function candidate(overrides) {
  return {
    id: 'c1',
    company: 'Acme',
    title: 'Backend Engineer',
    applyUrl: 'https://example.com/jobs/1',
    canonicalUrl: 'https://example.com/jobs/1',
    status: 'ready',
    source: 'greenhouse',
    fitScore: 4.5,
    freshness: 'fresh',
    ...overrides,
  };
}

test('buildQueue carries the archived index through a refresh', () => {
  const index = [archiveStub(item({ id: 'gone', status: 'excluded' }), '2026-07-01T00:00:00.000Z')];
  const result = buildQueue([candidate({})], { items: [], archivedIndex: index }, { now: '2026-07-25T00:00:00.000Z' });
  assert.deepEqual(result.archivedIndex.map((stub) => stub.id), ['gone']);
});

test('buildQueue returns an empty index when there was none', () => {
  const result = buildQueue([candidate({})], {}, { now: '2026-07-25T00:00:00.000Z' });
  assert.deepEqual(result.archivedIndex, []);
});

test('an archived id that is not observed now is dropped from the merge', () => {
  const index = [archiveStub(item({ id: 'c1', status: 'excluded' }), '2026-07-01T00:00:00.000Z')];
  const result = buildQueue(
    [candidate({ id: 'c1', observedAt: null, lastSeenAt: null, liveness: 'uncertain' })],
    { items: [], archivedIndex: index },
    { now: '2026-07-25T00:00:00.000Z' },
  );
  assert.deepEqual(result.items.map((entry) => entry.id), []);
  assert.deepEqual(result.archivedIndex.map((stub) => stub.id), ['c1']);
});

test('an archived id observed again reactivates with its original firstSeenAt', () => {
  const index = [archiveStub(
    item({ id: 'c1', status: 'excluded', firstSeenAt: '2026-07-04T00:00:00.000Z' }),
    '2026-07-10T00:00:00.000Z',
  )];
  const result = buildQueue(
    [candidate({ id: 'c1', observedAt: '2026-07-25T00:00:00.000Z' })],
    { items: [], archivedIndex: index },
    { now: '2026-07-25T00:00:00.000Z' },
  );
  assert.deepEqual(result.items.map((entry) => entry.id), ['c1']);
  assert.equal(result.items[0].firstSeenAt, '2026-07-04T00:00:00.000Z');
  assert.equal(result.items[0].reactivatedAt, '2026-07-25T00:00:00.000Z');
  assert.deepEqual(result.archivedIndex, []);
});

test('a reactivated row keeps the freshly scored status, not the archived one', () => {
  const index = [archiveStub(item({ id: 'c1', status: 'excluded' }), '2026-07-10T00:00:00.000Z')];
  const result = buildQueue(
    [candidate({ id: 'c1', status: 'ready', observedAt: '2026-07-25T00:00:00.000Z' })],
    { items: [], archivedIndex: index },
    { now: '2026-07-25T00:00:00.000Z' },
  );
  assert.equal(result.items[0].status, 'ready');
});

test('unseen retention still works for rows that are not archived', () => {
  const previous = { items: [{ ...item({ id: 'kept', status: 'in_review' }), selectedForToday: false }], archivedIndex: [] };
  const result = buildQueue([candidate({ id: 'c1' })], previous, { now: '2026-07-25T00:00:00.000Z', retainUnseen: true });
  assert.deepEqual(result.items.map((entry) => entry.id).sort(), ['c1', 'kept']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: FAIL — `archivedIndex` is `undefined` on the result, and the archived candidate is merged in instead of dropped.

- [ ] **Step 3: Implement the change**

In `queue-lib.mjs`, inside `buildQueue`, after the `previousItems` line:

```js
  const previousItems = new Map(Array.isArray(previous.items) ? previous.items.map((item) => [item.id, item]) : []);
```

add:

```js
  const archivedIndex = new Map(
    (Array.isArray(previous.archivedIndex) ? previous.archivedIndex : [])
      .filter((stub) => stub?.id)
      .map((stub) => [stub.id, stub]),
  );
```

Inside the candidate loop, immediately after the `observedNow` line:

```js
    const observedNow = observedAt !== null || (candidate.liveness === 'active' && isoTimestamp(candidate.livenessCheckedAt) !== null);
```

add:

```js
    // An archived id with no fresh observation stays archived: it must not be
    // resurrected into the live file by a stale candidate list.
    const archivedStub = archivedIndex.get(candidate.id);
    if (archivedStub && !observedNow) continue;
```

Immediately before `merged.set(candidate.id, mergedItem);` add:

```js
    if (archivedStub) {
      if (archivedStub.firstSeenAt) mergedItem.firstSeenAt = archivedStub.firstSeenAt;
      mergedItem.reactivatedAt = now;
      archivedIndex.delete(candidate.id);
    }
```

Finally, in the return object, add `archivedIndex` after `lastRun`:

```js
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    account: { gmail: 'jakyejobs@gmail.com' },
    generatedAt: now,
    lastRun: previous.lastRun || null,
    archivedIndex: [...archivedIndex.values()],
    items,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: PASS, 18/18.

- [ ] **Step 5: Run the full suite**

Run: `node --test 'tests/*.test.mjs'`
Expected: PASS, 264/264.

- [ ] **Step 6: Commit**

```bash
git add queue-lib.mjs tests/queue-archive.test.mjs && git commit -m "feat(queue): carry the archived index through buildQueue"
```

---

### Task 3: saveQueue evicts on write

**Files:**
- Modify: `queue.mjs:275-279` (`saveQueue`), `queue.mjs:368-373` (`refresh`), and the `queue-lib.mjs`/`queue-archive.mjs` import blocks at the top of `queue.mjs`
- Test: `tests/queue-archive.test.mjs` (append)

**Interfaces:**
- Consumes: `evictToArchive`, `readArchive`, `writeArchive` from Task 1; `buildQueue`'s `archivedIndex` from Task 2.
- Produces: `saveQueue(root, state)` now **returns the persisted state** (post-eviction, with `archivedIndex` populated). Callers that need the persisted view must use the return value.

**Why the return value matters:** `refresh` currently calls `saveQueue`, then re-reads the file after contact discovery and does `state = { ...state, items: discoveredState.items }`. After eviction, the in-memory `state` still holds the pre-eviction `archivedIndex` while `discoveredState.items` holds the post-eviction items — the second `saveQueue` would then write an index missing the stubs it just created. Adopting the persisted state fixes this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/queue-archive.test.mjs`:

```js
import { mkdirSync, readFileSync } from 'fs';
import { saveQueue } from '../queue.mjs';

/** @returns {string} */
function tempRoot() {
  const root = tempDir();
  mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
}

test('saveQueue evicts dead rows into the sidecar and leaves stubs behind', () => {
  const root = tempRoot();
  const state = {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'live', status: 'ready' }), item({ id: 'dead', status: 'excluded' })],
  };
  const saved = saveQueue(root, state);
  assert.deepEqual(saved.items.map((entry) => entry.id), ['live']);
  assert.deepEqual(saved.archivedIndex.map((stub) => stub.id), ['dead']);

  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items.map((entry) => entry.id), ['live']);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['dead']);

  const archive = readArchive(path.join(root, 'data', 'job-queue-archive.json'));
  assert.equal(archive.records.length, 1);
  assert.equal(archive.records[0].description, 'a long job description');
});

test('saveQueue creates the archive on first eviction in a fresh tree', () => {
  const root = tempRoot();
  saveQueue(root, { schemaVersion: 1, account: { gmail: 'jakyejobs@gmail.com' }, items: [item({ id: 'dead', status: 'excluded' })] });
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 1);
});

test('saveQueue aborts and writes nothing when the archive is unparseable', () => {
  const root = tempRoot();
  const queueFile = path.join(root, 'data', 'job-queue.json');
  writeFileSync(queueFile, JSON.stringify({ schemaVersion: 1, items: [] }), 'utf8');
  writeFileSync(path.join(root, 'data', 'job-queue-archive.json'), '{ not json', 'utf8');
  assert.throws(
    () => saveQueue(root, { schemaVersion: 1, account: { gmail: 'jakyejobs@gmail.com' }, items: [item({ id: 'dead', status: 'excluded' })] }),
    /unreadable/,
  );
  assert.deepEqual(JSON.parse(readFileSync(queueFile, 'utf8')).items, []);
});

test('saveQueue leaves skipped and applied rows live', () => {
  const root = tempRoot();
  const saved = saveQueue(root, {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'skipped', status: 'skipped' }), item({ id: 'applied', status: 'applied' }), item({ id: 'stale', status: 'stale' })],
  });
  assert.deepEqual(saved.items.map((entry) => entry.id), ['skipped', 'applied', 'stale']);
  assert.deepEqual(saved.archivedIndex, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: FAIL — `saveQueue` returns `undefined` and writes no archive.

- [ ] **Step 3: Implement the change**

In `queue.mjs`, add the archive import below the existing `./queue-aging.mjs` import:

```js
import { evictToArchive, readArchive, writeArchive } from './queue-archive.mjs';
```

Replace `saveQueue` (currently `queue.mjs:274-279`):

```js
/**
 * Writes the live queue, evicting dead rows into the archive sidecar first.
 * Returns the persisted state so callers work from the post-eviction view.
 *
 * @param {string} root @param {Record<string, unknown>} state
 */
export function saveQueue(root, state) {
  const archiveFile = path.join(root, 'data', 'job-queue-archive.json');
  const result = evictToArchive(state, readArchive(archiveFile), { now: new Date().toISOString() });
  writeQueueState(path.join(root, 'data', 'job-queue.json'), result.state);
  writeArchive(archiveFile, result.archive);
  writeFileSync(path.join(root, 'data', 'job-queue.md'), renderQueueMarkdown(result.state), 'utf8');
  return result.state;
}
```

In `refresh`, change the first save (currently `if (!dryRun) saveQueue(root, state);` at line 368) to:

```js
    if (!dryRun) state = saveQueue(root, state);
```

Change the post-discovery merge (currently lines 371-374) from:

```js
    if (!dryRun) {
      const discoveredState = readQueueState(QUEUE_JSON);
      if (Array.isArray(discoveredState.items)) state = { ...state, items: discoveredState.items };
    }
```

to:

```js
    if (!dryRun) {
      const discoveredState = readQueueState(QUEUE_JSON);
      // Adopt the persisted state wholesale: the archived index on disk is
      // newer than the in-memory one after eviction.
      if (Array.isArray(discoveredState.items)) state = { ...discoveredState, lastRun: state.lastRun };
    }
```

Change the second save (currently `if (!dryRun) saveQueue(root, state);` at line 395) to:

```js
    if (!dryRun) state = saveQueue(root, state);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: PASS, 22/22.

- [ ] **Step 5: Run the full suite**

Run: `node --test 'tests/*.test.mjs'`
Expected: PASS, 268/268.

- [ ] **Step 6: Commit**

```bash
git add queue.mjs tests/queue-archive.test.mjs && git commit -m "feat(queue): evict dead rows to the archive on every save"
```

---

### Task 4: The rehydrate command

**Files:**
- Modify: `queue.mjs` (add `blockerSlug` + `rehydrateQueue`, extend the `queue-lib.mjs` import block, add the `main()` dispatch)
- Test: `tests/queue-archive.test.mjs` (append)

**Interfaces:**
- Consumes: `saveQueue` (Task 3), `readArchive`/`writeArchive` (Task 1).
- Produces: `rehydrateQueue(root, blocker, dryRun) -> void` and the CLI surface `node queue.mjs rehydrate [--blocker <name>] [--dry-run]`.

**Behaviour:**
- Matches archived records by blocker: the given token is slugified and matched as a substring against each record's slugified blocker strings, so `--blocker experience-floor` matches `posting states a 3+ year experience floor`.
- No `--blocker` → every archived record.
- Each match is rescored with `scoreCandidate`, returned to live `items`, removed from the index and from the archive. The following `saveQueue` re-evicts whatever still scores `excluded`.
- `--dry-run` reports what would return and how each rescores, and writes nothing.

- [ ] **Step 1: Write the failing tests**

Append to `tests/queue-archive.test.mjs`:

```js
import { rehydrateQueue } from '../queue.mjs';
import { writeQueueState } from '../queue-lib.mjs';

/** @param {string} root @param {Record<string, unknown>} record */
function seedArchive(root, record) {
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [],
    archivedIndex: [archiveStub(record, '2026-07-10T00:00:00.000Z')],
  });
  writeArchive(path.join(root, 'data', 'job-queue-archive.json'), {
    schemaVersion: 1,
    updatedAt: '2026-07-10T00:00:00.000Z',
    records: [record],
  });
}

test('rehydrate returns a matching record and rescores it live when it now passes', () => {
  const root = tempRoot();
  seedArchive(root, item({
    id: 'exp',
    status: 'excluded',
    description: 'Backend engineer building APIs. Remote, United States.',
    location: 'Remote, United States',
    liveness: 'active',
    blockers: ['posting states a 3+ year experience floor'],
  }));
  rehydrateQueue(root, 'experience-floor', false);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items.map((entry) => entry.id), ['exp']);
  assert.deepEqual(live.archivedIndex, []);
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 0);
});

test('a record that still fails its blocker is evicted again by the same run', () => {
  const root = tempRoot();
  seedArchive(root, item({
    id: 'exp',
    status: 'excluded',
    description: 'We require 7+ years of experience.',
    blockers: ['posting states a 3+ year experience floor'],
  }));
  rehydrateQueue(root, 'experience-floor', false);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items, []);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['exp']);
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 1);
});

test('a non-matching blocker filter rehydrates nothing', () => {
  const root = tempRoot();
  seedArchive(root, item({ id: 'exp', status: 'excluded', blockers: ['posting states a 3+ year experience floor'] }));
  rehydrateQueue(root, 'defense-contractor', false);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items, []);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['exp']);
});

test('a dry run changes neither file', () => {
  const root = tempRoot();
  seedArchive(root, item({
    id: 'exp',
    status: 'excluded',
    description: 'Backend engineer building APIs. Remote, United States.',
    location: 'Remote, United States',
    liveness: 'active',
    blockers: ['posting states a 3+ year experience floor'],
  }));
  rehydrateQueue(root, 'experience-floor', true);
  const live = JSON.parse(readFileSync(path.join(root, 'data', 'job-queue.json'), 'utf8'));
  assert.deepEqual(live.items, []);
  assert.deepEqual(live.archivedIndex.map((stub) => stub.id), ['exp']);
  assert.equal(readArchive(path.join(root, 'data', 'job-queue-archive.json')).records.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: FAIL — `rehydrateQueue is not a function`.

- [ ] **Step 3: Implement the change**

In `queue.mjs`, add `scoreCandidate` and `topUpSelection` to the existing named import from `./queue-lib.mjs` (keep the list alphabetical — `scoreCandidate` goes after `readQueueState`, `topUpSelection` after `renderQueueMarkdown`):

```js
  readQueueState,
  renderQueueMarkdown,
  scoreCandidate,
  topUpSelection,
  writeQueueState,
} from './queue-lib.mjs';
```

Add these two functions immediately after `verifyQueue`:

```js
/** @param {string} value */
function blockerSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Pulls archived records back into the live queue and rescores them. The
 * following save re-evicts whatever still scores `excluded`, so this is safe
 * to run broadly.
 *
 * @param {string} root @param {string|null} blocker @param {boolean} dryRun
 */
export function rehydrateQueue(root, blocker, dryRun) {
  const profile = loadProfile(root);
  const archiveFile = path.join(root, 'data', 'job-queue-archive.json');
  const archive = readArchive(archiveFile);
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const wanted = blocker ? blockerSlug(blocker) : null;
  const matches = archive.records.filter((record) => {
    if (!wanted) return true;
    return (Array.isArray(record.blockers) ? record.blockers : [])
      .some((entry) => blockerSlug(entry).includes(wanted));
  });

  const now = new Date().toISOString();
  const rescored = matches.map((record) => {
    const evaluation = scoreCandidate(record, profile);
    return {
      ...record,
      fitScore: evaluation.score,
      fitConfidence: evaluation.confidence,
      fitReasons: evaluation.reasons,
      blockers: evaluation.blockers,
      lane: evaluation.lane,
      status: evaluation.status,
      selectedForToday: false,
      queueRank: null,
      rehydratedAt: now,
      updatedAt: now,
    };
  });

  const label = wanted ? ` matching blocker "${blocker}"` : '';
  if (dryRun) {
    console.log(`Rehydrate (dry run): ${rescored.length} archived record(s)${label}.`);
    const counts = new Map();
    for (const entry of rescored) counts.set(entry.status, (counts.get(entry.status) || 0) + 1);
    for (const [status, count] of [...counts.entries()].sort()) console.log(`  ${status}: ${count}`);
    console.log(`  ${rescored.filter((entry) => entry.status !== 'excluded').length} would stay live after the next write.`);
    return;
  }

  const ids = new Set(rescored.map((entry) => entry.id));
  const previousItems = Array.isArray(state.items) ? state.items : [];
  const previousIndex = Array.isArray(state.archivedIndex) ? state.archivedIndex : [];
  const next = {
    ...state,
    items: [...previousItems.filter((entry) => !ids.has(entry.id)), ...rescored],
    archivedIndex: previousIndex.filter((stub) => !ids.has(stub.id)),
  };
  // The archive is trimmed before the save so the save's read-modify-write can
  // put back only the records that still score `excluded`.
  writeArchive(archiveFile, { ...archive, updatedAt: now, records: archive.records.filter((record) => !ids.has(record.id)) });
  const saved = saveQueue(root, topUpSelection(next).state);
  const live = saved.items.filter((entry) => ids.has(entry.id)).length;
  console.log(`Rehydrated ${rescored.length} record(s)${label}: ${live} stayed live, ${rescored.length - live} were evicted again.`);
}
```

In `main()`, add the dispatch immediately after the `verify` line:

```js
  if (command === 'verify') { verifyQueue(ROOT); return; }
  if (command === 'rehydrate') {
    rehydrateQueue(ROOT, readFlag(args, '--blocker', '') || null, args.includes('--dry-run'));
    return;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: PASS, 26/26.

- [ ] **Step 5: Run the full suite**

Run: `node --test 'tests/*.test.mjs'`
Expected: PASS, 272/272.

- [ ] **Step 6: Commit**

```bash
git add queue.mjs tests/queue-archive.test.mjs && git commit -m "feat(queue): add rehydrate command for pulling archived records back"
```

---

### Task 5: verifyQueue checks archive integrity

**Files:**
- Modify: `queue.mjs:481-498` (`verifyQueue`)
- Test: `tests/queue-archive.test.mjs` (append)

**Interfaces:**
- Consumes: `readArchive` (Task 1).
- Produces: `verifyQueue(root)` now takes an optional second argument for testability — `verifyQueue(root, report)` where `report` defaults to `console.error`/`process.exitCode` behaviour. Keep the existing single-argument call site in `main()` working unchanged.

**Checks to add, from the spec's Integrity section — error, not silent repair:**
- Every stub id must be absent from live `items`.
- Every stub must resolve to a record in the sidecar.
- `archived` and `excluded` must not appear as a live item status.

- [ ] **Step 1: Write the failing tests**

Append to `tests/queue-archive.test.mjs`:

```js
import { collectQueueErrors } from '../queue.mjs';

test('a clean queue and archive report no errors', () => {
  const root = tempRoot();
  saveQueue(root, {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'live', status: 'ready' }), item({ id: 'dead', status: 'excluded' })],
  });
  assert.deepEqual(collectQueueErrors(root), []);
});

test('a stub that is also a live item is an error', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'dup', status: 'ready' })],
    archivedIndex: [archiveStub(item({ id: 'dup', status: 'excluded' }), '2026-07-10T00:00:00.000Z')],
  });
  writeArchive(path.join(root, 'data', 'job-queue-archive.json'), {
    schemaVersion: 1, updatedAt: null, records: [item({ id: 'dup', status: 'excluded' })],
  });
  assert.ok(collectQueueErrors(root).some((error) => /also a live queue item/.test(error)));
});

test('a stub with no record in the sidecar is an error', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [],
    archivedIndex: [archiveStub(item({ id: 'orphan', status: 'excluded' }), '2026-07-10T00:00:00.000Z')],
  });
  writeArchive(path.join(root, 'data', 'job-queue-archive.json'), { schemaVersion: 1, updatedAt: null, records: [] });
  assert.ok(collectQueueErrors(root).some((error) => /no record in the archive/.test(error)));
});

test('an evicted status left live is an error', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1,
    account: { gmail: 'jakyejobs@gmail.com' },
    items: [item({ id: 'stuck', status: 'excluded' })],
    archivedIndex: [],
  });
  assert.ok(collectQueueErrors(root).some((error) => /still live/.test(error)));
});

test('an unparseable archive is reported as an error rather than throwing', () => {
  const root = tempRoot();
  writeQueueState(path.join(root, 'data', 'job-queue.json'), {
    schemaVersion: 1, account: { gmail: 'jakyejobs@gmail.com' }, items: [], archivedIndex: [],
  });
  writeFileSync(path.join(root, 'data', 'job-queue-archive.json'), '{ not json', 'utf8');
  assert.ok(collectQueueErrors(root).some((error) => /unreadable/.test(error)));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: FAIL — `collectQueueErrors is not a function`.

- [ ] **Step 3: Implement the change**

In `queue.mjs`, replace `verifyQueue` with a pure collector plus a thin reporter:

```js
/** @param {string} root @returns {string[]} */
export function collectQueueErrors(root) {
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const errors = [];
  if (state.schemaVersion !== 1) errors.push(`unsupported schema version ${state.schemaVersion}`);
  if (state.account?.gmail !== TARGET_GMAIL_ACCOUNT) errors.push(`queue account is not ${TARGET_GMAIL_ACCOUNT}`);
  const ids = new Set();
  let selected = 0;
  for (const item of state.items || []) {
    if (ids.has(item.id)) errors.push(`duplicate item id ${item.id}`);
    ids.add(item.id);
    if (!normalizeUrl(item.applyUrl || item.canonicalUrl)) errors.push(`invalid URL for ${item.title}`);
    if (item.selectedForToday) selected++;
    if (!['ready', 'in_review', 'applied', 'skipped', 'snoozed', 'stale', 'archived', 'excluded'].includes(item.status)) errors.push(`invalid status ${item.status}`);
    if (['archived', 'excluded'].includes(String(item.status || ''))) errors.push(`item ${item.id} has evicted status ${item.status} but is still live`);
  }
  if (selected > 10) errors.push(`selected queue exceeds 10 roles (${selected})`);

  let records = [];
  try {
    records = readArchive(path.join(root, 'data', 'job-queue-archive.json')).records;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const archivedIds = new Set(records.map((record) => record.id));
  for (const stub of Array.isArray(state.archivedIndex) ? state.archivedIndex : []) {
    if (ids.has(stub.id)) errors.push(`archived stub ${stub.id} is also a live queue item`);
    if (!archivedIds.has(stub.id)) errors.push(`archived stub ${stub.id} has no record in the archive`);
  }
  return errors;
}

/** @param {string} root */
function verifyQueue(root) {
  const state = readQueueState(path.join(root, 'data', 'job-queue.json'));
  const errors = collectQueueErrors(root);
  if (errors.length) { for (const error of errors) console.error(`❌ ${error}`); process.exitCode = 1; return; }
  const selected = (state.items || []).filter((item) => item.selectedForToday).length;
  const archived = Array.isArray(state.archivedIndex) ? state.archivedIndex.length : 0;
  console.log(`✅ Queue valid: ${state.items.length} live item(s), ${selected} selected, ${archived} archived.`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test 'tests/queue-archive.test.mjs'`
Expected: PASS, 31/31.

- [ ] **Step 5: Run the full suite and the live health check**

Run: `node --test 'tests/*.test.mjs'`
Expected: PASS, 277/277.

Run: `node verify-pipeline.mjs`
Expected: the same clean output as before this task.

- [ ] **Step 6: Commit**

```bash
git add queue.mjs tests/queue-archive.test.mjs && git commit -m "feat(queue): verify archive integrity alongside the live queue"
```

---

### Task 6: Counts that do not lie

**Files:**
- Modify: `queue-ui.mjs:188-262` (`queuePayload`)
- Modify: `queue-ui/index.html:32-45`
- Modify: `queue-ui/app.js:1-29` (`elements`), `queue-ui/app.js:202-211` (`renderSummary`)
- Modify: `queue-ui/styles.css:138-141`, and the mobile block at 582-584
- Test: `tests/queue-ui-payload.test.mjs`

**Interfaces:**
- Consumes: `archivedIndex` as written by Task 3.
- Produces: `queuePayload` is exported from `queue-ui.mjs` (it currently exports nothing). `totals` gains `skipped` and `filtered`; `excluded` and `archived` now come from `archivedIndex`; `retained` becomes live items + index length.

**Note on scope.** The spec says the UI "collapses excluded / skipped / stale / archived into a single `Filtered (N)` disclosure line". None of those four counts is rendered in `queue-ui/index.html` today — they exist only in the `/api/queue` payload. So this task *adds* the disclosure rather than collapsing four existing tiles. The correctness half of the requirement is unchanged and is the important half: after eviction, `excluded` and `archived` computed from `items` would read 0, and the payload must not lie.

`queuePayload` returns `{ ...state, ... }`, which would ship all ~671 stubs to the browser on every poll. Strip `archivedIndex` from the payload and send only the counts.

- [ ] **Step 1: Write the failing test**

Create `tests/queue-ui-payload.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { queuePayload } from '../queue-ui.mjs';
import { archiveStub } from '../queue-archive.mjs';

/** @param {Record<string, unknown>} overrides */
function item(overrides) {
  return {
    id: 'x',
    company: 'Acme',
    title: 'Backend Engineer',
    applyUrl: 'https://example.com/jobs/1',
    canonicalUrl: 'https://example.com/jobs/1',
    status: 'ready',
    fitScore: 4.5,
    freshness: 'fresh',
    ...overrides,
  };
}

test('dead-end counts come from the archived index, not from live items', () => {
  const payload = queuePayload({
    items: [
      item({ id: 'a', status: 'ready' }),
      item({ id: 'b', status: 'in_review' }),
      item({ id: 'c', status: 'stale' }),
      item({ id: 'd', status: 'skipped' }),
    ],
    archivedIndex: [
      archiveStub(item({ id: 'e', status: 'excluded' }), '2026-07-10T00:00:00.000Z'),
      archiveStub(item({ id: 'f', status: 'excluded' }), '2026-07-10T00:00:00.000Z'),
      archiveStub(item({ id: 'g', status: 'archived' }), '2026-07-10T00:00:00.000Z'),
    ],
  });
  assert.equal(payload.totals.excluded, 2);
  assert.equal(payload.totals.archived, 1);
  assert.equal(payload.totals.stale, 1);
  assert.equal(payload.totals.skipped, 1);
  assert.equal(payload.totals.filtered, 5);
  assert.equal(payload.totals.retained, 7);
});

test('the payload does not ship the archived stub array to the browser', () => {
  const payload = queuePayload({
    items: [],
    archivedIndex: [archiveStub(item({ id: 'e', status: 'excluded' }), '2026-07-10T00:00:00.000Z')],
  });
  assert.equal(payload.archivedIndex, undefined);
});

test('a queue with no archived index reports zero filtered', () => {
  const payload = queuePayload({ items: [item({ id: 'a', status: 'ready' })] });
  assert.equal(payload.totals.filtered, 0);
  assert.equal(payload.totals.retained, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test 'tests/queue-ui-payload.test.mjs'`
Expected: FAIL — `queuePayload` is not exported from `queue-ui.mjs`.

- [ ] **Step 3: Update the payload**

In `queue-ui.mjs`, change the declaration at line 188 and its first two lines from:

```js
function queuePayload(state) {
  const items = Array.isArray(state.items) ? state.items : [];
```

to:

```js
export function queuePayload(state) {
  const { archivedIndex: rawArchivedIndex, ...rest } = state;
  const archivedIndex = Array.isArray(rawArchivedIndex) ? rawArchivedIndex : [];
  const items = Array.isArray(rest.items) ? rest.items : [];
```

Change the spread at the head of the return object from `...state,` to `...rest,`.

Replace the `totals` block (currently lines 249-261) with:

```js
    totals: {
      retained: items.length + archivedIndex.length,
      liveUnique: countUniqueLiveRoles(liveItems),
      excluded: archivedIndex.filter((stub) => stub.status === 'excluded').length,
      stale: items.filter((item) => item.status === 'stale').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      archived: archivedIndex.filter((stub) => stub.status === 'archived').length,
      filtered: archivedIndex.length
        + items.filter((item) => ['stale', 'skipped'].includes(String(item.status || ''))).length,
      selected: selected.length,
      ready: items.filter((item) => item.status === 'ready').length,
      inReview: items.filter((item) => item.status === 'in_review').length,
      applied: items.filter((item) => item.status === 'applied').length,
      questions: items.filter((item) => item.applicationState === 'blocked_by_question').length,
      handoffs: items.filter((item) => ['submission_unknown', 'blocked_by_antispam', 'blocked_by_captcha', 'blocked_by_mfa', 'blocked_by_human'].includes(String(item.applicationState || ''))).length,
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test 'tests/queue-ui-payload.test.mjs'`
Expected: PASS, 3/3.

- [ ] **Step 5: Add the Filtered disclosure to the page**

In `queue-ui/index.html`, replace the `last refresh` summary item (lines 41-44) with that item plus the new disclosure, so the strip reads:

```html
            <div class="summary-item">
              <span class="summary-value" id="lastRefresh">—</span>
              <span class="summary-label">last refresh</span>
            </div>
            <details class="summary-item summary-filtered">
              <summary class="summary-filtered-toggle">
                <span class="summary-value" id="filteredCount">—</span>
                <span class="summary-label">filtered out</span>
              </summary>
              <ul class="summary-breakdown">
                <li>Excluded <span id="filteredExcluded">—</span></li>
                <li>Skipped <span id="filteredSkipped">—</span></li>
                <li>Stale <span id="filteredStale">—</span></li>
                <li>Archived <span id="filteredArchived">—</span></li>
              </ul>
            </details>
```

In `queue-ui/app.js`, add to the `elements` object (keeping the existing rough alphabetical grouping):

```js
  filteredCount: document.querySelector('#filteredCount'),
  filteredExcluded: document.querySelector('#filteredExcluded'),
  filteredSkipped: document.querySelector('#filteredSkipped'),
  filteredStale: document.querySelector('#filteredStale'),
  filteredArchived: document.querySelector('#filteredArchived'),
```

In `renderSummary`, add before the closing brace:

```js
  elements.filteredCount.textContent = String(totals.filtered ?? 0);
  elements.filteredExcluded.textContent = String(totals.excluded ?? 0);
  elements.filteredSkipped.textContent = String(totals.skipped ?? 0);
  elements.filteredStale.textContent = String(totals.stale ?? 0);
  elements.filteredArchived.textContent = String(totals.archived ?? 0);
```

In `queue-ui/styles.css`, change `.summary-strip`'s `grid-template-columns: repeat(3, 1fr);` to `repeat(4, 1fr);` and add after the `.summary-label` rule:

```css
.summary-filtered { cursor: pointer; }

.summary-filtered-toggle {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}

.summary-filtered-toggle::-webkit-details-marker { display: none; }

.summary-breakdown {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  color: var(--ink-faint);
  font-size: 12px;
}

.summary-breakdown li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
```

The mobile rule at line 584 (`.summary-item:last-child { grid-column: 1 / -1; ... }`) already handles a fourth tile wrapping to a full-width row at `repeat(2, 1fr)` — leave it as is.

No inline `<script>` or `<style>` is introduced, so the CSP at `queue-ui.mjs:518` (`default-src 'self'; script-src 'self'; style-src 'self'`) still holds.

- [ ] **Step 6: Verify in the browser**

Run the server and load the page:

```bash
node queue-ui.mjs --serve
```

Open `http://127.0.0.1:47831/`. Confirm: four summary tiles; `filtered out` shows a number; clicking it expands the four-row breakdown; the browser console reports no CSP violations and no errors. Stop the server when done.

- [ ] **Step 7: Run the full suite**

Run: `node --test 'tests/*.test.mjs'`
Expected: PASS, 280/280.

- [ ] **Step 8: Commit**

```bash
git add queue-ui.mjs queue-ui/index.html queue-ui/app.js queue-ui/styles.css tests/queue-ui-payload.test.mjs && git commit -m "feat(queue-ui): source dead-end counts from the archived index"
```

---

### Task 7: Migrate the live queue and record the new state

**Files:**
- Modify: `.tracker/PROJECT_TRUTH.md`
- Data (gitignored, not committed): `data/job-queue.json`, `data/job-queue-archive.json`

**Interfaces:**
- Consumes: everything from Tasks 1-6.

The archive tier only takes effect on the first write after the code lands. This task performs that write against the real queue and confirms the measured outcome matches the spec's projection (1282 items → 634 live, 671 stubs, ~5.4 MB → ~3.4 MB live).

- [ ] **Step 1: Record the before state**

```bash
node -e "const s=require('./data/job-queue.json');const c={};for(const i of s.items)c[i.status]=(c[i.status]||0)+1;console.log(JSON.stringify({items:s.items.length,bytes:require('fs').statSync('data/job-queue.json').size,c},null,2))"
```

Record the output. Expected shape: ~1282 items, ~5.4 MB, statuses dominated by `excluded` and `in_review`.

- [ ] **Step 2: Trigger the migrating write**

The live queue is migrated by any `saveQueue` call. Use the lowest-risk one — a no-op rehydrate dry run confirms the archive path is reachable first, then a real refresh performs the write:

```bash
node queue.mjs rehydrate --dry-run
```

Expected: `Rehydrate (dry run): 0 archived record(s).` (the archive does not exist yet, so it reads as empty and nothing is written).

```bash
node queue.mjs refresh --skip-public --skip-outreach
```

Expected: normal refresh output, and `data/job-queue-archive.json` now exists.

- [ ] **Step 3: Verify the migration**

```bash
node queue.mjs verify
```
Expected: `✅ Queue valid: <live> live item(s), <n> selected, <archived> archived.` with no errors.

```bash
node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('data/job-queue.json'));const a=JSON.parse(fs.readFileSync('data/job-queue-archive.json'));console.log(JSON.stringify({live:s.items.length,stubs:s.archivedIndex.length,records:a.records.length,liveBytes:fs.statSync('data/job-queue.json').size,archiveBytes:fs.statSync('data/job-queue-archive.json').size},null,2))"
```

Expected: `stubs === records`, live item count roughly half the before count, live file roughly 3.4 MB. If `stubs !== records`, stop — that is the integrity invariant Task 5 checks, and it failing here means a writer bypassed `saveQueue`.

```bash
node verify-pipeline.mjs
```
Expected: clean.

- [ ] **Step 4: Update the truth file**

Edit `.tracker/PROJECT_TRUTH.md`. Overwrite the `Current State` / `Current Position` snapshot sections in place — do not append a dated block. Add one line to `Recent Progress` (newest first, cap 15) recording the archive tier landing with the measured before/after numbers from Step 3. Keep the file under the 25 KB ceiling.

```bash
node ~/AIOS/bin/trim-state-files.mjs --check
```
Expected: no over-cap files reported for career-ops.

- [ ] **Step 5: Commit**

```bash
git add .tracker/PROJECT_TRUTH.md && git commit -m "docs: record the queue archive tier migration in project truth"
```

---

## Self-Review

**Spec coverage** (Feature 3, spec lines 198-359):

| Spec requirement | Task |
|------------------|------|
| Cost table / motivation | context only, no code |
| Never evict `skipped` / `applied` | 1 (`EVICTABLE_STATUSES`, tested), 3 (tested end to end) |
| Eviction on status not age; `stale` stays live | 1 |
| Two files, full records in the sidecar, stub shape | 1 |
| `evictToArchive` / `archiveStub` API | 1 |
| `saveQueue` evicts before writing, writes both files | 3 |
| Read-modify-write archive, no duplicates on re-eviction | 1 (tested), 3 |
| `buildQueue` loads `archivedIndex`; suppression when unobserved | 2 |
| Reactivation: `firstSeenAt` carried, `reactivatedAt` stamped, stub removed | 2 |
| Re-observed `excluded` rescored and possibly re-evicted same write | 2 (status test), 4 (rehydrate round trip) |
| `rehydrate [--blocker] [--dry-run]`, no network calls | 4 |
| Counts must not lie: `excluded`/`archived` from the index, `retained` = live + index | 6 |
| `Filtered (N)` disclosure | 6 (adds it — see the scope note in that task) |
| Integrity: stub not live, stub resolves to a record, no live evicted status | 5 |
| Missing archive → empty, created on first eviction | 1 (tested), 3 (tested) |
| Unparseable archive → abort before writing either file | 1 (throws), 3 (tested: live file unchanged) |
| Archive grows unbounded; hand-editing no longer resurrects rows | accepted, no code |

**Placeholder scan:** every code step carries complete code; every command step carries an exact command and expected output. No "TBD", no "add error handling", no "similar to Task N".

**Type consistency:** `archiveStub(item, now)` is called with two arguments in Task 1's implementation and one in the spec's prose — the second parameter defaults, so both hold. `evictToArchive` returns `{ state, archive, evicted, index }` and every consumer (Task 3's `saveQueue`) uses exactly those names. `saveQueue(root, state)` returns state in Task 3 and that return is consumed in Task 3's `refresh` and Task 4's `rehydrateQueue`. `readArchive` returns `{ schemaVersion, updatedAt, records }` and every consumer reads `.records`. `queuePayload(state)` is exported in Task 6 and imported under that name by its test.

**Known cross-task ordering constraint:** Task 3's tests import `saveQueue` from `queue.mjs`, which imports `queue-archive.mjs` (Task 1) and depends on `buildQueue`'s `archivedIndex` (Task 2). Tasks must be executed in order.
