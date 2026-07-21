---
name: career-ops-apply-queue
description: Run Career Ops' authorized, human-accountable application queue. Use when the candidate asks to clear selected job applications, fill or submit supported ATS forms, maintain the application question ledger, inspect application-run state, or disable or recover the auto-apply workflow.
---

# Career Ops Apply Queue

## Workflow

1. Read the current queue and policy. If the policy is disabled, stop and show
   the exact authorize/disable controls instead of guessing authorization.
2. Run `node resume.mjs plan --limit N` and
   `node application-queue.mjs dry-run --limit N`. Inspect the selected roles,
   ATS adapter, liveness, score, resume lane, selected projects, evidence
   sources, manifest status, and artifact path. A dry run may report
   `would-generate-and-submit`; the actual worker creates and audits the
   tailored resume and cover letter immediately before the adapter run.
3. Run `node application-queue.mjs run --limit N` only after the candidate's
   explicit authorization is current. The worker submits only supported ATS
   forms and records an idempotent run result.
4. Review `data/application-question-ledger.json` after blocked runs. Answer a
   question only from the exact form wording and choose a narrow scope for
   sensitive answers. For accomplishment prompts, the adapters also consult
   `config/project-accomplishment-ledger.json` and select a verified project from
   the posting lane and description; an explicit scoped answer remains the
   override.
5. Treat `submitted` and `submission_unknown` as terminal until the external
   state is verified. Never retry an unknown submission automatically.

## Browser-free intake and artifact retrieval

The queue keeps the browser for the form interaction, but it uses public ATS
HTTP endpoints first when a supported posting needs a fuller job description.
The generated manifest records `descriptionSource: ats-api` and the public
endpoint when that path succeeds; an unavailable or too-short response falls
back to the existing posting-page fetch and then fails closed if the description
is still insufficient.

When a new public job source needs a browser-free path, use the `$derive-api-client`
skill before adding or changing a provider. The derived client belongs in the
existing `providers/` contract, reuses `providers/_http.mjs`, records endpoint
provenance, and returns normalized listings for `scan.mjs`. Derive only public,
read-only listing or description requests. Never derive application POSTs,
login/MFA flows, CAPTCHA controls, or any request that changes external state.
After a provider change, run `node validate-portals.mjs`, a scoped
`node scan.mjs --dry-run --company <name>`, and its focused contract tests before
using the application queue.

## Safety contract

- Never invent answers, experience, dates, certifications, salary, work status,
  relocation, or legal/HR information.
- Never bypass authentication, CAPTCHA, MFA, rate limits, or a site's controls.
- Never submit EEO/demographic or marketing-consent fields automatically.
- Do not expose private repositories, credentials, customer data, or raw form
  data in logs or generated content.
- Unsupported or ambiguous forms remain blocked for manual handling.
- The worker generates contract-managed resume and cover-letter artifacts from
  canonical evidence and the queue posting. Existing resume/PDF renderers
  remain available, and their approved output can still be registered with
  `node resume.mjs register ...`.
- Legacy existing PDFs may be used during migration, but they are labeled
  `legacy-existing`; the worker never presents them as tailored evidence.

## Local surfaces

- `data/application-policy.json` — revocable local submission authorization.
- `data/application-question-ledger.json` — explicit reusable answers.
- `data/application-runs.json` — idempotency and outcome audit trail.
- `resume-contract.mjs` — single queue-facing request, manifest, and artifact
  validation contract.
- `resume.mjs` — plan and register commands for all resume renderers.
- `modes/auto-apply.md` — Career Ops command reference.
