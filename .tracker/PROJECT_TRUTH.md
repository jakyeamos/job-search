# Career Ops Project Truth

## Current State

- Post-application outreach is implemented in commit `caf83bb`.
- Queue `Applied`, local confirmed application runs, and matched Gmail confirmation messages feed one idempotent outreach record per company and role.
- Email is fail-closed to `jakyejobs@gmail.com`; LinkedIn output remains a manual draft.
- Initial live-email ramp is capped at two messages per day until explicitly completed.
- Gmail setup wizard is terminal-safe and currently paused at Stage 1 for Gmail API confirmation.
- `config/profile.yml` locally permits the outreach policy, while `data/outreach-state.json` remains disabled until the user enables the verified Gmail account.

## Current Position

- Contact candidates are accepted only with public professional evidence; guessed, private, personal, unrelated, and duplicate contacts are rejected.
- The queue UI exposes outreach status, verified-email state, follow-up dates, and LinkedIn drafts.
- Follow-ups are scheduled five business days after a send and stop on replies, bounces, opt-outs, rejection, closed roles, or pause.

## Next Step

1. Reauthorize Gmail with the `gmail.send` scope using `bash scripts/setup-gmail.sh`.
2. Review the dry run and run `node outreach.mjs enable-email` only when ready for the two-email ramp.
3. Populate the ignored `data/outreach-contacts.json` through `contacto` or another approved public-source discovery pass.
4. Run `node outreach.mjs process` and review the queue UI before completing the ramp.

## Validation

- 41 repository tests pass.
- JavaScript syntax checks, `git diff --check`, queue verification, doctor, and the no-network outreach dry run pass.
- Doctor reports only the existing warning that Playwright MCP tools are not configured.
