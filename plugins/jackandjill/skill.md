# Jack & Jill Career Ops

Use this integration only for an explicit, user-invoked coaching or job-source
run. The browser adapter uses the already authenticated Chrome session; it does
not inspect cookies, tokens, password stores, or browser profile files.

## Coaching

1. Read `cv.md`, `article-digest.md`, and `config/profile.yml` at run time.
2. Retrieve a complete Jack & Jill job record with `node jackandjill.mjs job --url <url>`.
3. Run `node jackandjill.mjs coach --job-url <url> --strict-evidence`.
4. Treat the live Jack response as the primary coaching source, but review the
   evidence audit before editing anything. Never accept a new metric, tool,
   date, customer, responsibility, or outcome that is not in the canonical CV,
   proof-point digest, profile, or live job description.

The prompt requests a summary/headline replacement, prioritized proof-point
edits, project ordering, skills emphasis, and an optional cover letter. Preserve
the user's truthful voice and flag missing evidence instead of filling gaps.

Use Jack for calibration and explicit role-specific coaching, not for every
role in the scheduled queue. Raw responses stay in ignored local coaching
storage; they are reviewed before becoming packet-local drafts or confirmed
ledger answers.

## Job source

Run `node jackandjill.mjs sync --write` to refresh the local, ignored cache.
Use `--pipeline` only with explicit `--write`; it adds only new canonical Jack
URLs. Then run `node queue.mjs refresh --skip-public` (or the normal refresh) to
score and select records through the existing liveness and resume contracts.

Only records with a stable `/jobs/{uuid}/post` identity enter the pipeline.
Chat-only recommendations remain advisory. Incomplete records remain
`source-alert` and must not produce a ready application or a report. Gmail
wrappers and direct Jack records deduplicate by the stable UUID while retaining
`sourceMessageId` when present.

The 8 AM scheduled refresh consumes the recommendation cache for discovery and
queue scoring only. It does not traverse application forms or generate
submission packets, resumes, cover letters, or answers. Use the explicit
human-controlled packet command for a selected role:

```bash
pnpm exec node apply/application-packets.mjs --queue-id <queue-id>
pnpm exec node apply/application-packets.mjs --queue-id <queue-id> --dry-run
```

Never submit an application, send recruiter messages, change the Jack account,
store credentials, or bypass login, CAPTCHA, MFA, rate limits, or a bridge
failure.
