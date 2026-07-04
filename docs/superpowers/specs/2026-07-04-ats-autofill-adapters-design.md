# ATS Auto-Fill Adapters — Design

**Date:** 2026-07-04
**Status:** Approved

## Goal

Take the LLM out of the per-field loop. Each adapter is plain Playwright code that
already knows ONE applicant-tracking system's DOM and fills an application to
"submit-ready" in seconds — no model round-trips per field. One small reusable script
per platform, driven by a single canonical profile file. Adapters: Greenhouse, Ashby,
Lever.

## Deliverables

- `config/application-profile.json` — canonical PII/profile source of truth (gitignored)
- `apply/lib/adapter-core.mjs` — shared skeleton (flags, helpers, detector, report)
- `apply/fill-greenhouse.mjs`
- `apply/fill-ashby.mjs`
- `apply/fill-lever.mjs`
- `apply/README.md`

## Canonical profile (`config/application-profile.json`)

Single source of truth for the STANDARD fields every ATS asks. Pre-filled from `cv.md`
and `config/profile.yml`; placeholders for data not present in those files. Holds PII +
demographic data — added to `.gitignore`.

Schema:
- `identity`: first_name, middle_name, last_name, full_name, preferred_name, pronouns,
  email, phone, phone_country_code
- `address`: line1, city, state, zip, county, country
- `links`: linkedin, github, website
- `work_authorization`: authorized_us (bool), requires_sponsorship (bool)
- `eeo`: gender, hispanic, race[], veteran, disability — canonical enum **placeholders**
  (stored, never auto-filled by adapters)
- `work_experience[]`: employer, title, city, state, country, start_month/year,
  end_month/year, current (bool), description — most-recent first
- `education[]`, `certifications[]`
- `defaults`: resume_path (""), cover_letter_path ("")

Pre-filled values (from user files):
- identity: Jakye Amos / jakyejobs@gmail.com / +1-716-578-8221 (code `+1`)
- address: Buffalo, NY, USA (line1/zip/county placeholders)
- links: linkedin.com/in/jakyeamos, github.com/jakyeamos, jakye.netlify.app
- work_authorization: authorized_us true, requires_sponsorship false (US citizen)
- work_experience: Forward Automations, Deepr, Amazon, SIR, Elevated Aperture
- education: Case Western Reserve University, B.A. Computer Science, exp. May 2026

## Shared core (`apply/lib/adapter-core.mjs`)

Factored out of the three adapters so they stay thin and the required-detector lives in
one place. Exports:

- `parseCliArgs()` — positional URL, `--resume`, `--cover`/`--cover-text`,
  `--answers file.json`, `--profile`, `--headless`
- `loadProfile(path)` / `loadAnswers(path)`
- `createSummary()` → `{ summary, ok, skip, review }` — `summary = { filled, skipped, needsReview }`
- `fillBySelector(page, selector, value)`
- `attachFile(page, selector, absPath)` — hidden-input `setInputFiles`, no clicks, no `.nth()`
- `selectDropdown(...)` — native `<select>` helper
- `answerByLabel(page, labelRegex, value)` — match custom questions by label text
- `commonQuestions(profile)` — regex table of recurring custom questions (sponsorship,
  work authorization, prior-employment-here), matched against question text
- `detectRequired(page)` — `page.evaluate` finds every `[required]`/`[aria-required]`
  still empty. Radio/checkbox GROUPS: "filled" = ANY input in the name-group checked.
  Skips `g-recaptcha-response` and reCAPTCHA.
- `reconcile(summary, stillEmpty)` — drop optimistic "filled" claims the detector still
  reports empty (react-select silent resets)
- `finish(summary, { headless })` — print ✅/⏭/⚠ report; if not headless,
  `await new Promise(()=>{})` to leave browser open for human review + submit

## Adapters — encoded DOM facts

### Greenhouse (`job-boards.greenhouse.io`)
- Stable ids `#first_name #last_name #email #phone`; hidden file inputs `#resume` /
  `#cover_letter` via `locator('#resume').setInputFiles(abs)`. Never click "Attach";
  never use index-based `.nth()`.
- EEO + custom questions are react-select comboboxes. When picking an option, SCOPE the
  option search to the combobox's `aria-controls` listbox (avoids the intl phone-country
  picker polluting global `[role=option]` — "No" fuzzy-matching "Norway").
- Custom questions `question_{id}` — match by label text.

### Ashby (`jobs.ashbyhq.com`)
- ONE combined "Legal Name" `#_systemfield_name`; also `#_systemfield_email`, `#phone`,
  `#_systemfield_resume`, `#cover_letter`. Custom `#question_{id}`.
- Normalize URL to `/application` if not already.
- reCAPTCHA appears only at submit — excluded from required detection.

### Lever (`jobs.lever.co`)
- Fields by `name` (no stable ids): `name` (Full name), `email`, `phone`, `location`,
  `org` (current company), `urls[LinkedIn]`.
- Résumé hidden `input[name="resume"]` — setInputFiles directly.
- NO cover-letter upload. Long-form text → `textarea[name="comments"]` when present
  (`--cover-text`).
- Custom questions `.application-question` cards; fields `cards[{id}][{field}]`. Radio:
  `<label><input type=radio value="X"><span>X</span></label>`. Fallback chain:
  click `<label>` → force-check input → LAST RESORT `input.evaluate(el => el.click())`.
  Verify `isChecked()`; only claim success if it took.
- `location` is Google-places autocomplete — fill text, FLAG for human to confirm the
  suggestion committed.
- EEO native `<select name="eeo[...]">` — detect, DO NOT fill.

## Hard rules (non-negotiable)

1. NEVER click Submit/Apply. Fill to submit-ready and stop.
2. NEVER auto-fill EEO / voluntary self-identification. Detect + flag only.
3. Leave marketing-consent checkboxes UNCHECKED.
4. Never invent facts. Missing required value → flag for human, don't guess.

## `--answers file.json`

Map of `{ "label regex or exact text": "value" }`, merged over `commonQuestions` so
per-posting custom answers can be supplied without editing the profile.

## Validation

Live DOM-inspect via Playwright MCP: open one live Greenhouse/Ashby/Lever posting each,
dump the real form DOM (`page.evaluate` inventory of inputs/selects/textareas + file
inputs + submit button), confirm the encoded selectors, adjust. No full headless
fill-run against live PII forms.
