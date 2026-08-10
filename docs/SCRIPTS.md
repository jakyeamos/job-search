# Scripts Reference

All scripts live in the project root as `.mjs` modules. Use `pnpm run <name>` for
package scripts and `pnpm exec node <script>.mjs` for direct commands.

## Quick Reference

| Command | Script | Purpose |
|---------|--------|---------|
| `pnpm run doctor` | `doctor.mjs` | Validate setup prerequisites |
| `pnpm run verify` | `verify-pipeline.mjs` | Check pipeline data integrity |
| `pnpm run normalize` | `normalize-statuses.mjs` | Fix non-canonical statuses |
| `pnpm run dedup` | `dedup-tracker.mjs` | Remove duplicate tracker entries |
| `pnpm run merge` | `merge-tracker.mjs` | Merge batch TSVs into applications.md |
| `pnpm run pdf` | `generate-pdf.mjs` | Convert HTML to ATS-optimized PDF |
| `pnpm cv:refresh` | `cv-refresh.mjs` | Report-only scan for new, changed, or stale project evidence |
| `pnpm run build:latex` | `build-cv-latex.mjs` | Build .tex from structured JSON payload |
| `pnpm run sync-check` | `cv-sync-check.mjs` | Validate CV/profile consistency |
| `pnpm run patterns` | `analyze-patterns.mjs` | Analyze tracker outcomes and report patterns |
| `pnpm run add` | `add-entry.mjs` | Dedup + insert a `/career-ops add` entry into cv.md / article-digest.md |
| `pnpm run update:check` | `update-system.mjs check` | Check for upstream updates |
| `pnpm run update` | `update-system.mjs apply` | Apply upstream update |
| `pnpm run rollback` | `update-system.mjs rollback` | Rollback last update |
| `pnpm run liveness` | `check-liveness.mjs` | Test if job URLs are still active |
| `pnpm run pipeline:fast:prepare` | `pipeline-fast-runner.mjs --prepare-only` | Group-fetch and deterministically route the next 30 pending roles without starting Codex |
| `pnpm run pipeline:fast` | `pipeline-fast-runner.mjs` | Process one 30-role manifest in a single lean Codex session |
| `pnpm run scan` | `scan.mjs` | Zero-token portal scanner |
| `pnpm run scan:full` | `scan-ats-full.mjs` | Reverse ATS discovery scanner |
| `pnpm civic:discovery` | `civic-discovery.mjs` | Render civic current roles, outreach targets, and stale leads without touching applications.md |
| `pnpm run validate:portals` | `validate-portals.mjs` | Validate portals.yml shape before scanning |
| `pnpm run tracker` | `tracker.mjs` | SQLite derived index over applications.md — sync/query/history/export |
| `pnpm sheets:export` | `sheets-export.mjs` | Build the Career Ops Queue and Weekly Ops packet for the configured Google Sheet |
| `pnpm run find` | `find.mjs` | Resolve a report#/tracker#/company query to its full pipeline identity |
| `node application-ingest.mjs --board-only` | `application-ingest.mjs` | Import the timestamped Jack & Jill board snapshot into the application board |
| `pnpm jackandjill:archive plan --write` | `jackandjill-archive.mjs` | Build an append-only, threshold-gated archive plan from the board snapshot and scored tracker |

### Civic discovery lane

`pnpm civic:discovery` reads `data/civic-opportunities.yml` and the separately
verified `data/civic-discoveries.yml`. It renders current roles, outreach
targets, and stale leads as distinct lanes. It never reads or writes
`data/applications.md`, contacts organizations, or submits applications.

Use `pnpm civic:discovery -- --json` for machine-readable output or
`pnpm civic:discovery -- --write` to write the separate reports under `output/`.

## Daily application queue

The queue is intentionally human-in-the-loop for applications. It discovers
and ranks roles but never submits an application. Post-application email is a
separate, opt-in workflow that only sends to verified public professional
addresses after a confirmed application signal.

```bash
node queue.mjs refresh --limit 10
node queue.mjs list
node queue.mjs clear
node queue.mjs status
node queue.mjs verify
node queue.mjs questions-doctor             # read-only ledger -> queue -> UI correlation for today
node queue.mjs questions-doctor --json      # machine-readable diagnostic
node queue.mjs questions-doctor --since 2026-08-04
node queue.mjs health --limit 100          # dry run; no queue mutation
node queue.mjs health --limit 100 --apply  # persist active/expired results
node queue.mjs health --all --apply        # sweep all eligible non-restricted URLs
node queue.mjs install-schedule --dry-run
node queue.mjs install-schedule
node queue-ui.mjs
node outreach.mjs discover-queue --limit 20 # explicit manual discovery for imported roles
node outreach.mjs process --dry-run
node outreach.mjs status
```

The local queue UI runs at `http://127.0.0.1:47831/`. It reads the existing
queue state and keeps application actions human-in-the-loop. `Applied` also
records the role in `data/applications.md`; opening a role does not change its
status. `node queue.mjs install-schedule` installs both the local UI server and
the launcher: the queue refreshes and opens at 8:00 AM Eastern, or at the
first login after 8:00 if the laptop was asleep or off.

The UI can filter by inferred company field, source-provided location, and role
lane, and sort by queue priority, company field, location, company name, or
posting date. Unknown company fields remain `Unclassified`; missing locations
and posting dates stay separate rather than being guessed.

Queue state is kept in the local ignored files `data/job-queue.json` and
`data/job-queue.md`.

`node queue.mjs questions-doctor` is separate from the structural `verify`
gate because it correlates runtime evidence: newly captured ledger questions,
their persisted `applicationResult.needsReview` projection, UI eligibility,
and the running queue UI service's start time versus relevant source files. It
reports answerable questions separately from legal/consent fields,
informational notices, and questions with a reusable confirmed answer. The
command is read-only. Exit `0` means the projection and service freshness were
verified, `1` means a missing projection or stale/stopped service was found,
and `2` means required evidence was unavailable. By default it examines the
current Eastern day; use `--since <YYYY-MM-DD|ISO timestamp>` or `--all` to
change the window.

Routine `queue.mjs refresh` does not run contact discovery. Contact research now
runs only when an application packet is explicitly prepared for a role scoring
at least 4.3/5. Packet preparation reuses a valid cached discovery snapshot and
reports found, no-verified-result, and unavailable outcomes without blocking the
packet. The queue UI and Markdown queue continue to render stored snapshots.
Discovery never sends email or marks a role applied. Outreach drafting,
scheduling, and delivery retain the existing explicit confirmation,
Gmail-account, rate-limit, and send gates.

### 8 AM source-only boundary

The installed 8 AM launchd path runs `scripts/queue-ui-launch.mjs`, which
invokes `queue.mjs refresh --scheduled`, then runs a bounded
`queue.mjs health --limit 100 --apply --browser` sweep. The refresh ingests the
cached Jack & Jill recommendation source alongside Gmail and configured public
sources, plus read-only application evidence from Gmail and the timestamped
Jack & Jill board snapshot. It applies deduplication, fit scoring, and posting
aging; the health
sweep rechecks the oldest eligible queue URLs using ATS APIs, HTTP, and browser
fallback where needed. Its `lastRun.sources.jackandjill` and
`lastHealthCheck` records make both source and liveness results visible.

The scheduled path does not traverse application forms, generate submission
packets, resumes, cover letters, or application answers, and it never submits
applications. Packet generation is an explicit selected-role action:

```bash
pnpm exec node apply/application-packets.mjs --queue-id <queue-id>
pnpm exec node apply/application-packets.mjs --queue-id <queue-id> --dry-run
pnpm exec node apply/question-ledger.mjs pending
pnpm application-ledger-dogfood --sample 12
```

Use `pnpm exec node jackandjill.mjs sync --write` for an explicit authenticated
Jack & Jill recommendation/cache refresh. The scheduled source ingest reads
that local ignored cache; it never needs coaching transcripts and never submits
applications. `node jackandjill.mjs coach ...` remains an on-demand calibration
or role-specific coaching action.

### Jack & Jill archive ledger

`pnpm jackandjill:archive plan --write` joins the read-only
`data/jackandjill-board.json` snapshot to `data/applications.md`. Only a unique,
scored tracker match below `config/profile.yml`'s 4.0 threshold, already marked
`SKIP` or `Discarded`, with bound official-posting evidence becomes an
`eligible` archive candidate. Applied, in-process, offer, above-threshold,
unscored, ambiguous, and undisposed cards are retained or blocked with a reason.

The command never changes Jack & Jill. Use Computer Use against the already
authenticated board to archive only the emitted `pendingArchive` cards, then
record each result without overwriting history:

```bash
pnpm jackandjill:archive plan --write
pnpm jackandjill:archive record --key '<source-key>' --outcome archived
```

Login, MFA, CAPTCHA, missing archive controls, or permanent-delete controls are
hard stops. The append-only ledger remains at
`data/jackandjill-archive-ledger.jsonl` and records the score, threshold,
tracker disposition, evidence source, and reasoning for every considered card.

### Question-ledger dogfood

The dogfood runner is a bounded staging harness for the current queue. With no
flags it produces a JSON plan only: no browser opens and no queue, ledger,
packet, resume, cover-letter, or answer files are written. Selection is
deterministic and round-robins Greenhouse, Ashby, and Lever candidates.

```bash
pnpm application-ledger-dogfood --sample 12
pnpm application-ledger-dogfood --shape-only --sample 12
pnpm application-ledger-dogfood --run --sample 12
pnpm application-ledger-dogfood --run --shape-only --sample 12 --headed
```

Verified runs require an active supported posting and a substantive JD. The
explicit `--shape-only` mode is useful for form-shape and question dedup
dogfooding when queue records are uncertain or missing descriptions; it is
reported as unverified and does not establish that a role is still active.
Runs copy the canonical question ledger to a temporary staging root by default,
disable artifact generation, and never promote staged answers. Pass
`--staging-root /private/tmp/...` when the staged packet and ledger should be
reviewed after the command exits. The runner remains read-only with respect to
application data: it does not fill, select, upload, or perform a final
Apply/Submit/Send action. It may click a posting-page Apply control and safe
local continuation controls to reveal the form.

### Human-controlled application packets

Packets are browser-first and use the authorized Chrome session through
the browser bridge. They record the live form shape and safely reachable local
pages, but never fill fields, select choices, upload files, solve challenges,
or click a final Apply/Submit/Send control. A posting-page Apply control may be
clicked to reach the form, and local Next/Continue controls may be clicked when
no required fields are present. A required field needed to continue, login,
CAPTCHA/MFA/identity verification, missing posting evidence, or bridge loss
produces a blocked packet. Final submission is always manual.

Each role keeps one stable current packet and artifact manifest. History is
created only for material JD/form/canonical-answer/resume-decision changes;
legacy ignored artifacts are not deleted. Narrative drafts keep raw,
humanized, audited, and approved states. Canonical reusable answers live in
`data/application-question-ledger.json` and only explicit user confirmations
or verified profile values can be reused.

Packet counts and copy/paste output cover only nontrivial answer preparation.
Standard profile fields are retained as form evidence but excluded from the
count; simple eligibility/profile fields and human-only fields remain separate
so required-field gating is still accurate.

Each retained posting also carries `firstSeenAt`, `lastSeenAt`, and freshness
metadata. A role is down-ranked after 14 days, marked `recheck_due` after 30
days, and becomes `stale` after 45 days without observation or positive
verification. At 60 days it becomes `archived`; archived records are retained
for history and question-ledger provenance, while existing packet artifacts are
left untouched; they can reactivate when a source observes the same role again.
Alert-only URLs are removed from daily selection at the stale threshold without
being treated as confirmed closures.
The age transitions run during a successful `queue.mjs refresh`; source errors
or a skipped public scan suspend them. A stale role must be refreshed and
revalidated before a new human-submission packet can be prepared.

### Packet-prep contact research and post-application outreach

For roles at or above the 4.3/5 fit floor, explicit application-packet
preparation runs a bounded public contact-discovery pass through the
authenticated Firecrawl CLI credentials when they are available. Every pass
searches three channels: exact public professional email evidence, LinkedIn,
and X/Twitter. It prefers the assigned recruiter, hiring manager, or relevant
team member, then falls back to any current employee who can route the candidate
to the right person. It scrapes only non-social public pages and stores the
source URLs and evidence locally. Current employment is the eligibility gate;
role relevance affects ranking only. An exact-name X/Twitter profile may be
bound to separate current-employment evidence and does not need to repeat the
employer in its bio. X/Twitter handles and messages remain manual-only.
Contact ranking uses a strict channel hierarchy: exact verified professional
email first, verified current-employer X/Twitter second, and verified
current-employer LinkedIn last. LinkedIn-only contacts remain available when
there is no stronger channel, but cannot displace an eligible email or X/Twitter
candidate. An opt-in unverified email hypothesis remains below verified
X/Twitter and above LinkedIn; it is never presented as verified.
It also searches Gmail headers for existing professional relationships in the
configured mailbox and searches configured warm networks such as Amazon and
Case Western Reserve University for relevant public recruiter, hiring-manager,
and team signals. For up to four named public candidates without an address, it
runs at most two exact-name Firecrawl searches (name/company/email, then
name/employer-domain/email) and promotes only an exact named employer-domain
match. Known data-broker and blocked job-board sources are never used as
evidence. The existing
`data/outreach-contacts.json` manifest remains a supported override/supplement
for contacts you have already researched.

Discovery distinguishes a completed search with no verified result from an
unavailable source. Billing, authentication, rate-limit, and temporary provider
failures open a circuit for the rest of the batch instead of repeating the same
request for every role. The queue UI reports the source outage once per role as
non-blocking, keeps technical details in a disclosure, and exposes the stored
queries as manual search links. It does not reinterpret unavailable evidence as
proof that no contact exists or relax the verified-contact requirement.

The `node application-queue.mjs run` worker performs a fill-only preparation pass
and never clicks Submit. Outreach processing runs only after a human-controlled
handoff records at least one confirmed submission. Dry runs, blocked applications,
anti-spam blocks, failed submissions, and `submission_unknown` results do not
trigger outreach. The interactive queue uses the same processor after its
`Applied` action.

The daily clear workflow is available from the existing local queue UI or the
CLI. It refreshes sources first, selects up to six eligible roles, generates
verified tailored artifacts, records question blockers for the UI, and groups
human handoffs in one dedicated Chrome window:

```bash
node application-queue.mjs clear --dry-run --limit 6
node application-queue.mjs clear --limit 6
node application-queue.mjs status
```

The installed macOS LaunchAgent invokes `scripts/queue-ui-launch.mjs` at 8:00 AM
Eastern. After the scheduled refresh and liveness sweep, it starts one bounded
six-role fill per day and leaves the dedicated Chrome handoff available for up
to eight hours of human review. It never clicks Submit; the scheduler records a
start date so a `RunAtLoad` retry cannot start a second daily batch.

It does not retry submitted, uncertain, anti-spam, CAPTCHA, MFA, or completed
human-handoff records, and it never sends outreach before confirmation.

Email outreach creates drafts directly in the verified `jakyejobs@gmail.com`
account; it never sends them. The local queue shows a routing notification and
keeps the rendered email body out of the browser. Review and send each draft
manually in Gmail. Draft IDs and the rendered-message fingerprint are retained
in the local outbox so a retry reconciles an existing Gmail draft instead of
creating a duplicate. Rate limits, daily ramp caps, submission confirmation,
recipient verification, and Gmail account verification remain in force.

Automatic email requires a named professional contact plus a verified
professional address (`emailVerified: true`). Public contacts require
a source URL and employer-domain evidence; first-party relationship contacts
require a verified Gmail relationship and source message ID. Ad-hoc guessed
addresses, private mailboxes, LinkedIn scraping, and TeamWork Online crawling
are blocked. Convention-derived contacts remain marked `guessed` and
`unverified-hypothesis`; they are never eligible for an explicit send
authorization. LinkedIn messages remain drafts for manual sending. Dry-run mode
performs no web discovery and no network send.

Discovery may infer a company email convention when it sees multiple named
employees using the same employer domain across multiple public source URLs. In
the opt-in policy, it can apply that convention to a separately discovered name
and include the resulting unverified hypothesis in `record.contacts` and the
outbox. With the default strict policy, it remains review-only. The discovery
pass still runs a bounded exact-address Firecrawl query for each hypothesis; only a result that
contains the exact address and the same named person is promoted to a verified
contact. The original hypothesis remains marked as derived evidence for audit.
The public pass also uses seven bounded queries: the exact role, company recruiting
signals, LinkedIn recruiter/talent profiles, LinkedIn engineering-manager profiles,
X profiles, legacy Twitter-profile URLs, and first-party employer-domain email
examples. It ranks observed local-part
patterns such as `first.last` and `flast`, records coverage and evidence URLs, and
rejects pseudo-identities from code/configuration pages. ATS hosts from an apply
URL are never treated as the employer's email domain. Named public candidates
without an address receive at most two exact-name email searches each for the top
four candidates, whether they came from the public pass or a warm-network pass.
Use `--force` on an explicitly requested read-only discovery retry when a prior
provider error is still inside its short cache window. Do not validate
hypotheses by sending test mail, probing SMTP, using data brokers, or scraping
blocked sites.

```bash
node outreach.mjs prepare --application <queue-id> --dry-run
node outreach.mjs discover --application <queue-id> --dry-run
node outreach.mjs discover --application <queue-id>
node outreach.mjs discover --application <queue-id> --force
node outreach.mjs discover-applied --dry-run
node outreach.mjs discover-applied
node outreach.mjs process --dry-run
node outreach.mjs enable-email
node outreach.mjs process
node outreach.mjs pause --application <queue-id>
node x-outreach-outbox.mjs mark-sent <draft-id>
```

After manually sending an X message, `mark-sent` records the human-confirmed
delivery timestamp and archives the local copy from the active review surface.
It retains the record locally and does not claim native X delivery.

`discover-applied` reconciles Gmail employer/ATS acknowledgements, LinkedIn
provider submission receipts, Jack & Jill Applied history, exact external
`Stage` values, explicit tracker dates, and persisted user confirmations. A
bare queue or tracker label is not submission evidence. The command searches
exact public professional email, LinkedIn, and X/Twitter for every confirmed
application, including records whose original posting URL is no longer
available, but it never creates Gmail drafts. Applications below the 4.0 fit
floor remain research-only and cannot be promoted into outreach. Same-company contact
collisions are rewritten into distinct messages; a second valid recipient is
not suppressed merely because the first message was similar.

The queue process creates drafts only from the verified `jakyejobs@gmail.com`
account. `authorize-send` is retired; direct outreach sending is disabled.
The first live run is capped at two initial drafts per day; use
`node outreach.mjs ramp-complete` after reviewing the initial drafts to activate
the configured ten-email daily ceiling.

---

## doctor

Validates that all prerequisites are in place: Node.js >= 18, dependencies installed, Playwright chromium, required files (`cv.md`, `config/profile.yml`, `portals.yml`), fonts directory, and auto-creates `data/`, `output/`, `reports/` if missing.

```bash
pnpm run doctor
```

**Exit codes:** `0` all checks passed, `1` one or more checks failed (fix messages printed).

---

## verify

Health check for pipeline data integrity. Validates `data/applications.md` against nine rules: canonical statuses (per `templates/states.yml`), no duplicate company+role pairs, all report links point to existing files, scores match `X.XX/5` / `N/A` / `DUP`, rows have proper pipe-delimited format, no pending TSVs in `batch/tracker-additions/`, no markdown bold in scores, no two `reports/*.md` files covering the same company+role, and no orphan reports without a tracker row (#1425). The report checks are warning-level: duplicate reports can be legitimate (re-evaluation after a JD change), so they never fail the run.

```bash
pnpm run verify
```

**Exit codes:** `0` pipeline clean (zero errors), `1` errors found. Warnings (e.g. possible duplicates) do not cause a non-zero exit.

---

## normalize

Maps non-canonical statuses to their canonical equivalents and strips markdown bold and dates from the status column. Aliases like `Enviada` become `Aplicado`, `CERRADA` becomes `Descartado`, etc. DUPLICADO info is moved to the notes column.

```bash
pnpm run normalize             # apply changes
pnpm run normalize -- --dry-run  # preview without writing
```

Creates a `.bak` backup of `applications.md` before writing.

**Exit codes:** `0` always (changes or no changes).

---

## dedup

Removes duplicate entries from `applications.md` by grouping on normalized company name + fuzzy role match. Keeps the entry with the highest score. If a removed entry had a more advanced pipeline status, that status is promoted to the keeper.

```bash
pnpm run dedup             # apply changes
pnpm run dedup -- --dry-run  # preview without writing
```

Creates a `.bak` backup before writing.

**Exit codes:** `0` always.

---

## merge

Merges batch tracker additions (`batch/tracker-additions/*.tsv`) into `applications.md`. Handles 9-column TSV, 8-column TSV, and pipe-delimited markdown formats. Detects duplicates by report number, entry number, and company+role fuzzy match. Higher-scored re-evaluations update existing entries in place.

```bash
pnpm run merge                 # apply merge
pnpm run merge -- --dry-run    # preview without writing
pnpm run merge -- --verify     # merge then run verify-pipeline
```

Processed TSVs are moved to `batch/tracker-additions/merged/`.

**Exit codes:** `0` success, `1` verification errors (with `--verify`).

---

## validate:portals

Validates `portals.yml` before running the scanner. The validator is offline: it reads YAML, loads local provider IDs from `providers/*.mjs`, and checks common configuration mistakes without fetching any job boards.

It reports errors for invalid YAML shape, unknown explicit providers, malformed URLs, empty filter keywords, and invalid local parser blocks. Duplicate enabled company names are warnings because they may be intentional during migrations, but they are worth reviewing.

```bash
pnpm run validate:portals
pnpm run validate:portals -- --file templates/portals.example.yml
node validate-portals.mjs --self-test
```

**Exit codes:** `0` no errors (warnings allowed), `1` one or more errors found.

---

## pdf

Renders an HTML file to a print-quality, ATS-parseable PDF via headless Chromium. Resolves font paths from `fonts/`, normalizes Unicode for ATS compatibility (em-dashes, smart quotes, zero-width characters), and reports page count and file size.

```bash
pnpm run pdf -- input.html output.pdf
pnpm run pdf -- input.html output.pdf --format=letter   # US letter
pnpm run pdf -- input.html output.pdf --format=a4        # A4 (default)
```

**Exit codes:** `0` PDF generated, `1` missing arguments or generation failure.

---

## build:latex

Builds a `.tex` file from a structured JSON payload, handling template merge and LaTeX escaping automatically. The JSON is produced by the agent during evaluation — this script replaces the manual LaTeX generation step in `modes/latex.md`.

```bash
node build-cv-latex.mjs input.json output.tex
node build-cv-latex.mjs --test
```

**Exit codes:** `0` file generated, `1` missing inputs, invalid JSON, unresolved placeholders, or template not found.

---

## sync-check

Validates that the career-ops setup is internally consistent: `cv.md` exists and is not too short, `config/profile.yml` exists with required fields, no hardcoded metrics in `modes/_shared.md` or `batch/batch-prompt.md`, and `article-digest.md` freshness (warns if older than 30 days).

```bash
pnpm run sync-check
```

**Exit codes:** `0` no errors (warnings allowed), `1` errors found.

---

## patterns

Analyzes application outcomes, scores, archetypes, blockers, remote policy, and company size from `data/applications.md` and linked reports. New reports should include `## Machine Summary` YAML; `analyze-patterns.mjs` uses it first and falls back to legacy markdown parsing for older reports.

```bash
pnpm run patterns
pnpm run patterns -- --summary
pnpm run patterns -- --min-threshold 3
node analyze-patterns.mjs --self-test
```

**Exit codes:** `0` analysis succeeded, `1` insufficient data or parser self-test failure.

---

## update:check

Checks whether a newer version of career-ops is available upstream. Outputs JSON to stdout:

```bash
pnpm run update:check
```

Possible JSON responses:

| `status` | Meaning |
|----------|---------|
| `up-to-date` | Local version matches remote |
| `update-available` | Newer version exists (includes `local`, `remote`, `changelog`) |
| `dismissed` | User dismissed the update prompt |
| `offline` | Could not reach GitHub |

**Exit codes:** `0` always.

---

## update

Applies the upstream update. Creates a timestamped backup branch (`backup-pre-update-<version>-<YYYYMMDDTHHMMSSZ>`), fetches from the canonical repo, checks out only system-layer files, runs `pnpm install`, and commits. The timestamp is derived from UTC ISO time with separators and milliseconds removed (for example, `backup-pre-update-1.8.1-20260608T071302Z`). User-layer files (`cv.md`, `config/profile.yml`, `data/`, etc.) are never touched.

```bash
pnpm run update
```

**Exit codes:** `0` success, `1` lock conflict or safety violation.

---

## rollback

Restores system-layer files from the most recent backup branch created during an update. Rollback prefers the newest timestamped branch matching `backup-pre-update-<version>-<YYYYMMDDTHHMMSSZ>` and still accepts legacy `backup-pre-update-<version>` branches for older installs.

```bash
pnpm run rollback
```

**Exit codes:** `0` success, `1` no backup branch found or git error.

---

## health

Runs a bounded liveness sweep over existing `ready`, `in_review`, and `snoozed`
queue roles. It checks ATS APIs first, then a lightweight HTTP request;
Playwright is opt-in with `--browser`. LinkedIn alert URLs use the public guest
posting endpoint: HTTP 404/410 and explicit closure banners such as “No longer
accepting applications” are definitive stale signals, while throttling,
malformed responses, and access failures remain uncertain. When a supposedly
active LinkedIn URL resolves to a different employer than the queue row, the
row is removed from selection as stale identity data without claiming the URL
itself is closed; a later enriched refresh can reintroduce and rescore the real
job. TeamWork Online alert URLs remain restricted. With `--browser`, an inconclusive guest response
falls back to the canonical public posting in Playwright, where the same closure
banner outranks retained description or Apply text. Without browser fallback, a
LinkedIn 429 opens a circuit breaker for that run; repeated malformed/network
responses do the same. Three consecutive inconclusive browser results also stop
the run, leaving all unattempted roles untouched for the next sweep. The command
is a dry run unless `--apply` is present. Definitive expired results mark a
mutable role `stale`; time-based aging is applied by the daily `refresh`
lifecycle. Applied, skipped, excluded, archived, historical, and uncertain
records are preserved.

```bash
node queue.mjs health --limit 100 --json
node queue.mjs health --limit 100 --apply
node queue.mjs health --linkedin --all --apply
node queue.mjs health --all --apply --browser
```

`--all` means all eligible unique URLs rather than the default bounded batch.
`--linkedin` limits the sweep to LinkedIn posting URLs.
Use it deliberately because non-ATS URLs may require browser fallback and
network checks remain sequential.

## liveness

Tests whether job posting URLs are still live using headless Chromium. Detects expired patterns (e.g. "job no longer available"), HTTP 404/410, ATS redirect patterns, and apply-button presence. Supports multi-language expired patterns (English, German, French).

```bash
pnpm run liveness -- https://example.com/job/123
pnpm run liveness -- https://a.com/job/1 https://b.com/job/2
pnpm run liveness -- --file urls.txt
```

Each URL gets a verdict: `active`, `expired`, or `uncertain` with a reason.

**Exit codes:** `0` all URLs active, `1` any expired or uncertain.

---

## scan

Zero-token portal scanner. Runs configured local parsers for SSR/static career pages and hits ATS APIs (Greenhouse, Ashby, Lever) directly — no LLM tokens consumed. Reads `portals.yml` for target companies, outputs matching listings to stdout, and optionally appends to `data/pipeline.md`.

`scan_history.recheck_after_days` in `portals.yml` lets old `added` URLs become eligible for recheck after the configured number of days. If absent, scan-history dedup keeps the historical behavior and dedups forever. Permanent invalid statuses such as blocked host and malformed URL remain permanent.

For custom SSR pages, configure a tracked company with `scan_method: local_parser` and a `parser` block. The parser can be written in JavaScript, Python, or any language available as a local executable. Company-specific parsers usually already know their source URL and only need to print JSON jobs to stdout:

```yaml
parser:
  command: node
  script: scripts/parsers/example-company-jobs.js
  format: jobs-json-v1
```

Use `args` only for reusable parsers that intentionally accept runtime parameters such as `{careers_url}` or `{company}`.

If a parser writes full extraction artifacts for debugging or audit, store them under `data/parser-output/{company}/`. `scan.mjs` reads stdout and does not require those JSON files after parsing. Keep generated JSON artifacts out of git; `.gitkeep` placeholders are the only exception for preserving directory structure.

```bash
pnpm run scan
```

**Exit codes:** `0` scan completed, `1` configuration error or no portals.yml found.

---

## scan:full

Reverse ATS discovery scanner. Where `scan.mjs` scans the companies you track in `portals.yml`, this inverts the direction: it walks public directories of companies per ATS (Greenhouse, Lever, Ashby, Workday) and surfaces fresh postings matching your `portals.yml` `title_filter` / `location_filter` — no manual company curation. Company directories come from the public [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) dataset, cached in `data/cache/` for 24 hours.

Postings without a usable publish date are skipped — a reverse scan is only useful for fresh postings. New matches are appended to `data/pipeline.md` and `data/scan-history.tsv` in the same format as `scan.mjs`.

```bash
pnpm run scan:full                              # all ATS directories, last 3 days
node scan-ats-full.mjs --since 7               # postings from the last 7 days
node scan-ats-full.mjs --ats greenhouse,workday # subset of sources
node scan-ats-full.mjs --limit 200             # max companies per ATS
node scan-ats-full.mjs --dry-run               # preview without writing
node scan-ats-full.mjs --liveness              # Playwright-verify matches first
node scan-ats-full.mjs --md-out notes/scans    # also write a dated markdown digest
```

**Exit codes:** `0` scan completed, `1` configuration error (no portals.yml, unknown `--ats` source) or fatal scan error.

---

## tracker

SQLite **derived index** for the applications tracker (RFC #918, phase 1). `data/applications.md` stays the source of truth; `data/applications.db` is built from it by `sync` and is safe to delete at any time — it regenerates on the next sync. All writes keep going to the markdown exactly as today (`merge-tracker.mjs`, hand edits); the index is read-only infrastructure.

Why: at hundreds of rows a markdown table degrades structurally (encoding corruption, column drift, `|` inside cells shifting columns), and agents grepping it get model-dependent results. The index normalizes on sync, so a query returns the same rows for every model on every CLI — and corruption is detected at sync time instead of propagating silently.

Zero new dependencies — uses `node:sqlite`, built into Node ≥ 22.5.

```bash
node tracker.mjs sync                     # (re)build applications.db from applications.md
node tracker.mjs sync --check             # diagnose corruption only, no write (exit 1 if issues found)
node tracker.mjs query --status Applied --since 2026-05-01
node tracker.mjs query --company acme --json
node tracker.mjs history --id 42          # status transitions observed across syncs (Applied → Interview → ...)
node tracker.mjs export                   # inverse: index → canonical markdown table on stdout
node tracker.mjs export --out repaired.md # write to a file (existing file backed up to .bak first)
```

`query` and `history` auto-resync when the markdown changed since the last sync, so the index can never serve stale reads.

`sync` detects and reports the corruption classes markdown accumulates — mojibake placeholder cells, scores stranded in the status column, non-canonical statuses (resolved via `templates/states.yml` aliases), missing/duplicate ids, stray pipes — and normalizes them **in the index only**; the markdown is never modified. Fix at the source with `normalize-statuses.mjs` / `dedup-tracker.mjs`, then re-sync. Status changes between syncs accumulate in a `status_events` table, which gives `analyze-patterns.mjs` a real funnel instead of only the current snapshot.

`export` is the inverse of `sync` (round-trip `md → db → md` is lossless for clean input — enforced by `test-all.mjs`). It writes to stdout by default and never touches `applications.md` unless you explicitly pass it as `--out`. Phase 2 of #918 (DB becomes source of truth, markdown becomes a rendered view) is a separate, explicit per-user opt-in — not part of this script yet.

**Exit codes:** `0` success, `1` validation error, missing prerequisites (Node < 22.5, no `applications.md` to index), or corruption found by `sync --check`.

---

## find

Resolves a report number, tracker number, or company/role fragment to its full pipeline identity: company, role, tracker#, report#, canonical status, PDF path (from `data/pdf-index.tsv`), and report path. "Apply to #13" is ambiguous — report numbers and tracker row numbers diverge — and answering it used to require opening three files; this does it in one read-only lookup.

Zero dependencies, strictly read-only. Numeric queries match **both** the tracker # column and the report number from the Report link (`012` and `12` are the same number), so collisions between the two numbering schemes surface as multiple rows instead of a silent wrong pick. Text queries match company/role by case-insensitive substring, with the shared fuzzy matcher (`role-matcher.mjs`) as fallback for multi-word phrases.

```bash
node find.mjs 13                # report# OR tracker# 13 — shows both if they differ
node find.mjs acme              # company fragment
node find.mjs "data engineer"   # role phrase (fuzzy via role-matcher)
node find.mjs acme --json       # machine-readable output
```

Multiple matches print as a table; zero matches print a clean message.

**Exit codes:** `0` at least one match, `1` no match, missing query, or no `applications.md`.
