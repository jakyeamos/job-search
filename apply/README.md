# ATS Auto-Fill Adapters

Resume selection is lane-only when `cv.resume_strategy` is `lane_only`. The
application workflow references the configured PDF under `output/lanes/` and
does not generate or register per-job resumes. Per-application cover letters
and evidence manifests remain supported.

Deterministic, per-ATS application auto-fill. Each adapter is plain Playwright code that
already knows one applicant-tracking system's DOM and fills an application to
**submit-ready** in seconds — no LLM in the per-field loop. Think "sneaker bot" for job
apps: one small reusable script per platform, driven by a single canonical profile.

Adapters: **Greenhouse**, **Ashby**, **Lever**.

## Hard rules (non-negotiable, enforced in code)

1. **Fill-only by default.** Adapters click Submit/Apply only when invoked with `--submit` and the local application policy is enabled and authorized. The queue worker adds active-posting, fit-score, required-answer, anti-bot, and idempotency gates.
2. **Never auto-fills EEO / voluntary self-identification** (gender, race, veteran,
   disability, LGBTQIA+, CC-305). The section is detected and flagged — it's your call,
   same tier as CAPTCHA and the Submit button.
3. **Leaves marketing-consent checkboxes unchecked** (privacy-preserving default).
4. **Never invents facts.** Every value comes from the profile or an explicit answer in the question ledger. A required field with no
   backing value is flagged for you, never guessed.

## Canonical profile

All values come from **`config/application-profile.json`** (gitignored — it holds PII +
demographic data). Fill in the placeholder (`""`) fields before first use. The `eeo`
block is stored but never auto-filled. See the schema in that file.

Résumé / cover-letter paths can be set once in `defaults.resume_path` /
`defaults.cover_letter_path`, or passed per-run with `--resume` / `--cover`.

## Queue-facing resume and cover-letter artifacts

The queue selects a canonical lane resume and generates a job-specific,
evidence-bound cover letter before a supported ATS run. The generator reads only the canonical Career Ops
sources (`cv.md`, `article-digest.md`, `config/profile.yml`, and
`modes/_profile.md`) plus the queue posting, then caches artifacts by the
posting and evidence hashes. It refuses to generate when the job description
is missing/too short or fewer than two verified lane projects are available.
When the queued description is short, supported Greenhouse, Lever, and Ashby
URLs may be enriched through a bounded ATS JSON fallback before the existing
posting-page fallback. The artifact manifest records whether the description
came from the queue, `ats-api`, or the live posting page. This optional queue
enrichment does not replace browser-first inspection of the authenticated
application form.

```bash
node resume.mjs plan --limit 6
node apply/application-artifacts.mjs build --queue-id <queue-id>
```

The generated directory contains `cover-letter.txt`, `cover-letter.html`, a
one-page `cover-letter.pdf`, and an evidence manifest that references the
canonical lane resume. Greenhouse and Ashby receive the
cover-letter PDF when the form exposes a cover-letter field; Lever receives the
approved cover-letter text in its Additional Information field.

`resume.mjs register` accepts only the already-configured lane artifact;
per-job or externally tailored resume artifacts are blocked.

### Ashby field-shape notes

Ashby custom fields are addressed by their enclosing `data-field-path` (or a
temporary field-container marker when the tenant uses a `fieldset`), not by
assuming that generated input names are stable. Required Yes/No questions may
render visible buttons over hidden checkboxes, and sponsorship may render as a
fieldset whose option names are `Yes` and `No`. The adapter groups by the field
container, scopes option matching to that container, and treats a required
container as required even when its hidden input has no `required` attribute.
Some Ashby Yes/No controls mark the selected button with an active CSS class
while leaving the backing checkbox unchecked; required reconciliation checks
that active-button state as well as native checkbox state.

Some tenants nest required text-message consent radios inside the phone field
container. The adapter groups those radios by their own name, labels them as
Text message consent, and never infers the candidate's consent choice.

Ashby location is a role=`combobox`; text is only considered committed after a
matching suggestion is selected. If the suggestion cannot be matched safely,
the run records Location for manual review. EEO and voluntary self-
identification fields remain human-only.

For a new tenant or unfamiliar form, inspect its shape without filling it:

```bash
node apply/inspect-form-shape.mjs <application-url>
```

The report is JSON and intentionally excludes current field values. It is a
read-only diagnostic; it does not log in, upload files, click options, or
submit an application.

### Human-controlled submission packets

The packet path is browser-first and read-only. It is the supported workflow
for preparing a selected application for manual copy/paste; it does not invoke
the legacy adapter's fill or submit commands. It performs this bounded sequence:

1. Revalidate posting freshness and require a visible title, a substantive
   description, and a detected application path.
2. Inspect every safely reachable form page, recording labels, required state,
   field kind, choices, uploads, page order, and human-only signals.
3. Click a posting-page `Apply` control when no form controls are present, then
   click only local `Next`/`Continue` controls on pages with no required fields.
   It never fills, selects, uploads, follows unrelated external controls, or
   clicks a final Apply/Submit/Send control.
4. Resolve only confirmed ledger answers, verified profile values, and
   evidence-bound project selections. Narrative drafts remain packet-local
   until humanizer review and approval.
5. Select the configured canonical lane resume. Per-job resume generation is
   retired; cover letters remain independent application artifacts.
6. Render a packet with a final manual checklist. Submission stays outside
   Career Ops.

Every generated candidate-facing narrative answer and cover letter also carries
a `candidate-copy-quality-receipt/v1`. The receipt binds the exact
evidence-bound input, Humanizer revision, and output hashes and records the
protected-claim audit. A missing or stale receipt leaves the item as a draft;
the packet keeps it out of the copy/paste and attachment-ready sections until
Humanizer passes. Confirmed ledger/profile answers remain source-verified
inputs and are not rewritten unless new wording is generated from them.
The direct application queue applies the same boundary: it withholds generated
cover-letter files from ATS adapters unless the manifest receipt passes and the
exact text-file hash still matches. The current executable style check also
rejects em and en dashes, which must be rewritten before copy is final.

The packet's preparation count is intentionally narrow: `questions` and the
Markdown copy/paste section contain only nontrivial answer work, such as
evidence-backed narrative responses. Standard profile fields (name, email,
phone, links, and country) are retained in the inspected form evidence but do
not count or produce copy/paste entries. Simple eligibility/profile fields and
human-only EEO, legal, consent, CAPTCHA, and MFA fields are tracked in their
own sections so required-field gating still works without inflating the
preparation count.

```bash
# Selected queue role; this is the normal explicit invocation.
pnpm exec node apply/application-packets.mjs --queue-id <queue-id>

# Inspect without ledger, packet, artifact, resume, or draft writes.
pnpm exec node apply/application-packets.mjs --queue-id <queue-id> --dry-run

# Direct application URL; Chrome is the default browser channel.
pnpm exec node apply/application-packets.mjs <application-url> \
  --company "Example" --title "Backend Engineer" \
  --job-description "..." --headed --max-pages 8 --answers path/to/answers.json

# Reuse an already authenticated Chrome/OpenCLI-compatible CDP session.
pnpm exec node apply/application-packets.mjs --queue-id <queue-id> \
  --cdp-endpoint http://127.0.0.1:9222

# Force independent cover-letter preparation or omit artifact generation.
pnpm exec node apply/application-packets.mjs --queue-id <queue-id> --cover
pnpm exec node apply/application-packets.mjs --queue-id <queue-id> --no-artifacts
```

Statuses are `ready-for-human-review`, `needs-user-input`, `blocked`, and
`stale`. Login redirects, CAPTCHA/MFA/identity checks, required fields needed
to continue, missing form evidence, bridge loss, and unsupported flows are
blocked rather than worked around. Optional unanswered questions are listed in
the packet but do not hide the distinction between a ready packet and a packet
missing a required answer.

Each role has one stable current packet under
`output/application-packets/{company-role}-{url-hash}/` and one stable artifact
directory under `output/application-artifacts/`. A history snapshot is created
only when the JD hash, form shape, canonical answer references, or resume
decision changes. Existing legacy hash directories are left untouched.

When a resume PDF is rendered, Career Ops keeps the audited canonical artifact
in the role directory and also delivers a normalized copy to the configured
candidate CV folder (currently `~/Desktop/CVs`) as
`Jakye-Amos-CV-{Company}.pdf`. Cover letters remain in the role artifact
directory.

#### Question ledger and answer drafts

Observed questions are grouped in the ignored canonical ledger. Existing
adapter-observed answers are unconfirmed until the user explicitly promotes
them; confirmed answers carry stable references such as
`question-ledger:q_abc123@v2`.

```bash
pnpm exec node apply/question-ledger.mjs pending
pnpm exec node apply/question-ledger.mjs answer <question-id-or-text> "answer" --scope global
pnpm exec node apply/question-ledger.mjs answer <question-id-or-text> "No" \
  --scope global --confirm-sensitive
```

`--answers` accepts a local ignored JSON file. Its question entries may contain
`questionId`, `question`, `draft`, `humanized`, `approved`, and `evidenceRefs`;
an optional `coverLetter` object uses the same raw/humanized/approved shape.
The packet preserves the evidence-bound raw text, the humanized revision, the
claim-preservation audit, and the approval state. It never humanizes yes/no,
select, compensation, authorization, legal, EEO, consent, or identity fields.
Jack & Jill coaching can supply drafts on demand, but it does not promote
answers into the reusable ledger automatically.

#### Question-ledger dogfood

Use the bounded dogfood runner to exercise ledger matching and answer reuse
against a queue sample without mutating the canonical queue or ledger. Plan mode
is the default and opens no browser:

```bash
pnpm application-ledger-dogfood --sample 12
pnpm application-ledger-dogfood --shape-only --sample 12
```

The default sample remains capped at 40. Use `--all` explicitly to inspect
every queue item that passes the selected adapter, status, liveness, and posting
evidence preflight:

```bash
pnpm application-ledger-dogfood --all
```

`--all` is ledger coverage, not an instruction to apply to every posting. The
report separately lists `applicationRecommendations`, capped by default to the
strongest role per company; role-family de-duplication also applies if that
company cap is raised. Country-specific duplicates and nearby variants can
therefore contribute questions to the ledger without being presented as
separate application recommendations.

Normal runs require an active supported posting. If the queue description is
missing or short, the runner hydrates it from the rendered application page
during the read-only inspection; the packet remains blocked if that page does
not expose a substantive description. They copy the canonical ledger into a
temporary staging root, inspect at most the selected sample, and disable
resume/cover-letter artifact generation:

```bash
pnpm application-ledger-dogfood --run --sample 12
pnpm application-ledger-dogfood --run --shape-only --sample 12 --headed
pnpm application-ledger-dogfood --run --sample 12 --staging-root /private/tmp/career-ops-ledger-review
```

For a queue-wide pass, keep the packet run staged and explicitly opt into
merging observed questions plus evidence-backed normal answers into the
canonical ledger. User-confirmed answers are preserved; sensitive/legal/EEO/
consent/identity fields remain human-only:

```bash
pnpm application-ledger-dogfood --run --all \
  --promote-evidence \
  --staging-root /private/tmp/career-ops-ledger-full \
  --report /private/tmp/career-ops-ledger-full-report.json
```

Evidence-backed narrative answers are still reviewable drafts where wording
needs humanizer approval. Promotion never fills a control, uploads an
artifact, clicks a final Apply/Submit/Send control, or sends outreach.

`--shape-only` is an explicit diagnostic exception for sampling supported ATS
form shapes when queue liveness or JD evidence is incomplete. Its output is
marked `shape-only-unverified` and must not be treated as active application
evidence. The runner never promotes staged answers, fills controls, uploads, or
clicks a final Apply/Submit/Send control. It may click a posting-page Apply
control and safe local continuation controls to reveal the form. Review the
emitted JSON report and staged ledger before any manual answer promotion.

The `application-queue.mjs clear` command is the bounded bulk-fill surface:
it selects supported high-fit roles, fills them in one visible Chrome handoff,
and waits for human review and submission. The `run` command is fill-only when
used directly. Neither path clicks the final Apply/Submit/Send control or
bypasses the manual submission boundary.

## Usage

```bash
# Greenhouse (job-boards.greenhouse.io)
node apply/fill-greenhouse.mjs <application-url> --resume path/to/resume.pdf

# Ashby (jobs.ashbyhq.com) — URL is auto-normalized to /application
node apply/fill-ashby.mjs <job-url> --resume path/to/resume.pdf

# Lever (jobs.lever.co) — no cover-letter upload; long text goes to "Additional info"
node apply/fill-lever.mjs <application-url> --resume path/to/resume.pdf --cover-text "..."

# Authorized submission is opt-in and policy-gated.
node apply/application-policy.mjs authorize
node application-queue.mjs dry-run --limit 6
node application-queue.mjs run --limit 6
node application-queue.mjs clear --dry-run --limit 6
node application-queue.mjs clear --limit 6
node application-queue.mjs status
node application-queue.mjs resume --queue-id <id>
node application-queue.mjs handoff --queue-id <id> --timeout 600
```

`clear` refreshes the queue, selects at most six active high-fit supported-ATS
recommendations with one role per company by default and role-family
de-duplication, then fills the supported forms in one visible Chrome handoff.
Required questions appear in the daily queue UI as `blocked_by_question`;
CAPTCHA, MFA, anti-spam, uncertain-submit, and ambiguous-control states remain
human-controlled. No outreach is sent unless confirmation evidence records a
successful submission.

The installed 8:00 AM Eastern scheduler starts this same bounded `clear` flow
once per day with an eight-hour human review window. Prepared tabs remain in the
dedicated Chrome handoff until you review them or the window expires.

Fill-only runs launch **headed** and stay open after filling so you can review the
⚠ flagged items and submit. The daily `clear` flow uses the visible handoff path;
the direct `run` worker uses headless fill-only execution by default, never clicks
Submit, and records `prepared_for_review`. After a human click, the adapter records bounded,
sanitized post-submit evidence: confirmation markers, URL/title, accessible
dialogs and live regions, frame summaries, form state, a redacted text preview,
and document/fetch/XHR response status. It never stores response bodies or URL
query strings. A confirmation is still required before the result becomes
`submitted`; otherwise the result remains terminal `submission_unknown`. Explicit
possible-spam or suspicious-activity responses become terminal
`blocked_by_antispam` results and are never retried automatically.

For a compliant last-mile handoff, use `--human-handoff` without `--submit`. The
adapter opens a visible browser, fills the form, never clicks Submit, and watches
for a human to complete CAPTCHA and submit. It records a confirmation when one is
observed, or records a terminal anti-spam, timeout, or closed-browser result
without retrying. The default observation window is ten minutes; override it with
`--human-timeout <seconds>`.

### Flags

| Flag | Meaning |
|------|---------|
| `<url>` (positional) | The application URL |
| `--resume <path>` | Résumé file (overrides `defaults.resume_path`) |
| `--cover <path>` | Cover-letter file (Greenhouse/Ashby, when the form has the field) |
| `--cover-text "..."` | Long-form text for Lever's "Additional information" textarea |
| `--answers <file.json>` | Per-posting custom answers (see below) |
| `--profile <path>` | Alternate profile file (default `config/application-profile.json`) |
| `--browser <channel>` | System browser channel, default `chrome`, with fallback to bundled Chromium |
| `--submit` | Request the final submit click; still requires the local policy and all safety gates |
| `--ledger <path>` | Question-ledger file used for explicit recurring answers |
| `--human-handoff` | Fill in a visible browser and watch for a human CAPTCHA/Submit action; never clicks Submit |
| `--human-timeout <seconds>` | Maximum time to watch a human handoff; defaults to 600 seconds |
| `--headless` | Close the browser after filling — **for automated testing only** |

### Per-posting answers file

A JSON map of `{ "question label regex or exact text": "value" }`, merged **over** the
built-in common-questions table so you can answer posting-specific questions without
editing the profile:

```json
{
  "years of experience with React": "3",
  "expected salary": "150000",
  "when can you start": "Two weeks notice"
}
```

## The report

After filling, each adapter prints:

- **✅ Filled** — fields that were set (and verified to persist).
- **⏭ Skipped** — fields not present on this posting, or intentionally left alone
  (marketing consent, absent cover-letter field).
- **⚠ Needs review** — fields you must handle: EEO, CAPTCHA, an autocomplete that needs
  confirmation, or a required field with no backing profile value.

A "submit-ready" fill means the only ⚠ items are genuinely human ones.

## Common questions handled automatically

Matched by regex against the question text, answered **only** from the profile's
`work_authorization`:

- Work authorization ("legally authorized to work…") → from `authorized_us`
- Sponsorship ("require sponsorship / a petition / immigration status…") → from
  `requires_sponsorship`
- Prior/current employment at this company → `No`
- Are you 18+ → `Yes`

Add posting-specific ones via `--answers`.

## Per-ATS quirks (the hard-won DOM facts)

### Greenhouse (`job-boards.greenhouse.io`)
- Stable ids: `#first_name #last_name #email #phone #preferred_name`.
- Hidden file inputs `#resume` / `#cover_letter` — filled with `setInputFiles`. The
  adapter never clicks the "Attach" button (filechooser race) and never uses index-based
  `.nth()` (breaks when the form re-renders after the first upload).
- EEO and many custom questions are **react-select** comboboxes. When picking an option
  the search is **scoped to the combobox's `aria-controls` listbox** — otherwise the
  international phone-country picker (`#iti-0__country-listbox`) pollutes the global
  `[role=option]` set and "No" fuzzy-matches "Norway".
- Custom questions are `#question_{id}` with real labels — matched by label text.

### Ashby (`jobs.ashbyhq.com`)
- ONE combined **"Full/Legal Name"** field `#_systemfield_name` (not First/Last), plus
  `#_systemfield_email` and the résumé input `#_systemfield_resume`.
- **Phone and every custom question use generated UUID ids/names** — *not* `#phone` or
  `#question_{id}`. They are matched by their `<label>` text.
- The URL is auto-normalized to `/application`.
- reCAPTCHA appears only at submit — excluded from required-field detection; it's yours.
- "How did you hear about us?" options each carry their own name; they are left untouched.

### Lever (`jobs.lever.co`)
- Fields addressed by `name` (no stable ids): `name` (Full name), `email`, `phone`,
  `location`, `org` (current company), `urls[LinkedIn]` / `urls[GitHub]` /
  `urls[Portfolio]`.
- Résumé is a hidden `input[name="resume"]` — `setInputFiles` directly.
- **No cover-letter upload.** Long-form text goes to `textarea[name="comments"]`
  ("Additional information") when present, via `--cover-text`.
- Custom questions are `.application-question` cards (`cards[{id}][field{n}]`) and can be
  radio, native `<select>`, or text. Radio toggling uses a fallback chain — click the
  `<label>` → force-check → native in-page `element.click()` — and verifies `isChecked()`
  before claiming success (Lever's click point often gets intercepted).
- `location` is a Google-places autocomplete — the adapter types the text but **flags it**
  for you to pick the dropdown suggestion (Lever rejects bare free text).
- EEO lives in `surveysResponses[...]` (and native `<select name="eeo[...]">` on some
  tenants) — detected, never filled.
- The captcha is **hCaptcha** (`h-captcha-response`) — yours to solve.

## Architecture

- `config/application-profile.json` — single source of truth (gitignored).
- `apply/lib/adapter-core.mjs` — shared skeleton: CLI parsing, profile/answers loading,
  fill/attach/select helpers, the common-questions table, the group-aware required-field
  detector (skips reCAPTCHA, treats a radio/checkbox group as filled when any member is
  checked), the reconciliation pass (drops "filled" claims a re-render silently reset),
  and the report + browser hold-open.
- `apply/fill-{greenhouse,ashby,lever}.mjs` — thin per-ATS adapters.

## Validation

Each adapter was validated against a live posting: Greenhouse (PlanetScale), Ashby
(Notion), Lever (Match Group). Standard fields and common custom questions fill; the only
remaining ⚠ items are the genuinely-human ones (EEO, autocomplete confirmation, or a
required free-text answer with no profile value).
