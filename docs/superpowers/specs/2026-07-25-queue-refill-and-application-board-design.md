# Queue Auto-Refill + Application Board — Design

**Date:** 2026-07-25
**Status:** Approved

## Goal

Three changes to the local queue UI (`queue-ui.mjs` + `queue-ui/`):

1. **Auto-refill.** When today's selection drops below 10 roles, top it back up to 10
   from the already-scored pool in `data/job-queue.json`. No network calls, no waiting.
2. **Application board.** A second screen — a six-column kanban over
   `data/applications.md` — so an application stays visible after it leaves the daily
   queue. Today, marking a job applied makes it disappear from the UI entirely.
3. **Archive tier.** Move terminally-filtered rows out of the hot queue file into a
   sidecar, keeping a compact stub index behind for dedup. Half the working file is rows
   that can never be selected again.

## Deliverables

- `queue-lib.mjs` — new exports `selectDailyQueue`, `topUpSelection`, `evictToArchive`,
  `archiveStub`; `buildQueue` consults the stub index
- `apply/application-recommendations.mjs` — new `pinned` option
- `tracker-board.mjs` — read/write board state over `data/applications.md`
- `queue-archive.mjs` — read/write `data/job-queue-archive.json`, rehydrate pass
- `queue.mjs` — `saveQueue` evicts before write; new `rehydrate` subcommand; integrity
  check covers the index
- `queue-ui.mjs` — refill wire-in; `GET /api/board`, `POST /api/board/status`,
  `POST /api/board/notes`; totals read the index
- `queue-ui/board.html`, `queue-ui/board.js`, additions to `queue-ui/styles.css`
- `tests/queue-topup.test.mjs`, `tests/tracker-board.test.mjs`,
  `tests/queue-archive.test.mjs`

## Feature 1 — Auto-refill to 10

### Extract the selection step

`buildQueue` currently inlines selection at `queue-lib.mjs:548-562`. Extract it:

```
selectDailyQueue(items, {
  limit = DEFAULT_QUEUE_LIMIT,     // 10
  minFitScore = APPLY_THRESHOLD,   // 4.0
  maxPerCompany, maxPerJobFamily,
  pinned = [],
}) -> Array<item>
```

It filters by `eligibleForSelection`, drops anything below `minFitScore`, sorts by
`sortScore` descending, and delegates to `selectApplicationRecommendations`.
`buildQueue` calls it; nothing else about `buildQueue` changes.

`APPLY_THRESHOLD` already exists (`queue-lib.mjs:20`) and is already the ready /
in_review boundary in `scoreCandidate`. The floor reuses it rather than adding a
constant.

### Pinned selections

`selectApplicationRecommendations` (`apply/application-recommendations.mjs:66`) gains an
optional `pinned` array. Pinned items are emitted first, in the order given, and seed
`companyCounts` and `familyCounts` before the greedy loop runs. Without this, a top-up
could hand back a second role at a company already sitting in today's list, because the
diversity caps would have no memory of the incumbents.

`pinned` defaults to `[]`, so every existing caller is unaffected.

Pinned items bypass `minFitScore` — they are incumbents, already shown to the user, and
silently dropping one mid-session because a floor was introduced would be worse than
letting it finish its day. The floor governs what the top-up *adds*.

### The top-up

```
topUpSelection(state, options) -> { state, added, shortBy }
```

1. Collect `selectedForToday` items, ordered by `queueRank`.
2. If the count is already at `limit`, return unchanged with `added: 0`.
3. Otherwise pass them as `pinned` to `selectDailyQueue` over the full item list.
4. Rewrite `selectedForToday` and reassign `queueRank` as `1..n`, contiguous.

Step 4 also repairs ranks left non-contiguous by out-of-band edits.

`shortBy` is non-zero when the eligible pool cannot fill 10 — either it is exhausted or
the per-company / per-job-family caps block the remainder. This is reported, never
padded around.

### Where it fires

Server-side, in `queue-ui.mjs`:

- In `applyQueueAction` (`queue-ui.mjs:263`), after any action that clears
  `selectedForToday` — `applied`, `confirmed-submitted`, `skipped`, `snoozed` — and
  before `saveQueue`.
- In the `GET /api/queue` handler, as a safety net for selections drained by other
  paths.

No client change is needed. `/api/action` already returns the full state and `app.js`
re-renders from it.

### Refresh limit correction

`refreshQueue()` (`queue-ui.mjs:310`) shells out to `queue.mjs refresh --limit 6`. A
refresh that selects 6 while the refill targets 10 is incoherent, so the flag moves to
10. The "Prepare the best six" heading in `queue-ui/index.html:51` and its subheading
change to match.

### The fit-score floor

`eligibleForSelection` has no score floor. The queue holds 468 ready/in_review items, of
which 263 score ≥ 4.0 and 205 fall below — clustered at 3.9 (83) and 3.7 (53), largely
LinkedIn alert rows scored from job titles alone, with no description ever fetched.

Without a floor the refill starts serving those once the strong pool drains, which
contradicts the standing rule in `CLAUDE.md` to recommend against applying below 4.0.
So `minFitScore` defaults to `APPLY_THRESHOLD` and applies to **both** paths —
`buildQueue`'s initial selection and the top-up — because a floor on one and not the
other would make the 8am refresh and the in-session refill disagree.

Consequence, accepted deliberately: a daily queue may come up short of 10 rather than
fill with title-only matches. At 263 qualifying items that is ~26 days away.

## Feature 2 — Application board

### Surface

A second page, `queue-ui/board.html` + `queue-ui/board.js`, sharing `styles.css` and
served by the existing static handler (`queue-ui.mjs:611`). Navigation is a link in the
topbar next to the wordmark, both directions. No router and no framework — this matches
the existing UI, which is one vanilla ES module and no dependencies.

### Columns

Six, mirroring `templates/states.yml` with no translation layer:

`Applied` · `Responded` · `Interview` · `Offer` · `Rejected` · `Discarded`

`Evaluated` and `SKIP` are deliberately absent. Those are pre-application states already
covered by the daily queue, and putting them on the board would duplicate it.

The board is horizontally scrollable; six columns do not fit a laptop viewport
comfortably at readable card width.

### Data

`data/applications.md` is the board — there is no second store and no schema change, so
the Go dashboard in `dashboard/` and every existing tracker script keep working
untouched.

New module `tracker-board.mjs`:

- `readBoard(root)` — resolve columns with `tracker-parse.mjs` `resolveColumns`, parse
  rows with `parseTrackerRow`, keep rows whose status is one of the six, return
  `{ num, date, company, role, score, status, report, notes }`.
- `setRowStatus(root, num, status)` — validate `status` against the canonical list,
  rewrite that row's Status cell, write the file.
- `setRowNotes(root, num, notes)` — same, for the Notes cell.

Both writers re-read `applications.md` immediately before rewriting. Several scripts
mutate that table, so nothing is cached across requests. Row rewrites go through
`rebuildRow` (`tracker-utils.mjs:24`), which already handles the trailing-pipe edge case
that a naive `slice(1, -1)` gets wrong.

Notes text is sanitized on write the way `escapeTable` (`queue.mjs:250`) does it —
`|`, `\r`, and `\n` become spaces — or a pipe typed into a note silently splits the row
into new columns.

Editing status and notes on existing rows is explicitly permitted by `CLAUDE.md`; the
board never adds rows, so the "new entries go through `batch/tracker-additions/` and
`merge-tracker.mjs`" rule is not in play.

### Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/api/board` | — | `{ columns, cards }` |
| POST | `/api/board/status` | `{ num, status }` | updated `{ columns, cards }` |
| POST | `/api/board/notes` | `{ num, notes }` | updated `{ columns, cards }` |

Each mutation returns the whole board so the client re-renders from server truth rather
than trusting its optimistic state.

### Card and interaction

Each card shows role, company, fit score, application date, a link to the report, and an
editable notes field (textarea, saved on blur). Movement is HTML5 drag-and-drop:
`dragstart` carries the row number, `drop` on a column posts the new status. A failed
write re-renders from the server response, so a rejected drag visibly snaps back.

### How cards arrive

No change to the queue card at all. `Confirm submitted` keeps its exact current behavior
— `recordApplication` (`queue.mjs:253`) appends a tracker row with status `Applied`, and
`recordSubmissionSignal` arms outreach follow-up. Because the new row is already
`Applied`, it appears in the board's first column on the next board load. No new button,
no rename, and the outreach guardrail is untouched.

## Feature 3 — Archive tier

### The cost

Measured on `data/job-queue.json`, 2026-07-25 after the description backfill (these
counts supersede the pre-backfill figures quoted in Feature 1):

| Status | Items | JSON bytes |
|--------|------:|-----------:|
| `excluded` | 648 | 2.06 MB |
| `in_review` | 321 | 0.99 MB |
| `skipped` | 156 | 0.41 MB |
| `ready` | 133 | 0.83 MB |
| `stale` | 23 | 0.05 MB |
| `applied` | 1 | — |
| **total** | **1282** | **4.34 MB** (5.4 MB on disk) |

Every `queue.mjs` run, every `/api/queue` request, and every `saveQueue` parses and
rewrites all 1282 items in order to choose 10. The 648 `excluded` rows are 47% of that
and can never be selected — `eligibleForSelection` (`queue-lib.mjs:465`) rejects them
outright.

### What must never be evicted

`skipped` and `applied`. `buildQueue` preserves those two statuses across rebuilds
(`queue-lib.mjs:503`) and that record is the only thing standing between the user and a
job they already rejected walking back into the daily selection — the queue is rebuilt
from Gmail alerts and portal scans, which keep re-surfacing the same postings. They are
also cheap: 157 rows, 0.41 MB. They stay live forever, with no age rule.

### Eviction triggers on status, not age

An age threshold was the first instinct and it does not survive contact with the data.
Queue history spans 22 days (earliest `firstSeenAt` 2026-07-04); dead-row age is median
9 days, max 21:

```
>60d: 0    >45d: 0    >30d: 0    >21d: 0    >14d: 4    >7d: 545
```

A 60-day rule matching `POSTING_AGE_POLICY.archiveAfterDays` (`queue-aging.mjs:14`)
evicts nothing today and nothing for another 40 days. A 7-day rule evicts 545 rows
including all 147 `excluded` rows whose descriptions the backfill just fetched. Age is
either inert or indiscriminate here, because `lastSeenAt` on an `excluded` row records
when its alert email arrived, not how long it has been waiting for anything.

So:

| Status | Rule | Why |
|--------|------|-----|
| `excluded` | evict on the next `saveQueue` | Exclusion is deterministic. Nothing but a blocker-rule change makes one selectable again, and that change triggers an explicit rehydrate. |
| `archived` | evict on the next `saveQueue` | Already the terminal state `applyPostingAging` assigns at 60 days (`queue-aging.mjs:116-122`). The age wait has happened. |
| `stale` | stays live | The 45-to-60-day waiting room, and it reactivates on re-observation (`queue-lib.mjs:529`). 23 rows, 0.05 MB — not worth the round trip. |
| `skipped`, `applied` | never | See above. |
| `ready`, `in_review`, `snoozed` | never | Selectable. |

### Two files, one stub index

`data/job-queue-archive.json` holds the full evicted records, descriptions included.
**Nothing is deleted** — the 147 backfilled descriptions move to another file on the same
disk, they do not disappear.

The live file gains a top-level `archivedIndex`: one stub per evicted row.

```
{ id, company, title, url, status, fitScore, blockers, lane,
  firstSeenAt, lastSeenAt, archivedAt }
```

Measured at 0.19 MB for all 671 currently-dead rows. Live file drops to ~3.4 MB on disk
and items parsed per run from 1282 to 634.

The index lives in the live file rather than being derived by reading the archive each
run, because dedup and suppression need only ids and dates — reading a 2 MB sidecar in
order to select 10 roles is the exact cost this feature removes. The archive is opened
only on rehydrate.

```
evictToArchive(state, archive, { now }) -> { state, archive, evicted, index }
archiveStub(item) -> stub
```

`saveQueue` (`queue.mjs:275`) calls `evictToArchive` before writing, then writes both
files. Archive write is read-modify-write on the sidecar, appending by id, so a record
evicted twice does not duplicate.

### Suppression and reactivation

`buildQueue` loads `archivedIndex` alongside `previous.items`. For a candidate whose id
hits the index:

- **Not observed now** — dropped from the merge. It stays archived; the stub is enough to
  keep it from re-entering as a new row. `stableQueueId` (`queue-lib.mjs:173`) hashes
  company plus title, so a re-sent alert for the same posting collides with the stub as
  intended.
- **Observed now** — re-enters live `items` with `firstSeenAt` carried from the stub and
  `reactivatedAt` stamped, and the stub is removed from the index. No archive read: an
  observed candidate arrives with fresh data, and the stub carries the one field
  (`firstSeenAt`) that the candidate cannot supply. This preserves the reactivation
  semantics already at `queue-lib.mjs:529`.

An `excluded` row re-observed this way gets rescored by `scoreCandidate` like any other
candidate. If the blockers still apply it is excluded again and evicted again on the same
write. That churn is bounded by how often an alert repeats a posting.

### Rehydrate

```
node queue.mjs rehydrate [--blocker <name>] [--dry-run]
```

Pulls matching records out of the archive back into live `items`, rescores each with
`scoreCandidate`, and lets the next `saveQueue` re-evict whatever is still excluded. This
is the answer to a loosened blocker rule: `--blocker experience-floor` brings back 131
rows with their descriptions intact and no network calls. Without it, relaxing a rule
would mean another backfill pass.

`--dry-run` reports what would return and how each row rescores, changing nothing.

### Counts must not lie

`buildSnapshot` (`queue-ui.mjs:241-253`) computes `totals` by scanning `items`, so
`excluded` and `archived` would both read 0 once eviction lands. Those two counts come
from `archivedIndex` instead; `retained` becomes live items plus index length so the
headline number keeps meaning "everything the system remembers".

The UI then collapses `excluded` / `skipped` / `stale` / `archived` into a single
`Filtered (N)` disclosure line in the topbar, expandable to the per-status breakdown.
Four dead-end counts on screen daily is what prompted this feature; the fix is one line,
not four deletions.

### Integrity

`queue.mjs`'s status validation (`queue.mjs:482`) extends to the archive: every stub id
must be absent from live `items`, every stub must resolve to a record in the sidecar, and
`archived` / `excluded` must not appear as a live item status. A stub without a record,
or an id in both places, is an error rather than a silent repair — the two files drifting
apart is the failure mode worth catching loudly.

### Consequences accepted

- The archive grows without bound. At current ingest that is roughly 2 MB/month of
  records nothing reads unless a rule changes. Trimming it is a later problem and needs
  its own retention decision.
- Two files to keep in sync, where there was one.
- Hand-editing `data/job-queue.json` to resurrect a specific job stops working for
  evicted rows; `rehydrate` is the supported path.

## Error handling

- Unknown status value → `400`, listing the six accepted values.
- Row number not present in the tracker → `404`.
- `data/applications.md` missing → `500` naming the file (matches `recordApplication`'s
  existing behavior).
- Board fetch failure in the client → the existing `setConnection(false)` /
  `showToast(..., true)` pattern from `app.js`.
- `topUpSelection` never throws on an empty pool; it returns `shortBy > 0` and the queue
  renders short.
- `data/job-queue-archive.json` missing → treated as empty, created on first eviction. A
  fresh clone has no archive and must not fail.
- Archive file present but unparseable → `saveQueue` aborts before writing either file
  rather than evicting into a void.
- `rehydrate --blocker` matching nothing → exits 0 reporting zero matches.

## Testing

`tests/queue-topup.test.mjs`

- no-op when 10 are already selected (`added === 0`, ranks untouched)
- tops up 5 → 10 from the eligible pool
- incumbents keep their slots and their relative order
- per-company cap holds across the pin boundary — a company already selected gets no
  second slot
- items below 4.0 are never selected
- resulting `queueRank` values are `1..n` with no gaps
- exhausted pool returns `shortBy > 0` instead of throwing

`tests/tracker-board.test.mjs`, against a temp-file fixture

- parses only the six board states; `Evaluated` / `SKIP` rows are excluded
- status write round-trips and leaves every other cell byte-identical
- invalid status is rejected without touching the file
- notes containing `|` and newlines are sanitized, and the row still parses afterward
- unknown row number is reported, file unmodified
- rows written without a trailing pipe survive a rewrite (the `rebuildRow` edge case)

`tests/application-recommendations.test.mjs` gains coverage for `pinned`: seeding the
counts, preserving order, and defaulting to `[]` for existing callers.

`tests/queue-archive.test.mjs`, against temp-file fixtures

- `excluded` and `archived` are evicted; `ready`, `in_review`, `snoozed`, `stale` are not
- `skipped` and `applied` are never evicted, at any age
- an evicted record is byte-identical in the sidecar, description included
- the stub carries every documented field and no others
- a re-ingested candidate matching a stub and not observed now is dropped from the merge
- a re-ingested candidate matching a stub and observed now returns to live `items` with
  `firstSeenAt` from the stub, `reactivatedAt` set, and the stub gone from the index
- evicting the same id twice leaves one archive record
- no id appears in both live `items` and `archivedIndex` after a full build-then-save cycle
- `rehydrate --blocker` returns only rows carrying that blocker, and rescores them
- `rehydrate --dry-run` leaves both files unmodified
- missing archive file behaves as empty; unparseable archive aborts the write with both
  files unchanged
- `totals.excluded` and `totals.archived` read from the index, and `retained` counts live
  items plus stubs

## Out of scope

- Structured per-stage fields (interview dates, recruiter contact, next action). Status
  and free-text notes only; a sidecar store was considered and rejected.
- A `Saved` column. The daily queue already fills that role.
- Fetching descriptions for the 307-item 3.7-score cluster. Worth doing, but it is a
  scoring-pipeline problem, not a queue-UI one.
- Any change to outreach triggering.
- Retention or compaction of `data/job-queue-archive.json`. It grows unbounded by design
  here; deciding when a record is truly dead is a separate call.
- Deleting anything. The archive tier moves records between files and never removes them.
- Migrating the existing 671 dead rows in a dedicated pass. The first `saveQueue` after
  this ships evicts them, and `queue.mjs verify` confirms the split.
