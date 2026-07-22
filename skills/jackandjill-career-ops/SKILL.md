---
name: jackandjill-career-ops
description: Use Jack & Jill's authenticated browser session for explicit resume coaching and import its canonical job recommendations into career-ops.
---

# Jack & Jill Career Ops

Use this skill only for an explicit coaching, job-retrieval, or recommendation
sync request. Keep the external work bounded to the user's authenticated
Chrome session and the read-only career-ops pipeline.

## Coaching workflow

1. Read `cv.md`, `article-digest.md`, and `config/profile.yml` at execution time;
   these are the canonical evidence sources.
2. Retrieve the live record with `node jackandjill.mjs job --url <url>`.
3. Ask Jack for a role-specific review with
   `node jackandjill.mjs coach --job-url <url> --strict-evidence`.
4. Use Jack's response as the primary coaching source and the local prompt
   contract as the reproducible calibration layer.
5. Review `evidenceAudit` before editing a resume or cover letter. Reject or
   rewrite any unsupported metric, tool, date, customer, responsibility, or
   outcome; never repair an evidence gap by guessing.

Calibration uses the redacted Netic and Lightfield examples plus five
representative live roles when the browser bridge is healthy. Extract useful
prioritization and evidence-checking structures into the local Career-Ops
coaching skill, then use that local skill by default for packet generation.
Jack remains available on demand for a fresh role-specific review; a coaching
response never silently becomes a canonical answer or resume fact.

The generated prompt must request the useful structure demonstrated in the
Netic and Lightfield examples: summary/headline, prioritized proof-point edits,
project ordering, skills emphasis, and an optional cover letter.

## Recommendation workflow

1. Use `node jackandjill.mjs jobs --details` for a read-only authenticated
   enumeration, or `node jackandjill.mjs sync --write` to refresh the local
   ignored cache.
2. Use `--pipeline` only with explicit `--write` when the user wants the
   canonical pipeline writer to add new records.
3. Run the normal queue refresh so liveness, scoring, resume tailoring, and
   duplicate handling remain centralized.

Only a stable `/jobs/{uuid}/post` identity becomes a career-ops lead. Preserve
the original source URL and Gmail `sourceMessageId`; use `source-alert` for
missing title, description, or application path; never generate an application
report from an incomplete record. Chat-only recommendations stay advisory.

The 8 AM scheduled queue path consumes the Jack recommendation cache for job
discovery and queue refresh only. It does not run coaching for every role and
does not create application packets, resumes, cover letters, or answer drafts.
Packet preparation is explicit for a selected queue role:

```bash
pnpm exec node apply/application-packets.mjs --queue-id <queue-id>
pnpm exec node apply/application-packets.mjs --queue-id <queue-id> --answers path/to/answers.json
```

Store raw Jack responses and packet-local answer drafts under ignored local
paths such as `data/jackandjill-coaching/` and
`data/application-answer-drafts/`. The packet should retain the coaching URL,
prompt/response provenance, evidence audit, and any humanizer audit without
committing the authenticated transcript. Promote an answer into
`data/application-question-ledger.json` only after the user confirms it.

Do not submit applications, send recruiter messages, alter the Jack account,
store credentials or tokens, inspect browser storage, or bypass login,
CAPTCHA, MFA, rate limits, or a lost browser bridge.
