# Career Ops Project Truth

## Current State

- Post-application outreach is implemented in commit `caf83bb`; public contact discovery is now integrated in the current working tree.
- Queue `Applied`, local confirmed application runs, and matched Gmail confirmation messages feed one idempotent outreach record per company and role.
- Email is fail-closed to `jakyejobs@gmail.com`; LinkedIn output remains a manual draft.
- Initial live-email ramp is capped at two messages per day until explicitly completed.
- Gmail OAuth is verified for `jakyejobs@gmail.com`, email outreach is enabled, and the 8:00 AM local queue/UI launch agents are installed.
- Firecrawl-backed discovery uses the stored local CLI credential when available; no guessed, private, LinkedIn-scraped, or TeamWork Online contacts are eligible for sending.
- Current local outreach state has three records, zero sends, two blocked malformed aggregate-alert identities, and one valid application awaiting an eligible public contact.

## Current Position

- Contact candidates are accepted only with public professional evidence; guessed, private, personal, unrelated, and duplicate contacts are rejected.
- The processor searches for public recruiter, hiring-manager, and team evidence after application signals; `data/outreach-contacts.json` remains a supplement/correction manifest.
- The queue UI exposes outreach status, verified-email state, follow-up dates, and LinkedIn drafts.
- Follow-ups are scheduled five business days after a send and stop on replies, bounces, opt-outs, rejection, closed roles, or pause.

## Next Step

1. Apply to a valid queue role or mark a real application as `Applied` so discovery has a specific employer and role to research.
2. Let the scheduled queue refresh run `node outreach.mjs process`; review discovered contacts and any LinkedIn drafts in the queue UI.
3. Complete the two-email ramp only after reviewing the first live sends.

## Validation

- 54 repository tests pass.
- JavaScript syntax checks, `git diff --check`, queue verification, doctor, and the no-network outreach dry run pass.
- Doctor reports only the existing warning that Playwright MCP tools are not configured.
