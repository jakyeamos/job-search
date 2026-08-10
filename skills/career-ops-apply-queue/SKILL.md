---
name: career-ops-apply-queue
description: Prepare Career Ops' human-controlled application submission packets, inspect read-only forms, maintain the versioned question ledger, and enforce the manual final-submission boundary.
---

# Career Ops Apply Queue

## Human-controlled packet workflow

1. Read the current queue item and confirm its posting is fresh enough to
   inspect. A stale or archived role must be refreshed and revalidated first.
2. Run `pnpm exec node apply/application-packets.mjs --queue-id <id>` (or
   `--dry-run` first). The packet opens the application in the authorized
   browser session, records all safely reachable pages and controls, and never
   fills, selects, uploads, or submits anything.
3. Treat `ready-for-human-review`, `needs-user-input`, `blocked`, and `stale`
   as the only packet statuses. Login, CAPTCHA, MFA, identity verification,
   required fields needed to continue, unsupported flows, missing title/JD/apply
   evidence, and bridge loss are hard stops.
4. Review `data/application-question-ledger.json` and the grouped pending view:
   `pnpm exec node apply/question-ledger.mjs pending`. Only explicit user
   answers or verified profile values are reusable. User-confirmed answers get
   stable refs such as `question-ledger:q_x@v2`; adapter-observed answers stay
   unconfirmed until promoted.
5. For narrative answers and cover letters, keep the evidence-bound draft,
   run the humanizer, preserve the humanized revision, and require a factual
   claim audit plus human approval. Never humanize structured, legal, EEO,
   consent, authorization, compensation, CAPTCHA, MFA, or identity fields.
6. Review the resume decision and manifest. Reuse is allowed only for an
   existing audited artifact with current evidence, active posting, and
   sufficient role coverage; otherwise the packet generates a tailored resume.
   Cover-letter generation is independent of resume reuse.
7. Complete the packet checklist manually and perform the final Apply/Submit
   action yourself. Do not invoke the legacy auto-submit worker as part of this
   workflow.

## Ledger dogfood

Use `pnpm application-ledger-dogfood --sample 12` to produce a deterministic,
read-only plan over the queue. It does not open a browser or write files. Use
`--run` only after the browser bridge is healthy; the runner copies the canonical
ledger into a staging root, disables resume and cover-letter artifacts, and
continues sequentially through a capped sample while preserving per-role
results.

`--shape-only` is an explicit form-diagnostic mode for supported ATS URLs whose
queue liveness or description evidence is incomplete. It is useful for
question-shape and semantic-dedup dogfooding, but every result is marked
unverified and must remain outside active application evidence. The runner
never promotes answers or crosses the manual submission boundary.

## Browser-first intake and artifact retrieval

The authenticated application path is browser-first. The packet uses the
authorized Chrome session through the browser bridge and does not prefer a
browser-free client for form traversal. The existing artifact generator may use
its bounded description fallback for queue data, but that is separate from the
authenticated form and never performs application writes.

Job-source adapters remain separate from packet preparation. Jack & Jill is a
browser-mediated source and coaching tool; use its local skill and explicit
commands rather than deriving an API client for its authenticated flows.

## Safety contract

- Never invent answers, experience, dates, certifications, salary, work status,
  relocation, or legal/HR information.
- Never bypass authentication, CAPTCHA, MFA, rate limits, or a site's controls.
- Never submit EEO/demographic or marketing-consent fields automatically.
- Do not expose private repositories, credentials, customer data, or raw form
  data in logs or generated content.
- Unsupported or ambiguous forms remain blocked for manual handling.
- The `application-queue.mjs clear` command is the bounded bulk-fill surface:
  it selects supported high-fit roles, fills them in one visible Chrome handoff,
  and waits for human review and submission. The `run` command is fill-only
  when invoked directly. Neither path clicks the final Apply/Submit/Send
  control or crosses the manual submission boundary.
- The queue worker generates contract-managed resume and cover-letter artifacts from
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
