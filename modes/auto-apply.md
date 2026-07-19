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
- EEO, demographic, marketing-consent, CAPTCHA, MFA, legal-attestation, and
  ambiguous controls stop the run.
- A successful confirmation is recorded as `submitted`. A click without a
  confirmation is `submission_unknown` and is never retried automatically.
- The worker caps submissions per day and per company and deduplicates by
  normalized company, role, and location.
- Unsupported forms remain in the queue with a precise blocker. The worker does
  not bypass sign-in, CAPTCHA, rate limits, or a site's application controls.
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

For a manual or external renderer, register an approved artifact against the
queue role:

```bash
node resume.mjs register \
  --item-id <queue-id> \
  --artifact output/applications/<role>/resume.pdf \
  --html output/applications/<role>/resume.html \
  --source-mode tailored \
  --audit-status passed
```

The queue accepts legacy existing artifacts during migration, but records them
as `legacy-existing` rather than pretending they are tailored. A changed or
missing artifact fails closed.

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
`submitted` or `submission_unknown` entry is terminal for automatic retry. Fix
the blocker, answer the ledger question, or manually confirm the external state
before re-queuing a role.
