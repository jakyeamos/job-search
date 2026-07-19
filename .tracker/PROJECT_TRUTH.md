# Career Ops Project Truth

## Current State

- Post-application outreach and Firecrawl-backed public contact discovery are implemented in commits `0fabef4` and `cbb62fd`; the authorized queue worker now invokes one bounded outreach pass after any batch with a confirmed submission in `722ae19`.
- Queue `Applied`, local confirmed application runs, and matched Gmail confirmation messages feed one idempotent outreach record per company and role.
- Email is fail-closed to `jakyejobs@gmail.com`; LinkedIn output remains a manual draft.
- Initial live-email ramp is capped at two messages per day until explicitly completed.
- Gmail OAuth is verified for `jakyejobs@gmail.com`, email outreach is enabled, and the 8:00 AM local queue/UI launch agents are installed.
- Firecrawl-backed discovery uses the stored local CLI credential when available; no guessed, private, LinkedIn-scraped, or TeamWork Online contacts are eligible for sending.
- Discovery now adds a first-party Gmail relationship pass plus configured Amazon/CWRU public-network searches; public LinkedIn snippets may contribute an explicitly published employer email only when employer-domain evidence passes.
- Current local outreach state has three records, zero sends, two blocked malformed aggregate-alert identities, and one valid Amazon application with eight candidates and two ranked LinkedIn drafts.
- The verified project-accomplishment ledger is `config/project-accomplishment-ledger.json`: 31 researched entries, 29 approved answer atoms, and 2 intentionally excluded planning/superseded entries. All absolute source references resolve locally.
- Job-aware accomplishment selection is implemented in `ef5390a`; the queue passes each role's lane and posting description into the ATS adapters.

## Current Position

- Contact candidates are accepted only with public professional evidence; guessed, private, personal, unrelated, and duplicate contacts are rejected.
- The processor searches for public recruiter, hiring-manager, and team evidence plus verified first-party Gmail relationships after application signals; `data/outreach-contacts.json` remains a supplement/correction manifest.
- Warm-network discovery reads only Gmail headers/IDs, never stores message bodies, and uses configured Amazon/CWRU sources to find relevant public recruiter, hiring-manager, and team signals without scraping LinkedIn or auto-messaging.
- Dogfood found and fixed a result-preservation defect in `cbb62fd`: scraped/search contact candidates now survive deduplication and retain search-result identity metadata.
- The autonomous application worker preserves the existing fail-closed submission states and triggers outreach only for confirmed `submitted` results; dry runs, blocked, failed, and `submission_unknown` outcomes do not trigger it.
- The queue UI exposes outreach status, verified-email state, follow-up dates, and LinkedIn drafts.
- Follow-ups are scheduled five business days after a send and stop on replies, bounces, opt-outs, rejection, closed roles, or pause.
- ATS adapters now select an approved accomplishment from the project ledger using the queue lane and job description; explicit scoped answers in `data/application-question-ledger.json` override that selection.

## Next Step

1. Review the two Amazon LinkedIn drafts in the queue UI and send manually if they are relevant; no email is pending because Gmail contained no Amazon relationship thread and no public address was verified.
2. Add any former Amazon manager, mentor, or teammate to `data/outreach-contacts.json` only if the identity and professional relationship are known; the resolver will then rank the warm contact against public hiring contacts.
3. Keep accomplishment answers current by adding only verified outcomes/status changes to the project ledger; do not replace the lane selector with a single global answer.
4. Complete the two-email ramp only after reviewing the first live sends.

## Validation

- 65 repository tests pass, including the job-aware project-accomplishment selector and adapter integration, Gmail relationship extraction, Amazon/CWRU network queries, employer-domain email validation, mocked search-plus-scrape discovery, and the autonomous post-submission outreach trigger contract.
- Live discovery against the current valid Amazon record completed with 2 public searches, 4 warm-network searches, 19 retained source URLs, 8 ranked candidates, and 0 emails sent.
- JavaScript syntax checks, `git diff --check`, queue verification, doctor, project-ledger source validation, and the no-network outreach dry run pass.
- Doctor reports only the existing warning that Playwright MCP tools are not configured.
