# Mode: weekly -- Job-search operating review

Use this mode when the candidate asks for a weekly review, asks what to do
next, wants to update the job-search plan, or wants to understand where the
funnel is breaking.

## Read order

1. `data/search-ops.md` -- active targets, scoreboard, and user-entered outreach or interview counts
2. `data/applications.md` -- application history and status ledger
3. `data/pipeline.md` -- pending and recently processed job URLs
4. `config/profile.yml` and `modes/_profile.md` -- current lanes and evidence mapping

Do not load every historical report unless a specific role or conversion
question requires it.

## Operating rules

- Count only `Applied`, `Responded`, `Interview`, `Offer`, or `Rejected` as submitted application outcomes. `Evaluated` is not an application.
- Separate all-time history from the active week. Never infer outreach, demos, screens, or finals from silence; use explicit user-entered counts or tracker evidence.
- Prefer high-fit, live postings and lane-specific resumes over undirected volume.
- Use company career pages first, then a reputable job board. Verify liveness before evaluation or application preparation.
- After an application, route to `modes/contacto.md` for a targeted recruiter, hiring-manager, peer, or alumni message.
- Do not claim Salesforce certification, Snowflake, specific AWS services, customers, revenue, pilots, or other unverified requirements.
- This mode recommends and updates the active scoreboard only. It never submits an application or sends a message.
- Do not rewrite historical reports or silently change application statuses.

## Output

Return a compact review with:

1. **Scoreboard:** actual vs target for high-fit applications, warm outreach, follow-ups, proof assets, interview practice, screens, technicals, and finals.
2. **Lane mix:** which target lanes received attention and which are neglected.
3. **Funnel diagnosis:** identify whether the next constraint is discovery, screening, technical conversion, or final-round conversion.
4. **Next five actions:** concrete roles, people, follow-ups, or proof assets; each action must have a lane and an evidence source.
5. **Stale items:** pending URLs or evaluated roles that need liveness verification or a decision.

## Diagnosis thresholds

- Fewer than 15 high-fit applications in a week: discovery/targeting is underfed.
- Applications are on target but warm outreach is below 15: distribution is underfed.
- Screens remain below 2 after a sustained two-week run: resume, role fit, or eligibility needs review.
- Screens occur but technicals do not: tighten the role pitch and screen preparation.
- Technicals occur but finals do not: inspect project explanations, take-home packaging, live coding, and role targeting.
- Finals occur but offers do not: review behavioral evidence, tradeoffs, references, and compensation strategy.

## Write behavior

When the candidate supplies new counts, update only the active-week cells in
`data/search-ops.md`. If the candidate supplies a new application outcome,
follow the tracker workflow and preserve the existing row/report history.
