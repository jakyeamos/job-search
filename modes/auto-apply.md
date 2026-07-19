# Mode: auto-apply — Authorized Queue Application Worker

Use this mode when the candidate has explicitly authorized Career Ops to submit
applications from the selected queue. It runs the deterministic ATS adapters,
uses the verified profile plus the question ledger, and records every outcome.

## Commands

```bash
node apply/application-policy.mjs status
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
- The worker consumes the queue item's `resumeArtifact`; use the existing
  resume/PDF mode to create or review a lane-specific artifact before retrying
  a role whose file is missing or stale.

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
