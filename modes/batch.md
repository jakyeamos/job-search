# Mode: batch — Mass Processing of Jobs

Three usage modes: **conductor --chrome** (navigates portals in real time),
**standalone Claude worker**, or the **persistent Codex fast queue** for a large
`data/pipeline.md` backlog.

## Architecture

```text
Conductor (headed browser mode)
  │
  │  Chrome: navigates portals (logged-in sessions)
  │  Reads DOM directly — the user sees everything in real time
  │
  ├─ Job 1: reads JD from DOM + URL
  │    └─► headless worker → report .md + tracker-line
  │
  ├─ Job 2: click next, read JD + URL
  │    └─► headless worker → report .md + tracker-line
  │
  └─ End: merge tracker-additions → applications.md + summary
```

Each worker is a headless child process with a clean 200K token context. The conductor only orchestrates. See the **Headless / Batch Mode** table in `AGENTS.md` for the correct command per CLI.

## Files

```text
batch/
  batch-input.tsv               # URLs (from conductor or manual)
  batch-state.tsv               # Progress (auto-generated, gitignored)
  batch-runner.sh               # Standalone orchestrator script (PDF-free discovery default)
  batch-prompt.md               # Prompt template for workers
  logs/                         # One log per job (gitignored)
  tracker-additions/            # Tracker lines (gitignored)
```

## Mode A: Conductor --chrome

1. **Read state**: `batch/batch-state.tsv` → identify what has already been processed
2. **Navigate portal**: Chrome → search URL
3. **Extract URLs**: Read results DOM → extract URL list → append to `batch-input.tsv`
4. **For each pending URL**:
   a. Chrome: click on the job → read JD text from the DOM
   b. Save JD to `/tmp/batch-jd-{id}.txt`
   c. Reserve the next REPORT_NUM atomically: `node reserve-report-num.mjs` (release with `--release {num}` after the worker writes the report; stale sentinels are GC'd automatically)
   d. Execute via Bash:

      ```bash
      # Use your CLI's headless command (see AGENTS.md — Headless / Batch Mode)
      <headless-cmd> "Process this job. URL: {url}. JD: /tmp/batch-jd-{id}.txt. Report: {num}. ID: {id}"
      ```

   e. Update `batch-state.tsv` (completed/failed + score + report_num)
   f. Log to `logs/{report_num}-{id}.log`
   g. Chrome: go back → next job
5. **Pagination**: If no more jobs → click "Next" → repeat
6. **End**: Merge `tracker-additions/` → `applications.md` + summary

### What to watch during a run

During a conductor run, the operator has two primary live interfaces to monitor:
1. **The headed Chrome window:** Watch the browser navigate the portals, login to sessions, and interact with the job description pages in real time.
2. **The agent CLI conversation:** Follow the agent's turn-by-turn narration in the shell.

The individual worker tasks spawn headlessly in the background and write their stdout/stderr logs to `batch/logs/{report_num}-{id}.log`, which can be inspected on demand.

### Manual multi-agent fan-out

Orchestrating N parallel evaluators by hand (multiple agent windows / subagents, outside `batch-runner.sh`)? Reserve the whole range FIRST, then hand each worker its own number — never let workers compute `max+1` themselves:

```bash
node reserve-report-num.mjs --count 8
# stdout: 042-049  → worker 1 gets 042, worker 2 gets 043, ...
```

Each number is backed by a sentinel file in `reports/`, so concurrent reservations from other windows cannot collide. After all reports are written, release leftovers in one call:

```bash
node reserve-report-num.mjs --release 042-049
```

**Two things to know:**

- **4-hour protection window.** Sentinels older than 4h are garbage-collected (`verify-pipeline.mjs` triggers this). Reserve the range immediately before spawning workers, not at the start of a long session. Once a worker writes its real report, that slot is permanently safe — only slow or unstarted slots are at risk after 4h.
- **Gaps are normal.** If a reservation collides and restarts, skipped numbers (e.g. `006`) are never reused. Report numbers are opaque IDs; a gap is not corruption.

## Mode B: Standalone script

```bash
batch/batch-runner.sh [OPTIONS]
```

Options:
- `--dry-run` — list pending jobs without executing
- `--retry-failed` — retry only failed jobs
- `--resume-paused` — resume jobs paused after a Claude session/rate limit
- `--start-from N` — start from ID N
- `--limit N` — max number of jobs to process in this run
- `--parallel N` — N workers in parallel
- Resume artifact generation is disabled for discovery by default; generate tailored HTML/PDF on demand for shortlisted roles.
- `--max-retries N` — attempts per job (default: 2)
- `--rate-limit-sleep N` — seconds to wait before retrying a transient rate-limited worker (default: 300; use 0 to pause the batch immediately)

## batch-state.tsv Format

```text
id	url	status	started_at	completed_at	report_num	score	error	retries
1	https://...	completed	2026-...	2026-...	002	4.2	-	0
2	https://...	failed	2026-...	2026-...	-	-	Error msg	1
3	https://...	pending	-	-	-	-	-	0
4	https://...	rate_limited	2026-...	2026-...	004	-	rate-limit; retrying after 300s	1
5	https://...	paused_rate_limit	2026-...	2026-...	005	-	session limit; paused	1
```

Valid statuses include `pending`, `processing`, `completed`, `failed`, `skipped`, `rate_limited`, and `paused_rate_limit`. `rate_limited` is an intermediate non-completed state emitted while the runner waits before retrying; if the run is interrupted there, a later non-`--retry-failed` run treats it as pending work.

`paused_rate_limit` means a worker hit a Claude session/usage limit. The runner stops scheduling new offers, preserves the retry count, and resumes only when explicitly called with `--resume-paused`.

## Mode C: Persistent Codex fast queue

```bash
node pipeline-fast-runner.mjs --prepare-only
node pipeline-fast-runner.mjs
```

The preprocessor groups Greenhouse, Lever, and Ashby URLs by organization,
fetches each public board once, and applies high-confidence deterministic
blockers before Codex starts. The default run sends one 30-role manifest to one
lean `codex exec` session. PASS/MARGINAL roles receive compact discovery cards;
full A-G reports and resume artifacts remain on-demand.

The lean worker uses `--ignore-user-config`, which preserves Codex
authentication and repository rules while avoiding unrelated desktop plugins
and MCP startup. Pass `--normal-config` only when a batch needs those tools.

## Resumability

- If it crashes → re-run → reads `batch-state.tsv` → skip completed jobs
- Lock file (`batch-runner.pid`) prevents double execution
- Each worker is independent: failure in job #47 does not affect the others

## Workers (headless mode)

Each worker receives `batch-prompt.md` as a system prompt. It is self-contained. Use your CLI's headless command — see the **Headless / Batch Mode** table in `AGENTS.md`.

The worker produces by default:
1. `.md` report in `reports/` (PASS roles only)
2. Tracker line in `batch/tracker-additions/{id}.tsv`
3. Result JSON via stdout

With an explicit PDF opt-in for a selected role, the worker may additionally create
the tailored HTML source and PDF required by the PDF workflow.

## Error handling

| Error | Recovery |
|-------|----------|
| URL inaccessible | Worker fails → conductor marks `failed`, continues |
| JD behind login | Conductor attempts to read DOM. If it fails → `failed` |
| Portal changes layout | Conductor reasons about HTML, adapts |
| Worker crashes | Conductor marks `failed`, continues. Retry with `--retry-failed` |
| Claude session/usage limit | Runner marks the current offer `paused_rate_limit`, stops scheduling new offers, preserves retries. Resume with `--resume-paused` after reset. |
| Conductor crashes | Re-run → reads state → skip completed jobs |
| PDF fails | The `.md` report is saved. Resume artifacts remain pending and can be generated on demand |
