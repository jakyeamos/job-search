---
name: career-ops-apply-queue
description: Run Career Ops' authorized, human-accountable application queue. Use when the candidate asks to clear selected job applications, fill or submit supported ATS forms, maintain the application question ledger, inspect application-run state, or disable or recover the auto-apply workflow.
---

# Career Ops Apply Queue

## Workflow

1. Read the current queue and policy. If the policy is disabled, stop and show
   the exact authorize/disable controls instead of guessing authorization.
2. Run `node application-queue.mjs dry-run --limit N` and inspect the selected
   roles, ATS adapter, liveness, score, and resume artifact.
3. Run `node application-queue.mjs run --limit N` only after the candidate's
   explicit authorization is current. The worker submits only supported ATS
   forms and records an idempotent run result.
4. Review `data/application-question-ledger.json` after blocked runs. Answer a
   question only from the exact form wording and choose a narrow scope for
   sensitive answers.
5. Treat `submitted` and `submission_unknown` as terminal until the external
   state is verified. Never retry an unknown submission automatically.

## Safety contract

- Never invent answers, experience, dates, certifications, salary, work status,
  relocation, or legal/HR information.
- Never bypass authentication, CAPTCHA, MFA, rate limits, or a site's controls.
- Never submit EEO/demographic or marketing-consent fields automatically.
- Do not expose private repositories, credentials, customer data, or raw form
  data in logs or generated content.
- Unsupported or ambiguous forms remain blocked for manual handling.
- The worker uses the queue item's verified `resumeArtifact`; generate or review
  a lane-specific PDF through the existing resume/PDF modes before re-running if
  the artifact is missing or stale.

## Local surfaces

- `data/application-policy.json` — revocable local submission authorization.
- `data/application-question-ledger.json` — explicit reusable answers.
- `data/application-runs.json` — idempotency and outcome audit trail.
- `modes/auto-apply.md` — Career Ops command reference.
