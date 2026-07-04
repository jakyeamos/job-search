# Review: "2026 CS Career Playbook" (external doc)

**Last updated:** 2026-07-03
**Source file:** `research/2026 CS Career Playbook.md` (user-provided, unknown authorship, AI-assisted research report with 64 citations)

## Source Quality Assessment

Read critically before trusting the data points. Most of the 64 citations are SEO content-mill sites (rockstardeveloperuniversity.com, jobstrack.io, onehour.digital, jobcannon.io, dataexpert.io, frontendmentor.io) rather than primary sources. A minority trace to real primary data (NACE, Federal Reserve Bank of NY, BLS, Glassdoor, LinkedIn Economic Graph). This is weaker sourcing than `market-intel-2026-07.md` (Fed Reserve, Pragmatic Engineer, Stanford Review, Glassdoor).

**Verdict:** treat quantitative claims (23% growth, 61% of postings require dbt, 340%-style precision numbers) as directional flavor, not hard fact. The structural thesis, however, is sound and corroborated independently by our own market-intel doc.

## Where It Agrees With Existing Market Intel

- Entry-level SWE hiring is structurally compressed ("barbell" pattern favoring senior + junior-with-differentiation), not a temporary dip. Matches `market-intel-2026-07.md`'s "worst entry-level market in a decade" finding.
- AI-tool fluency is now a baseline screening signal, not a differentiator. Matches market-intel's "340% YoY surge in AI-fluency-required postings" and its already-open recommendation to promote the Terrace/AIOS analog archetype.
- Referrals/warm outreach vastly outperform cold portal applies (this doc: 20-30% vs <1%; general industry consensus agrees, though exact percentages are unverified).

## New Angle This Doc Adds

The candidate holds a **CS degree with minors in Artificial Intelligence, Applied Data Science, and Statistics** (`cv.md` Education section) — this is close to exactly the profile the playbook argues has a structural edge right now: Data Engineer, Analytics Engineer, and AI/ML Engineer roles are reported as resilient/growing while generalist junior SWE pipelines shrink.

This wasn't reflected anywhere in the system before this review — `portals.yml` had no data/analytics/ML title filters, and `config/profile.yml` / `modes/_brief.md` had no corresponding archetype.

## Changes Applied

1. **`portals.yml`** — added positive title filters: Data Engineer, Analytics Engineer, Machine Learning Engineer, AI Engineer, MLOps, Data Platform Engineer. Purely additive to the scan net, no existing filters removed.
2. **`config/profile.yml`** — added two new **secondary** archetypes: Data Engineer, AI / ML Engineer. Kept as secondary (not primary) because there's no dedicated portfolio project or work experience proof point for this lane yet — see Gap below. Also fixed a stray smart-quote YAML syntax bug on the Go-to-Market Engineer entry while editing this file.
3. **`modes/_brief.md`** — added Data / Analytics Engineer as a Secondary archetype (citing the CS minor + Soundscape's Postgres/Prisma data layer as the honest existing proof, nothing invented). Promoted the "AI-assisted dev tooling" analog from Bonus to Secondary, closing the open action item from `market-intel-2026-07.md`.

## Explicitly NOT Applied (needs your call)

1. **Portfolio project gap.** The candidate has zero dedicated data-engineering/RAG-evaluation project. The playbook's Project 2 ("RAG Observability": FastAPI + Pinecone + LangChain + Ragas + MLflow + Streamlit) would be the best-fit build — it extends the existing Terrace/AIOS AI-tooling narrative with measurable eval metrics instead of adding a totally new domain. This is a real time investment; I'm not building it or claiming it exists. Your call whether to prioritize it.
2. **Certifications.** Playbook flags dbt Certified Developer and AWS Certified Data Engineer Associate (DEA-C01) as high-signal, low-cost credentials for this pivot. Not added anywhere as a requirement — flagging as an option, since a cert without a supporting project is a weaker signal than the project itself.
3. **90-day structured plan / TIARA outreach templates / channel-mix targets.** Interesting tactical content but overlaps with existing `modes/contacto.md` and `modes/pipeline.md` workflows already in place. Didn't restructure those — the existing pipeline (score-gated triage, batch eval, tracker) already implements the "prioritize high-signal channels over cold apply" principle in spirit. Flag if you want an explicit referral/outreach cadence added.
4. **ATS resume format.** Playbook stresses single-column, standard-header resumes for ATS parsers. Checked `templates/cv-template.html` — it already uses inline flex rows (contact line, job/edu headers, skills grid), not a sidebar/two-column layout. No change needed.

## Open Questions / Follow-ups

- If a data-engineering-flavored role clears MARGINAL/PASS in triage, the CV match dimension will be weaker than for core SWE roles until a real project exists — expect these to skew MARGINAL rather than strong PASS for now.
- Re-check this pivot's traction once a few data/analytics-tagged postings run through triage — if they consistently score low on CV match, deprioritize; if scan volume + relevance look good, consider building the RAG-observability project.
