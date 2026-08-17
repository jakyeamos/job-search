# Mode: auto-apply — Authorized Queue Application Worker

Use this mode when the candidate has explicitly authorized Career Ops to submit
applications from the selected queue. It runs the deterministic ATS adapters,
uses the verified profile plus the question ledger, and records every outcome.

## Commands

```bash
node apply/application-policy.mjs status
node resume.mjs plan --limit 6
node application-queue.mjs dry-run --limit 6
node application-queue.mjs run --limit 6
node application-queue.mjs clear --dry-run --limit 6
node application-queue.mjs clear --limit 6
node application-queue.mjs status
node application-queue.mjs resume --queue-id <id>
node application-queue.mjs handoff --queue-id <id> --timeout 600
node apply/question-ledger.mjs list
```

The policy must be enabled before `run` can submit:

```bash
node apply/application-policy.mjs authorize
```

Disable it immediately with:

```bash
node apply/application-policy.mjs disable
```

## Submission contract

- Only active, selected roles at or above the configured fit threshold are eligible.
- The supported automatic adapters are Greenhouse, Ashby, and Lever.
- Required fields must be resolved from the verified application profile or an
  explicit question-ledger answer.
- Accomplishment prompts can be answered from the verified project ledger at
  `config/project-accomplishment-ledger.json`. The worker selects the strongest
  approved project for the job's lane and description; an explicit scoped answer
  in `data/application-question-ledger.json` takes precedence.
- EEO, demographic, marketing-consent, CAPTCHA, MFA, legal-attestation, and
  ambiguous controls stop the run.
- A successful confirmation is recorded as `submitted`. After the click, the
  adapter inspects the URL, title, accessible dialogs/live regions, same-page
  frames, form state, and bounded document/fetch/XHR response metadata. A
  sanitized evidence summary is stored with the run. A click without a
  confirmation is `submission_unknown` and is never retried automatically.
  Explicit possible-spam or suspicious-activity responses are classified as
  `blocked_by_antispam` and are also terminal.
- The worker caps submissions per day and per company and deduplicates by
  normalized company, role, and location.
- Unsupported forms remain in the queue with a precise blocker. The worker does
  not bypass sign-in, CAPTCHA, rate limits, or a site's application controls.
- `clear` refreshes sources first, selects up to six active supported-ATS roles
  with one role per company, and records progress in the daily queue UI. It
  never reselects submitted, uncertain, anti-spam, CAPTCHA/MFA, or completed
  human-handoff states.
- A question blocker appears in the queue UI with the exact field, exposed
  choices, source context, and any evidence-bound project suggestion. Saving a
  role- or company-scoped answer resumes only that application.
- CAPTCHA, anti-spam, MFA, ambiguous-submit, and other human-only blockers open
  in one dedicated visible Chrome window as separate tabs. The handoff adapter
  fills known fields but never clicks Submit or bypasses a challenge.
- For an explicit recovery handoff, run the matching adapter with
  `--human-handoff` and no `--submit`. It fills a visible browser, leaves CAPTCHA
  and Submit to the user, watches for confirmation, and records the result
  without retrying or spoofing browser/network identity.
- Before an adapter run, the worker generates a job-specific one-page resume
  and one-page cover letter from the canonical evidence sources and the queue's
  posting description. It caches by job/evidence hash, fails closed on missing
  job descriptions or thin evidence, registers the resume manifest, and verifies
  the artifact hash, lane, selected projects, evidence sources, paper format,
  and audit status before upload.
- After a batch has at least one confirmed `submitted` result, the worker runs
  one bounded post-application outreach pass. Dry runs, blocked applications,
  failed submissions, and `submission_unknown` results never trigger it.

## Resume contract

Plan selected queue roles without changing state:

```bash
node resume.mjs plan --limit 6
```

Resume selection is lane-only. Each queue role resolves to the canonical PDF
configured under `cv.lane_artifacts` in `config/profile.yml`:

```bash
node resume.mjs register \
  --item-id <queue-id> \
  --artifact output/lanes/<configured-lane-resume>.pdf
```

Per-job artifacts and manifests are not accepted. A missing configured lane
artifact fails closed.

## Question ledger

When a required answer is missing, the adapter records the field in
`data/application-question-ledger.json`. Answer it only after reviewing the
exact wording:

```bash
node apply/question-ledger.mjs answer <question-id> "your answer" --scope global
```

Sensitive answers require `--confirm-sensitive` before they can be global. Use
`--scope company` or `--scope role` for answers that should not be reused across
every application.

## Recovery

Inspect `data/application-runs.json` before retrying an interrupted run. A
`submitted`, `submission_unknown`, `blocked_by_antispam`, CAPTCHA/MFA blocks, and
human-handoff timeouts are terminal for automatic retry. Fix the blocker or use
an explicit visible human handoff; never rotate identities or attempt to bypass
the site's anti-abuse controls.
