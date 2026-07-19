# Career Ops Project Truth

## Current State

- Post-application outreach and Firecrawl-backed public contact discovery are implemented in commits `0fabef4` and `cbb62fd`; the authorized queue worker now invokes one bounded outreach pass after any batch with a confirmed submission in `722ae19`.
- Queue `Applied`, local confirmed application runs, and matched Gmail confirmation messages feed one idempotent outreach record per company and role.
- Email is fail-closed to `jakyejobs@gmail.com`; LinkedIn output remains a manual draft.
- Initial live-email ramp is capped at two messages per day until explicitly completed.
- Gmail OAuth is verified for `jakyejobs@gmail.com`, email outreach is enabled, and the 8:00 AM local queue/UI launch agents are installed.
- Firecrawl-backed discovery uses the stored local CLI credential when available; no guessed, private, LinkedIn-scraped, or TeamWork Online contacts are eligible for sending.
- Current local outreach state has three records, zero sends, two blocked malformed aggregate-alert identities, and one valid application awaiting an eligible public contact.

## Current Position

- Contact candidates are accepted only with public professional evidence; guessed, private, personal, unrelated, and duplicate contacts are rejected.
- The processor searches for public recruiter, hiring-manager, and team evidence after application signals; `data/outreach-contacts.json` remains a supplement/correction manifest.
- Dogfood found and fixed a result-preservation defect in `cbb62fd`: scraped/search contact candidates now survive deduplication and retain search-result identity metadata.
- The autonomous application worker preserves the existing fail-closed submission states and triggers outreach only for confirmed `submitted` results; dry runs, blocked, failed, and `submission_unknown` outcomes do not trigger it.
- The queue UI exposes outreach status, verified-email state, follow-up dates, and LinkedIn drafts.
- Follow-ups are scheduled five business days after a send and stop on replies, bounces, opt-outs, rejection, closed roles, or pause.

## Next Step

1. Apply to a valid queue role or mark a real application as `Applied` so discovery has a specific employer and role to research.
2. Review the outreach results produced automatically after confirmed queue submissions, or let the scheduled queue refresh run `node outreach.mjs process` for existing records.
3. Complete the two-email ramp only after reviewing the first live sends.

## Validation

- 56 repository tests pass, including a mocked search-plus-scrape discovery path and the autonomous post-submission outreach trigger contract.
- Live discovery against the current valid Amazon record completed with 2 bounded searches, 10 sources, and 0 eligible public contacts; no email was sent.
- JavaScript syntax checks, `git diff --check`, queue verification, doctor, and the no-network outreach dry run pass.
- Doctor reports only the existing warning that Playwright MCP tools are not configured.
