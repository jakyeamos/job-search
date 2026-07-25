# Queue Auto-Refill + Application Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the daily queue topped up to 10 roles scoring at least 4.0, and give applied jobs a six-column kanban board over `data/applications.md` so they stay visible after they leave the queue.

**Architecture:** Selection logic moves out of `buildQueue` into two new pure exports in `queue-lib.mjs` — `selectDailyQueue` (filter, floor, sort, diversity-cap) and `topUpSelection` (pin the incumbents, fill the gap, renumber ranks). `queue-ui.mjs` calls `topUpSelection` on every mutation and on every queue read. A new `tracker-board.mjs` reads and writes `data/applications.md` through the existing `tracker-parse.mjs` / `tracker-utils.mjs` helpers, exposed over three JSON endpoints and rendered by a second vanilla page, `queue-ui/board.html` + `queue-ui/board.js`.

**Tech Stack:** Node.js ESM (`.mjs`), no build step, no runtime dependencies. Tests use `node:test` + `node:assert/strict`, run with `node --test tests/<file>`. Front end is vanilla ES modules served by the `queue-ui.mjs` static handler.

**Spec:** `docs/superpowers/specs/2026-07-25-queue-refill-and-application-board-design.md`

## Global Constraints

- **No new dependencies.** `package.json` has no `test` or `lint` script; tests run directly with `node --test tests/<file>`.
- **Fit-score floor is `APPLY_THRESHOLD`** (`queue-lib.mjs:20`, value `4.0`). Do not introduce a second constant.
- **Default queue size is `DEFAULT_QUEUE_LIMIT`** (`queue-lib.mjs:18`, value `10`).
- **Pinned items bypass `minFitScore`.** They are incumbents already shown to the user. The floor governs what the top-up *adds*.
- **Board columns are exactly six, in this order:** `Applied` · `Responded` · `Interview` · `Offer` · `Rejected` · `Discarded`. `Evaluated` and `SKIP` are excluded.
- **The board never adds rows to `data/applications.md`.** It only rewrites the Status and Notes cells of existing rows. Adding rows goes through `batch/tracker-additions/` + `merge-tracker.mjs` (CLAUDE.md rule).
- **Sanitize every value written into a tracker cell:** `|`, `\r`, and `\n` become spaces, matching `escapeTable` (`queue.mjs:250`). A raw pipe in a note splits the row into new columns.
- **CSP is `default-src 'self'; script-src 'self'; style-src 'self'`** (`queue-ui.mjs:518`). `board.html` must have no inline `<script>`, no inline `<style>`, and no `style="..."` attributes. Style through classes in `styles.css` only.
- **`data/` is gitignored.** Never commit `data/applications.md` or `data/job-queue.json`. Tests build their own fixtures in `mkdtempSync` temp dirs.
- **Commit messages:** no `--no-verify`, no `--no-gpg-sign`.

## File Structure

| File | Responsibility |
|------|----------------|
| `apply/application-recommendations.mjs` (modify) | Greedy diversity-capped selection; gains a `pinned` option that seeds the caps |
| `queue-lib.mjs` (modify) | Adds `selectDailyQueue` and `topUpSelection`; `buildQueue` delegates to the former |
| `queue-ui.mjs` (modify) | Calls `topUpSelection` on mutation and read; fixes `--limit 6` → `10`; serves three `/api/board*` endpoints |
| `tracker-board.mjs` (create) | Read/write board state over `data/applications.md`. No HTTP, no queue knowledge |
| `queue-ui/board.html` (create) | Board page markup and topbar navigation |
| `queue-ui/board.js` (create) | Board rendering, drag-and-drop, notes editing |
| `queue-ui/index.html` (modify) | Board link in the topbar; "best six" copy corrected to ten |
| `queue-ui/styles.css` (modify) | Board column and card styles |
| `tests/application-recommendations.test.mjs` (modify) | `pinned` coverage |
| `tests/queue-topup.test.mjs` (create) | `selectDailyQueue` and `topUpSelection` coverage |
| `tests/tracker-board.test.mjs` (create) | `tracker-board.mjs` coverage against temp fixtures |

`board.js` deliberately carries its own three-line `escapeHtml` / `requestJson` / `showToast` helpers rather than importing from `app.js`. Those helpers are bound to `app.js`'s module-scoped `ui` and `elements` objects; a shared module would mean refactoring the working queue page for no gain on a second, independent page.

---

### Task 1: Pinned selections in `selectApplicationRecommendations`

**Files:**
- Modify: `apply/application-recommendations.mjs:66-93`
- Test: `tests/application-recommendations.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `selectApplicationRecommendations(items, { limit, maxPerCompany, maxPerJobFamily, compare, pinned })` — `pinned` is an optional `Array<item>`; pinned items are emitted first in the given order, seed `companyCounts` / `familyCounts`, are skipped if they reappear in `items`, and are never dropped even if `pinned.length >= limit`. Defaults to `[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/application-recommendations.test.mjs`:

```js
test('pinned items lead the result and seed the company cap', () => {
  const incumbent = { id: 'pin-1', company: 'Acme', title: 'Backend Engineer', fitScore: 4.1 };
  const items = [
    { id: 'a', company: 'Acme', title: 'Platform Engineer', fitScore: 4.9 },
    { id: 'b', company: 'Globex', title: 'Data Engineer', fitScore: 4.2 },
  ];
  const selected = selectApplicationRecommendations(items, { limit: 3, pinned: [incumbent] });
  assert.deepEqual(selected.map((item) => item.id), ['pin-1', 'b']);
});

test('pinned items keep their given order ahead of higher scorers', () => {
  const pinned = [
    { id: 'pin-low', company: 'Acme', title: 'Backend Engineer', fitScore: 4.0 },
    { id: 'pin-high', company: 'Globex', title: 'Data Engineer', fitScore: 4.8 },
  ];
  const items = [{ id: 'c', company: 'Initech', title: 'Site Reliability Engineer', fitScore: 4.9 }];
  const selected = selectApplicationRecommendations(items, { limit: 3, pinned });
  assert.deepEqual(selected.map((item) => item.id), ['pin-low', 'pin-high', 'c']);
});

test('an item repeated in pinned and items is emitted once', () => {
  const shared = { id: 'dup', company: 'Acme', title: 'Backend Engineer', fitScore: 4.4 };
  const selected = selectApplicationRecommendations([shared], { limit: 5, pinned: [shared] });
  assert.deepEqual(selected.map((item) => item.id), ['dup']);
});

test('pinned items are never dropped to honour the limit', () => {
  const pinned = [
    { id: 'p1', company: 'Acme', title: 'Backend Engineer', fitScore: 4.1 },
    { id: 'p2', company: 'Globex', title: 'Data Engineer', fitScore: 4.2 },
  ];
  const items = [{ id: 'c', company: 'Initech', title: 'Site Reliability Engineer', fitScore: 4.9 }];
  const selected = selectApplicationRecommendations(items, { limit: 1, pinned });
  assert.deepEqual(selected.map((item) => item.id), ['p1', 'p2']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test tests/application-recommendations.test.mjs
```

Expected: FAIL — the first test returns `['a', 'b']` (Acme selected twice, pinned ignored).

- [ ] **Step 3: Implement `pinned`**

In `apply/application-recommendations.mjs`, replace the body of `selectApplicationRecommendations` from the `companyCounts` declaration to the `return`:

```js
  const companyCounts = new Map();
  const familyCounts = new Map();
  const pinned = Array.isArray(options.pinned) ? options.pinned : [];
  const pinnedIds = new Set(pinned.map((item) => item?.id).filter(Boolean));
  const selected = [];

  for (const item of pinned) {
    const company = companyRecommendationKey(item);
    const family = recommendationGroupKey(item);
    selected.push(item);
    companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
  }

  for (const item of [...items].sort(compare)) {
    if (selected.length >= limit) break;
    if (item?.id && pinnedIds.has(item.id)) continue;
    const company = companyRecommendationKey(item);
    const family = recommendationGroupKey(item);
    if ((companyCounts.get(company) || 0) >= maxPerCompany) continue;
    if ((familyCounts.get(family) || 0) >= maxPerJobFamily) continue;
    selected.push(item);
    companyCounts.set(company, (companyCounts.get(company) || 0) + 1);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
  }

  return selected;
```

Also extend the JSDoc `@param` above the function to document the new option:

```js
 * @param {{ limit?: number, maxPerCompany?: number, maxPerJobFamily?: number, compare?: Function, pinned?: Array<Record<string, unknown>> }} [options]
```

Note the limit check moved from after the push to the top of the loop. For an empty `pinned` this is identical behaviour: the old code broke once `selected.length >= limit` after pushing, the new code breaks before pushing the item that would exceed it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test tests/application-recommendations.test.mjs
```

Expected: PASS — 8 tests, 0 fail. The four pre-existing tests must still pass, proving `pinned: []` is a no-op for existing callers.

- [ ] **Step 5: Commit**

```bash
git add apply/application-recommendations.mjs tests/application-recommendations.test.mjs && git commit -m "feat(queue): seed recommendation caps with pinned incumbents"
```

---

### Task 2: Extract `selectDailyQueue` with a fit-score floor

**Files:**
- Modify: `queue-lib.mjs:490-562` (add export above `buildQueue`, replace the inlined selection block)
- Test: `tests/queue-topup.test.mjs` (create)

**Interfaces:**
- Consumes: `selectApplicationRecommendations(items, { ..., pinned })` from Task 1.
- Produces: `selectDailyQueue(items, { limit = DEFAULT_QUEUE_LIMIT, minFitScore = APPLY_THRESHOLD, maxPerCompany, maxPerJobFamily, pinned = [] }) -> Array<item>`. Returns pinned items first, then the highest-`sortScore` eligible items at or above `minFitScore`, respecting the diversity caps.

- [ ] **Step 1: Write the failing test**

Create `tests/queue-topup.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { APPLY_THRESHOLD, DEFAULT_QUEUE_LIMIT, selectDailyQueue } from '../queue-lib.mjs';

/** @param {Record<string, unknown>} overrides */
function item(overrides) {
  return {
    id: 'x',
    company: 'Acme',
    title: 'Backend Engineer',
    status: 'ready',
    source: 'greenhouse',
    fitScore: 4.5,
    freshness: 'fresh',
    ...overrides,
  };
}

test('constants are the documented defaults', () => {
  assert.equal(APPLY_THRESHOLD, 4.0);
  assert.equal(DEFAULT_QUEUE_LIMIT, 10);
});

test('items below the fit-score floor are never selected', () => {
  const pool = [
    item({ id: 'high', fitScore: 4.4 }),
    item({ id: 'low', company: 'Globex', title: 'Data Engineer', fitScore: 3.9 }),
  ];
  const selected = selectDailyQueue(pool, { limit: 10 });
  assert.deepEqual(selected.map((entry) => entry.id), ['high']);
});

test('the floor is configurable and lets sub-threshold items through when lowered', () => {
  const pool = [item({ id: 'low', fitScore: 3.7 })];
  assert.equal(selectDailyQueue(pool, { limit: 10 }).length, 0);
  assert.equal(selectDailyQueue(pool, { limit: 10, minFitScore: 3.5 }).length, 1);
});

test('ineligible statuses are excluded regardless of score', () => {
  const pool = [
    item({ id: 'applied', status: 'applied', fitScore: 5 }),
    item({ id: 'skipped', company: 'Globex', title: 'Data Engineer', status: 'skipped', fitScore: 5 }),
    item({ id: 'excluded', company: 'Initech', title: 'Site Reliability Engineer', status: 'excluded', fitScore: 5 }),
    item({ id: 'ok', company: 'Umbrella', title: 'Platform Engineer', fitScore: 4.1 }),
  ];
  assert.deepEqual(selectDailyQueue(pool, { limit: 10 }).map((entry) => entry.id), ['ok']);
});

test('pinned incumbents lead the selection and bypass the floor', () => {
  const incumbent = item({ id: 'pinned-low', fitScore: 3.2 });
  const pool = [incumbent, item({ id: 'fresh', company: 'Globex', title: 'Data Engineer', fitScore: 4.6 })];
  const selected = selectDailyQueue(pool, { limit: 10, pinned: [incumbent] });
  assert.deepEqual(selected.map((entry) => entry.id), ['pinned-low', 'fresh']);
});

test('the per-company cap holds across the pin boundary', () => {
  const incumbent = item({ id: 'acme-1', fitScore: 4.1 });
  const pool = [incumbent, item({ id: 'acme-2', title: 'Platform Engineer', fitScore: 4.9 })];
  const selected = selectDailyQueue(pool, { limit: 10, pinned: [incumbent] });
  assert.deepEqual(selected.map((entry) => entry.id), ['acme-1']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/queue-topup.test.mjs
```

Expected: FAIL — `SyntaxError: The requested module '../queue-lib.mjs' does not provide an export named 'selectDailyQueue'`.

- [ ] **Step 3: Implement `selectDailyQueue` and make `buildQueue` use it**

In `queue-lib.mjs`, insert immediately above the `buildQueue` JSDoc block (before line 486):

```js
/**
 * Pick the roles worth showing today: eligible, at or above the fit floor, highest
 * sortScore first, capped for company and role-family diversity.
 * @param {Array<Record<string, unknown>>} items
 * @param {{ limit?: number, minFitScore?: number, maxPerCompany?: number, maxPerJobFamily?: number, pinned?: Array<Record<string, unknown>> }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function selectDailyQueue(items, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || DEFAULT_QUEUE_LIMIT)));
  const minFitScore = Number.isFinite(Number(options.minFitScore))
    ? Number(options.minFitScore)
    : APPLY_THRESHOLD;
  const pinned = Array.isArray(options.pinned) ? options.pinned : [];
  const pinnedIds = new Set(pinned.map((item) => item?.id).filter(Boolean));
  const candidates = [...items]
    .filter((item) => !(item?.id && pinnedIds.has(item.id)))
    .filter(eligibleForSelection)
    .filter((item) => Number(item.fitScore || 0) >= minFitScore)
    .sort((a, b) => sortScore(b) - sortScore(a));
  return selectApplicationRecommendations(candidates, {
    limit,
    maxPerCompany: options.maxPerCompany,
    maxPerJobFamily: options.maxPerJobFamily,
    pinned,
    compare: (left, right) => sortScore(right) - sortScore(left),
  });
}
```

Then in `buildQueue`, replace this block (currently `queue-lib.mjs:548-556`):

```js
  const selectionCandidates = [...merged.values()]
    .filter(eligibleForSelection)
    .sort((a, b) => sortScore(b) - sortScore(a));
  const selected = selectApplicationRecommendations(selectionCandidates, {
    limit,
    maxPerCompany: options.maxPerCompany,
    maxPerJobFamily: options.maxPerJobFamily,
    compare: (left, right) => sortScore(right) - sortScore(left),
  });
```

with:

```js
  const selected = selectDailyQueue([...merged.values()], {
    limit,
    minFitScore: options.minFitScore,
    maxPerCompany: options.maxPerCompany,
    maxPerJobFamily: options.maxPerJobFamily,
  });
```

And extend the `buildQueue` `@param` JSDoc (line 488) to include the new option:

```js
 * @param {{ limit?: number, now?: string, retainUnseen?: boolean, minFitScore?: number, maxPerCompany?: number, maxPerJobFamily?: number }} [options]
```

- [ ] **Step 4: Run the new test and the full suite**

```bash
node --test tests/queue-topup.test.mjs
```

Expected: PASS — 6 tests, 0 fail.

```bash
node --test tests/
```

Expected: PASS. This is the gate that catches queue tests written against the old floor-free selection. If a pre-existing test now fails because it selected a sub-4.0 item, fix the test's fixture scores — the floor is the intended new behaviour, not a regression.

- [ ] **Step 5: Commit**

```bash
git add queue-lib.mjs tests/queue-topup.test.mjs && git commit -m "feat(queue): extract selectDailyQueue with a 4.0 fit-score floor"
```

---

### Task 3: `topUpSelection`

**Files:**
- Modify: `queue-lib.mjs` (add export directly below `selectDailyQueue`)
- Test: `tests/queue-topup.test.mjs`

**Interfaces:**
- Consumes: `selectDailyQueue` from Task 2.
- Produces: `topUpSelection(state, options) -> { state, added, shortBy }`. `state` is a queue state object (`{ items: [...] }`); the returned `state` is a new object with a new `items` array in which `selectedForToday` and `queueRank` have been rewritten, ranks contiguous from 1. `added` is how many roles the top-up brought in. `shortBy` is how far below `limit` the result landed. `options` accepts the same `limit` / `minFitScore` / `maxPerCompany` / `maxPerJobFamily` as `selectDailyQueue`.

- [ ] **Step 1: Write the failing test**

Append to `tests/queue-topup.test.mjs` (and add `topUpSelection` to the existing import from `../queue-lib.mjs`):

```js
/** @param {number} count @param {Record<string, unknown>} overrides */
function pool(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => item({
    id: `pool-${index}`,
    company: `Company ${index}`,
    title: `Backend Engineer ${index}`,
    fitScore: 4.5,
    ...overrides,
  }));
}

test('a full selection is left alone', () => {
  const items = pool(12).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 10,
    queueRank: index < 10 ? index + 1 : null,
  }));
  const result = topUpSelection({ items });
  assert.equal(result.added, 0);
  assert.equal(result.shortBy, 0);
  assert.deepEqual(
    result.state.items.filter((entry) => entry.selectedForToday).map((entry) => entry.id),
    items.slice(0, 10).map((entry) => entry.id),
  );
});

test('a drained selection is topped back up to ten', () => {
  const items = pool(30).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 5,
    queueRank: index < 5 ? index + 1 : null,
  }));
  const result = topUpSelection({ items });
  assert.equal(result.added, 5);
  assert.equal(result.shortBy, 0);
  assert.equal(result.state.items.filter((entry) => entry.selectedForToday).length, 10);
});

test('incumbents keep their slots and their relative order', () => {
  const items = pool(30).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 3,
    queueRank: index < 3 ? 3 - index : null,
  }));
  const result = topUpSelection({ items });
  const ranked = result.state.items
    .filter((entry) => entry.selectedForToday)
    .sort((left, right) => left.queueRank - right.queueRank);
  assert.deepEqual(ranked.slice(0, 3).map((entry) => entry.id), ['pool-2', 'pool-1', 'pool-0']);
});

test('queue ranks come out contiguous from one', () => {
  const items = pool(30).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 4,
    queueRank: index < 4 ? (index + 1) * 7 : null,
  }));
  const result = topUpSelection({ items });
  const ranks = result.state.items
    .filter((entry) => entry.selectedForToday)
    .map((entry) => entry.queueRank)
    .sort((left, right) => left - right);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(result.state.items.every((entry) => entry.selectedForToday || entry.queueRank === null));
});

test('the per-company cap survives the top-up', () => {
  const items = [
    { ...item({ id: 'acme-1', fitScore: 4.1 }), selectedForToday: true, queueRank: 1 },
    item({ id: 'acme-2', title: 'Platform Engineer', fitScore: 4.9 }),
    item({ id: 'globex', company: 'Globex', title: 'Data Engineer', fitScore: 4.2 }),
  ];
  const result = topUpSelection({ items });
  assert.deepEqual(
    result.state.items.filter((entry) => entry.selectedForToday).map((entry) => entry.id),
    ['acme-1', 'globex'],
  );
});

test('an exhausted pool reports shortBy instead of throwing', () => {
  const result = topUpSelection({ items: [] });
  assert.equal(result.added, 0);
  assert.equal(result.shortBy, 10);
  assert.deepEqual(result.state.items, []);
});

test('sub-threshold items are not used to pad a short queue', () => {
  const items = pool(30, { fitScore: 3.9 });
  const result = topUpSelection({ items });
  assert.equal(result.added, 0);
  assert.equal(result.shortBy, 10);
});

test('the input state is not mutated', () => {
  const items = pool(20).map((entry, index) => ({
    ...entry,
    selectedForToday: index < 2,
    queueRank: index < 2 ? index + 1 : null,
  }));
  const state = { items, generatedAt: '2026-07-25T00:00:00.000Z' };
  const result = topUpSelection(state);
  assert.equal(state.items.filter((entry) => entry.selectedForToday).length, 2);
  assert.equal(result.state.generatedAt, '2026-07-25T00:00:00.000Z');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/queue-topup.test.mjs
```

Expected: FAIL — `does not provide an export named 'topUpSelection'`.

- [ ] **Step 3: Implement `topUpSelection`**

In `queue-lib.mjs`, directly below `selectDailyQueue`:

```js
/**
 * Refill today's selection back to `limit` from the already-scored pool, keeping the
 * roles the user is already looking at and renumbering ranks contiguously.
 * @param {Record<string, unknown>} state
 * @param {{ limit?: number, minFitScore?: number, maxPerCompany?: number, maxPerJobFamily?: number }} [options]
 * @returns {{ state: Record<string, unknown>, added: number, shortBy: number }}
 */
export function topUpSelection(state, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || DEFAULT_QUEUE_LIMIT)));
  const items = Array.isArray(state?.items) ? state.items : [];
  const pinned = items
    .filter((item) => item.selectedForToday)
    .sort((left, right) => Number(left.queueRank || 999) - Number(right.queueRank || 999));
  const selected = pinned.length >= limit ? pinned : selectDailyQueue(items, {
    limit,
    minFitScore: options.minFitScore,
    maxPerCompany: options.maxPerCompany,
    maxPerJobFamily: options.maxPerJobFamily,
    pinned,
  });
  const ranks = new Map(selected.map((item, index) => [item.id, index + 1]));
  const nextItems = items.map((item) => ({
    ...item,
    selectedForToday: ranks.has(item.id),
    queueRank: ranks.get(item.id) || null,
  }));
  return {
    state: { ...state, items: nextItems },
    added: Math.max(0, selected.length - pinned.length),
    shortBy: Math.max(0, limit - selected.length),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/queue-topup.test.mjs
```

Expected: PASS — 14 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add queue-lib.mjs tests/queue-topup.test.mjs && git commit -m "feat(queue): refill the daily selection back to ten"
```

---

### Task 4: Wire the refill into the queue server

**Files:**
- Modify: `queue-ui.mjs:1-25` (import), `:263-308` (`applyQueueAction`), `:310-318` (`refreshQueue`), `:524-527` (`GET /api/queue`)
- Modify: `queue-ui/index.html:51-52` (copy)

**Interfaces:**
- Consumes: `topUpSelection(state, options)` from Task 3, returning `{ state, added, shortBy }`.
- Produces: no new exports. `POST /api/action` and `GET /api/queue` now return a payload whose `selected` array is refilled to ten.

- [ ] **Step 1: Import `topUpSelection`**

In `queue-ui.mjs`, change the `queue-lib.mjs` import (line 12) from:

```js
import { DEFAULT_CONTACT_DISCOVERY_LIMIT, normalizeUrl, readQueueState } from './queue-lib.mjs';
```

to:

```js
import { DEFAULT_CONTACT_DISCOVERY_LIMIT, normalizeUrl, readQueueState, topUpSelection } from './queue-lib.mjs';
```

- [ ] **Step 2: Refill after every mutation**

At the end of `applyQueueAction`, replace:

```js
  state.generatedAt = new Date().toISOString();
  saveQueue(ROOT, state);
  return { state: queuePayload(state), item, action };
```

with:

```js
  state.generatedAt = new Date().toISOString();
  const refilled = topUpSelection(state).state;
  saveQueue(ROOT, refilled);
  return { state: queuePayload(refilled), item, action };
```

`item` stays the pre-refill object. `app.js`'s `mutateItem` only reads `payload.state`, so this is safe.

- [ ] **Step 3: Refill on read, and fix the refresh limit**

Replace the `GET /api/queue` handler (line 524):

```js
  if (request.method === 'GET' && requestUrl.pathname === '/api/queue') {
    sendJson(response, 200, queuePayload(loadState()));
    return;
  }
```

with:

```js
  if (request.method === 'GET' && requestUrl.pathname === '/api/queue') {
    const refill = topUpSelection(loadState());
    if (refill.added > 0) saveQueue(ROOT, refill.state);
    sendJson(response, 200, queuePayload(refill.state));
    return;
  }
```

In `refreshQueue` (line 310), change `'--limit', '6',` to `'--limit', '10',`.

In `queue-ui/index.html`, replace lines 51-52:

```html
              <h2 id="applicationRunHeading">Prepare the best six.</h2>
              <p id="applicationRunSubheading">Career Ops inspects each form, reuses verified answers, and leaves the final submission to you.</p>
```

with:

```html
              <h2 id="applicationRunHeading">Prepare the best ten.</h2>
              <p id="applicationRunSubheading">Career Ops inspects each form, reuses verified answers, and leaves the final submission to you.</p>
```

- [ ] **Step 4: Verify against a live server**

```bash
node queue-ui.mjs
```

In a second shell:

```bash
curl -s http://127.0.0.1:47831/api/queue | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const q=JSON.parse(s);console.log('selected',q.selected.length);console.log('ranks',q.selected.map(i=>i.queueRank).join(','));console.log('minScore',Math.min(...q.selected.map(i=>Number(i.fitScore))))})"
```

Expected: `selected 10`, `ranks 1,2,3,4,5,6,7,8,9,10`, `minScore` at or above `4`. Stop the server with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add queue-ui.mjs queue-ui/index.html && git commit -m "feat(queue-ui): refill the daily queue to ten on read and on action"
```

---

### Task 5: `readBoard`

**Files:**
- Create: `tracker-board.mjs`
- Test: `tests/tracker-board.test.mjs` (create)

**Interfaces:**
- Consumes: `resolveColumns(lines)` and `parseTrackerRow(line, colmap)` from `tracker-parse.mjs`.
- Produces:
  - `BOARD_COLUMNS` — frozen array `['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded']`
  - `sanitizeCell(value) -> string` — replaces `|`, `\r`, `\n` with spaces and trims
  - `readBoard(root) -> { columns: string[], cards: Array<{ num, date, company, role, score, status, report, notes }> }`, cards sorted by `num` descending. Throws `Error('data/applications.md is missing')` when the file is absent.

- [ ] **Step 1: Write the failing test**

Create `tests/tracker-board.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/tracker-board.test.mjs
```

Expected: FAIL — `Cannot find module '.../tracker-board.mjs'`.

- [ ] **Step 3: Create `tracker-board.mjs`**

```js
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';

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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/tracker-board.test.mjs
```

Expected: PASS — 5 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tracker-board.mjs tests/tracker-board.test.mjs && git commit -m "feat(board): read the application board from the tracker"
```

---

### Task 6: `setRowStatus` and `setRowNotes`

**Files:**
- Modify: `tracker-board.mjs`
- Test: `tests/tracker-board.test.mjs`

**Interfaces:**
- Consumes: `readBoard(root)`, `sanitizeCell(value)`, `BOARD_COLUMNS` from Task 5; `rebuildRow(parts)` from `tracker-utils.mjs`.
- Produces:
  - `setRowStatus(root, num, status) -> { columns, cards }` — writes the canonical capitalization of `status` and returns the freshly re-read board. Throws on an unknown status or an absent row number, leaving the file untouched.
  - `setRowNotes(root, num, notes) -> { columns, cards }` — writes `sanitizeCell(notes)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/tracker-board.test.mjs`, and add `setRowNotes, setRowStatus` to the existing `../tracker-board.mjs` import:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/tracker-board.test.mjs
```

Expected: FAIL — `does not provide an export named 'setRowStatus'`.

- [ ] **Step 3: Implement the writers**

In `tracker-board.mjs`, extend the `node:fs` import to `import { existsSync, readFileSync, writeFileSync } from 'node:fs';`, add `import { rebuildRow } from './tracker-utils.mjs';` below the `tracker-parse.mjs` import, and append:

```js
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
```

`setRowStatus` validates before `setCell` opens the file, so a bad status never reaches a write. `setCell` throws on an unknown row before `writeFileSync`, so an absent row never truncates the file.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/tracker-board.test.mjs
```

Expected: PASS — 11 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tracker-board.mjs tests/tracker-board.test.mjs && git commit -m "feat(board): write status and notes back to the tracker"
```

---

### Task 7: Board endpoints

**Files:**
- Modify: `queue-ui.mjs` (import block, a helper near `sendError` at `:50-53`, three routes after the `GET /api/queue` route at `:524`)

**Interfaces:**
- Consumes: `readBoard(root)`, `setRowStatus(root, num, status)`, `setRowNotes(root, num, notes)` from Tasks 5-6; `stringValue(payload, key)` (`queue-ui.mjs:258`), `readJsonBody`, `sendJson`, `sendError`.
- Produces: `GET /api/board` → `{ columns, cards }`; `POST /api/board/status` `{ num, status }` → `{ columns, cards }`; `POST /api/board/notes` `{ num, notes }` → `{ columns, cards }`.

- [ ] **Step 1: Import the board module and add a status-code helper**

In `queue-ui.mjs`, add below the existing `./queue-lib.mjs` import:

```js
import { readBoard, setRowNotes, setRowStatus } from './tracker-board.mjs';
```

Add directly below `sendError` (after line 53):

```js
/** Map a tracker-board error message onto an HTTP status. @param {string} message */
function boardErrorStatus(message) {
  if (/not found/i.test(message)) return 404;
  if (/is missing/i.test(message)) return 500;
  return 400;
}
```

- [ ] **Step 2: Add the three routes**

In `handleRequest`, immediately after the `GET /api/queue` block:

```js
  if (request.method === 'GET' && requestUrl.pathname === '/api/board') {
    try {
      sendJson(response, 200, readBoard(ROOT));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, boardErrorStatus(message), message);
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/board/status') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, setRowStatus(ROOT, Number(payload.num), stringValue(payload, 'status')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, boardErrorStatus(message), message);
    }
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/board/notes') {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, setRowNotes(ROOT, Number(payload.num), stringValue(payload, 'notes')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, boardErrorStatus(message), message);
    }
    return;
  }
```

- [ ] **Step 3: Verify against a live server**

Back up the tracker first — the next commands write to it:

```bash
cp data/applications.md /private/tmp/claude-501/-Users-jakyeamos-projects-career-ops/09fc5413-c023-48b0-81f9-18e86342e1ee/scratchpad/applications.md.bak
```

Start the server:

```bash
node queue-ui.mjs
```

In a second shell:

```bash
curl -s http://127.0.0.1:47831/api/board | head -c 400; echo; curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47831/api/board/status -H 'content-type: application/json' -d '{"num":999999,"status":"Offer"}'; curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:47831/api/board/status -H 'content-type: application/json' -d '{"num":105,"status":"Evaluated"}'
```

Expected: a JSON body starting `{"columns":["Applied","Responded",...`, then `404`, then `400`. Confirm the tracker is unchanged:

```bash
diff data/applications.md /private/tmp/claude-501/-Users-jakyeamos-projects-career-ops/09fc5413-c023-48b0-81f9-18e86342e1ee/scratchpad/applications.md.bak && echo "tracker unchanged"
```

Expected: `tracker unchanged`. Stop the server with Ctrl-C.

- [ ] **Step 4: Run the full suite**

```bash
node --test tests/
```

Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add queue-ui.mjs && git commit -m "feat(queue-ui): serve the application board over three endpoints"
```

---

### Task 8: Board page

**Files:**
- Create: `queue-ui/board.html`, `queue-ui/board.js`
- Modify: `queue-ui/index.html:13-16` (topbar link), `queue-ui/styles.css` (append board styles)

**Interfaces:**
- Consumes: `GET /api/board`, `POST /api/board/status`, `POST /api/board/notes` from Task 7, each returning `{ columns: string[], cards: Array<{ num, date, company, role, score, status, report, notes }> }`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Create `queue-ui/board.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#eef3f0">
    <title>Application board · career-ops</title>
    <link rel="stylesheet" href="/styles.css">
    <script type="module" src="/board.js"></script>
  </head>
  <body>
    <div class="app-shell">
      <header class="topbar">
        <a class="wordmark" href="/board.html" aria-label="Career operations application board">
          <span>career-ops</span><span class="wordmark-slash">/</span><span class="wordmark-current">application board</span>
        </a>
        <div class="topbar-actions">
          <span class="connection-status" id="connectionStatus"><span class="status-dot" aria-hidden="true"></span>Local board</span>
          <a class="button button-quiet" href="/">Daily queue</a>
        </div>
      </header>

      <main>
        <section class="intro intro-solo" aria-labelledby="pageTitle">
          <div class="intro-copy">
            <p class="kicker">After the application</p>
            <h1 id="pageTitle">Track what happens next.</h1>
            <p class="intro-lede">Every row in your tracker that has left the queue. Drag a card to change its stage; notes save when you click away.</p>
          </div>
        </section>

        <section class="queue-section" aria-labelledby="boardHeading">
          <div class="section-heading">
            <div>
              <h2 id="boardHeading">Pipeline</h2>
              <p id="boardSummary">Loading…</p>
            </div>
          </div>
          <div class="board" id="board" aria-busy="true"></div>
        </section>
      </main>

      <div class="toast" id="toast" role="status" aria-live="polite"></div>
    </div>
  </body>
</html>
```

- [ ] **Step 2: Create `queue-ui/board.js`**

```js
const elements = {
  board: document.getElementById('board'),
  boardSummary: document.getElementById('boardSummary'),
  connectionStatus: document.getElementById('connectionStatus'),
  toast: document.getElementById('toast'),
};

const ui = { board: { columns: [], cards: [] }, toastTimer: 0 };

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {boolean} ok */
function setConnection(ok) {
  elements.connectionStatus.querySelector('.status-dot').classList.toggle('is-error', !ok);
  elements.connectionStatus.lastChild.textContent = ok ? 'Local board' : 'Board unavailable';
}

/** @param {string} message @param {boolean} isError */
function showToast(message, isError = false) {
  clearTimeout(ui.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.classList.add('is-visible');
  ui.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 3400);
}

/** @param {string} url @param {RequestInit} options */
async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

/** The report cell is markdown like `[055](../reports/055-acme-2026-07-24.md)`. */
function reportLink(report) {
  const match = /\[([^\]]+)\]\(([^)]+)\)/.exec(String(report || ''));
  if (!match) return '';
  return `<span class="board-card-report">Report ${escapeHtml(match[1])}</span>`;
}

function renderCard(card) {
  return `
    <article class="board-card" draggable="true" data-num="${escapeHtml(card.num)}">
      <div class="board-card-head">
        <h3>${escapeHtml(card.role)}</h3>
        <span class="score-badge">${escapeHtml(card.score)}</span>
      </div>
      <p class="board-card-company">${escapeHtml(card.company)}</p>
      <div class="queue-meta">
        <span class="tag">#${escapeHtml(card.num)}</span>
        <span class="tag">${escapeHtml(card.date)}</span>
        ${reportLink(card.report)}
      </div>
      <textarea class="board-card-notes" rows="2" data-num="${escapeHtml(card.num)}" aria-label="Notes for ${escapeHtml(card.company)}">${escapeHtml(card.notes)}</textarea>
    </article>`;
}

function render() {
  const { columns, cards } = ui.board;
  elements.board.setAttribute('aria-busy', 'false');
  elements.board.innerHTML = columns.map((column) => {
    const columnCards = cards.filter((card) => card.status === column);
    const body = columnCards.length
      ? columnCards.map(renderCard).join('')
      : '<p class="board-column-empty">Nothing here yet.</p>';
    return `
      <section class="board-column" data-status="${escapeHtml(column)}" aria-label="${escapeHtml(column)}">
        <header class="board-column-head">
          <h3>${escapeHtml(column)}</h3>
          <span class="tag">${columnCards.length}</span>
        </header>
        <div class="board-column-body">${body}</div>
      </section>`;
  }).join('');
  elements.boardSummary.textContent = `${cards.length} application${cards.length === 1 ? '' : 's'} across ${columns.length} stages.`;
}

async function loadBoard() {
  try {
    ui.board = await requestJson('/api/board');
    setConnection(true);
    render();
  } catch (error) {
    setConnection(false);
    elements.board.setAttribute('aria-busy', 'false');
    elements.board.innerHTML = '<div class="empty-state"><h3>Could not load the board.</h3><p>Make sure the local queue server is running, then reload.</p></div>';
    showToast(error instanceof Error ? error.message : String(error), true);
  }
}

/** @param {string} url @param {Record<string, unknown>} body @param {string} message */
async function postBoard(url, body, message) {
  try {
    ui.board = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    setConnection(true);
    render();
    showToast(message);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
    await loadBoard();
  }
}

elements.board.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.board-card');
  if (!card) return;
  event.dataTransfer.setData('text/plain', card.dataset.num);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('is-dragging');
});

elements.board.addEventListener('dragend', (event) => {
  event.target.closest('.board-card')?.classList.remove('is-dragging');
});

elements.board.addEventListener('dragover', (event) => {
  const column = event.target.closest('.board-column');
  if (!column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  column.classList.add('is-drop-target');
});

elements.board.addEventListener('dragleave', (event) => {
  event.target.closest('.board-column')?.classList.remove('is-drop-target');
});

elements.board.addEventListener('drop', (event) => {
  const column = event.target.closest('.board-column');
  if (!column) return;
  event.preventDefault();
  column.classList.remove('is-drop-target');
  const num = Number(event.dataTransfer.getData('text/plain'));
  const status = column.dataset.status;
  const card = ui.board.cards.find((entry) => entry.num === num);
  if (!card || card.status === status) return;
  postBoard('/api/board/status', { num, status }, `Moved #${num} to ${status}.`);
});

elements.board.addEventListener('focusout', (event) => {
  const field = event.target.closest('.board-card-notes');
  if (!field) return;
  const num = Number(field.dataset.num);
  const card = ui.board.cards.find((entry) => entry.num === num);
  if (!card || card.notes === field.value.trim()) return;
  postBoard('/api/board/notes', { num, notes: field.value }, `Saved notes on #${num}.`);
});

loadBoard();
```

- [ ] **Step 3: Add the topbar link on the queue page and the board styles**

In `queue-ui/index.html`, replace the `topbar-actions` block (lines 17-21):

```html
        <div class="topbar-actions">
          <span class="connection-status" id="connectionStatus"><span class="status-dot" aria-hidden="true"></span>Local queue</span>
          <button class="button button-quiet" id="refreshButton" type="button">Refresh sources</button>
          <button class="button button-primary" id="clearQueueButton" type="button">Prepare today’s packets</button>
        </div>
```

with:

```html
        <div class="topbar-actions">
          <span class="connection-status" id="connectionStatus"><span class="status-dot" aria-hidden="true"></span>Local queue</span>
          <a class="button button-quiet" href="/board.html">Application board</a>
          <button class="button button-quiet" id="refreshButton" type="button">Refresh sources</button>
          <button class="button button-primary" id="clearQueueButton" type="button">Prepare today’s packets</button>
        </div>
```

Append to `queue-ui/styles.css`. `.intro` is a two-column grid whose second column holds the queue page's summary strip; the board page has no such block, so `.intro-solo` collapses it to one column rather than leaving the copy squeezed into 60% of the width:

```css
.intro-solo { grid-template-columns: minmax(0, 1fr); }

.board {
  display: grid;
  grid-auto-columns: minmax(248px, 1fr);
  grid-auto-flow: column;
  gap: 14px;
  overflow-x: auto;
  padding-bottom: 12px;
}

.board-column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-soft);
}

.board-column.is-drop-target { border-color: var(--accent); background: var(--accent-wash); }

.board-column-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.board-column-head h3 { margin: 0; font-size: 14px; letter-spacing: -0.01em; }
.board-column-body { display: grid; align-content: start; gap: 10px; min-height: 64px; }
.board-column-empty { margin: 0; color: var(--ink-faint); font-size: 13px; }

.board-card {
  display: grid;
  gap: 9px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: grab;
}

.board-card.is-dragging { opacity: 0.5; }
.board-card-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.board-card-head h3 { margin: 0; font-size: 15px; line-height: 1.3; letter-spacing: -0.015em; text-wrap: pretty; }
.board-card-company { margin: 0; color: var(--ink-soft); font-size: 13px; }
.board-card-report { color: var(--ink-faint); font-size: 12px; }

.board-card-notes {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.45;
  resize: vertical;
}
```

- [ ] **Step 4: Verify the page in a browser**

Back up the tracker, since dragging a card writes to it:

```bash
cp data/applications.md /private/tmp/claude-501/-Users-jakyeamos-projects-career-ops/09fc5413-c023-48b0-81f9-18e86342e1ee/scratchpad/applications.md.pre-board
```

Start the server:

```bash
node queue-ui.mjs
```

Open `http://127.0.0.1:47831/board.html` with the Playwright MCP tools (`browser_navigate`, then `browser_snapshot`). Confirm:
1. Six columns render in order: Applied, Responded, Interview, Offer, Rejected, Discarded.
2. `browser_console_messages` reports no CSP violations and no errors.
3. The `Daily queue` link returns to `/`, and `Application board` on the queue page comes back here.
4. Drag one card one column to the right, then reload — it stays in the new column.
5. Move that same card back to its original column so the tracker ends where it started.

Then confirm nothing else changed:

```bash
diff data/applications.md /private/tmp/claude-501/-Users-jakyeamos-projects-career-ops/09fc5413-c023-48b0-81f9-18e86342e1ee/scratchpad/applications.md.pre-board && echo "tracker restored"
```

Expected: `tracker restored`. Stop the server with Ctrl-C.

- [ ] **Step 5: Run the full suite and commit**

```bash
node --test tests/
```

Expected: PASS.

```bash
git add queue-ui/board.html queue-ui/board.js queue-ui/index.html queue-ui/styles.css && git commit -m "feat(queue-ui): add the application board page"
```

---

### Task 9: Update the repo truth file

**Files:**
- Modify: `.tracker/PROJECT_TRUTH.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1-8.
- Produces: nothing.

- [ ] **Step 1: Check the file is within its ceiling**

```bash
node ~/AIOS/bin/trim-state-files.mjs --check
```

If `.tracker/PROJECT_TRUTH.md` is reported over the 25 KB ceiling, trim the oldest log entries first (`Quick Tasks Completed` → last 12 rows, `Recent Progress` → last 15 entries) before adding anything.

- [ ] **Step 2: Record the change**

Add one line to `Recent Progress` (newest first) and one row to `Quick Tasks Completed`, each ≤160 characters:

```markdown
- Queue refills to 10 from the scored pool with a 4.0 floor (`selectDailyQueue`/`topUpSelection`); new six-column application board over the tracker.
```

Overwrite — do not append to — the `Current State` snapshot so it reflects the daily queue holding ten roles at or above 4.0 and the board being live at `/board.html`.

- [ ] **Step 3: Verify the ceiling still holds**

```bash
node ~/AIOS/bin/trim-state-files.mjs --check
```

Expected: no over-cap report for `.tracker/PROJECT_TRUTH.md`.

- [ ] **Step 4: Commit**

```bash
git add .tracker/PROJECT_TRUTH.md && git commit -m "docs: record queue refill and application board in project truth"
```

---

## Notes for the implementer

- `.tracker/PROJECT_TRUTH.md` and several other files are already dirty on this branch from earlier work. Stage only the files each task names; never `git add -A`.
- `parseTrackerRow` indexes cells from 1 — index 0 is the empty string before the leading pipe. `LEGACY_COLMAP` reflects this (`status: 6`, `notes: 9`). Do not "fix" it to zero-based.
- `rebuildRow` pops a trailing empty cell before joining, which is why a row written without its closing pipe round-trips correctly. That is what the last test in Task 6 pins.
- The 8am scheduled `queue.mjs refresh` goes through `buildQueue`, so it picks up the 4.0 floor from Task 2 automatically. That is intended: the scheduled refresh and the in-session refill must agree.
