# ATS Auto-Fill Adapters

Deterministic, per-ATS application auto-fill. Each adapter is plain Playwright code that
already knows one applicant-tracking system's DOM and fills an application to
**submit-ready** in seconds — no LLM in the per-field loop. Think "sneaker bot" for job
apps: one small reusable script per platform, driven by a single canonical profile.

Adapters: **Greenhouse**, **Ashby**, **Lever**.

## Hard rules (non-negotiable, enforced in code)

1. **Never clicks Submit/Apply.** Adapters fill to submit-ready and stop. You submit.
2. **Never auto-fills EEO / voluntary self-identification** (gender, race, veteran,
   disability, LGBTQIA+, CC-305). The section is detected and flagged — it's your call,
   same tier as CAPTCHA and the Submit button.
3. **Leaves marketing-consent checkboxes unchecked** (privacy-preserving default).
4. **Never invents facts.** Every value comes from the profile. A required field with no
   backing value is flagged for you, never guessed.

## Canonical profile

All values come from **`config/application-profile.json`** (gitignored — it holds PII +
demographic data). Fill in the placeholder (`""`) fields before first use. The `eeo`
block is stored but never auto-filled. See the schema in that file.

Résumé / cover-letter paths can be set once in `defaults.resume_path` /
`defaults.cover_letter_path`, or passed per-run with `--resume` / `--cover`.

## Usage

```bash
# Greenhouse (job-boards.greenhouse.io)
node apply/fill-greenhouse.mjs <application-url> --resume path/to/resume.pdf

# Ashby (jobs.ashbyhq.com) — URL is auto-normalized to /application
node apply/fill-ashby.mjs <job-url> --resume path/to/resume.pdf

# Lever (jobs.lever.co) — no cover-letter upload; long text goes to "Additional info"
node apply/fill-lever.mjs <application-url> --resume path/to/resume.pdf --cover-text "..."
```

The browser launches **headed** and stays open after filling so you can review the
⚠ flagged items and submit. Press Ctrl+C when done.

### Flags

| Flag | Meaning |
|------|---------|
| `<url>` (positional) | The application URL |
| `--resume <path>` | Résumé file (overrides `defaults.resume_path`) |
| `--cover <path>` | Cover-letter file (Greenhouse/Ashby, when the form has the field) |
| `--cover-text "..."` | Long-form text for Lever's "Additional information" textarea |
| `--answers <file.json>` | Per-posting custom answers (see below) |
| `--profile <path>` | Alternate profile file (default `config/application-profile.json`) |
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
