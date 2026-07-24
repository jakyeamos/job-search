# Scan Calibration & Scanner Infrastructure — Lessons (2026-07)

Captured 2026-07-04 during a Level-2 API sweep + Level-3 discovery run.

## 1. Raw title-match counts overstate the actionable set by ~100×

A full Greenhouse/Lever/Ashby sweep returned **3,939 postings → 471 title-relevant → 339 "new" vs. history → 2 genuinely actionable** after applying the candidate's real constraints. Always collapse raw matches through the three-constraint fit filter **before** adding to the pipeline:

1. **Early-career** — title carries a new-grad/entry/associate-SWE signal, or is a plain SWE title *known* to be junior-open. Plain "Software Engineer" with no marker is unknown-level, not early-career.
2. **US / remote-US** — candidate is a US citizen; EU/UK/APAC roles are a work-auth blocker unless the JD offers sponsorship. ~166 of 339 were non-US.
3. **Non-defense** — standing exclusion (now in `config/profile.yml` → `deal_breakers`). Most of Palantir's New Grad roles were Intel/US-Gov/Defense and were dropped; only Commercial variants kept.

Net: do **not** mass-add sweep output. The pipeline was already saturated (159 pending, unevaluated). Discovery is not the bottleneck — **evaluation is**. Prefer draining the backlog over broad re-scans.

## 2. `title_filter.positive: "Associate"` is over-broad

Standalone `Associate` matches non-engineering roles: *Associate General Counsel, Strategic Finance Associate, Recruiting Operations Associate, Virtual Events Associate, Business Operations Associate, Air Operations Associate*. Consider tightening to `Associate Software Engineer` / `Associate Engineer`, or gate `Associate` behind an engineering co-term. Until then, hand-filter Associate hits.

## 3. Geo-duplication inflates "new" counts

Greenhouse/Lever list the **same role under one job ID per location** (e.g. Intercom "IT Systems Engineer" under 7930382 *and* 7918638). URL-dedup alone treats each as new. `scan.mjs` now also dedups by **company + normalized title** (parentheticals stripped) across scan-history, pipeline, and applications — collapsing multi-location dupes. This cut a sweep's "new" from 306 → 200.

## 4. ATS drift — verify slugs periodically

Fixed this session in `portals.yml`:
- **Temporal**: greenhouse slug `temporal` → `temporaltechnologies`.
- **Weights & Biases → CoreWeave**: acquired; jobs now on `greenhouse/coreweave`.
- **Tinybird**: was configured as Ashby; actually on **Lever** (`jobs.lever.co/tinybird`).
- **Disabled** (dead endpoint + EU-only work-auth blocker): Vinted, TravelPerk, Factorial.

## 5. Ashby public API errors for some org slugs

`jobBoardWithTeams(organizationHostedJobsPageName)` returned `"Unidentified server error"` for several discovered boards (continue, cerebras, foxglove, mirage, …) while working fine for tracked orgs (Ramp, Cohere). Search-discovered Ashby boards are **not always resolvable via the public API** — fall back to Playwright (Level 1) to confirm/scrape them before tracking.

## 6. Scanner infrastructure was missing from the repo

`package.json` referenced scripts that did not exist: `scan.mjs`, `scan-ats-full.mjs`, `openrouter-runner.mjs`, `validate-portals.mjs`, `verify-portals.mjs` — so `pnpm run scan`, `scan:full`, `validate:portals`, `verify:portals` all failed.

- **Rebuilt `scan.mjs`** (Level 0/2 zero-token sweep): js-yaml config, Greenhouse/Lever/Ashby fetchers, title+location filter, 3-source dedup. **Safe by default** — dry-run report unless `--write` is passed (encodes lesson #1: never silently flood the inbox). Flags: `--write`, `--json`, `--company <name>`.
- **Still missing** (rebuild or remove the package.json entries): `scan-ats-full.mjs` (seeds: yc/a16z), `openrouter-runner.mjs`, `validate-portals.mjs`, `verify-portals.mjs`.

## Backlog drain — two-pass triage → full-eval (2026-07-04)

Drained a 165-item inbox: cleared 7 API-dead + deferred 119 out-of-scope (senior/EU/specialized) + triaged 39 in-scope → full-evaluated the 19 PASSes. Lessons:

- **Triage over-scores; full-eval corrects on YOE floors buried in the JD body.** Title-level triage missed experience minimums that dropped scores hard on full read: OpenAI Product Eng GTM **4.3→2.4** (4+ yrs), Twilio L1 **4.7→3.6** (Remote-US band *excludes NY* — candidate is in Buffalo), Nuro **4.2→3.7** (C++/on-site). Always full-eval PASSes before trusting the number; never apply off a triage score alone.
- **"Live" ATS URLs rot fast — apply to the current req, not the tracked link.** Meta Univ-Grad req went closed mid-session; Notion + Benchling tracked links 404'd but the role is live under a new posting. Re-find the live posting at apply time.
- **The defense deal-breaker works end-to-end.** Palantir Denver "SWE New Grad" full-eval confirmed a US-security-clearance / intelligence (Gotham) requirement → auto-Discarded per `config/profile.yml` deal_breakers. The Commercial FDSE variant passed. Location/title alone can't tell them apart — the JD body does.
- **Best fits reward remote-US + no-relocation + AI-tooling overlap:** Mercury (Remote-US incl NY), Cohere (agent/automation platform = candidate's Terrace/tmcp lane), Notion (TS/Next/tRPC core). Comp was a non-issue everywhere (all ≥ target).

## 7. Queue sortScore can rank a hard-blocked role #1 (2026-07-24)

The application queue's `sortScore` ranked **Celonis "Associate (AI) Solution Consultant — Orbit Program" #1 of today's selection**, but full-eval is a **1.5/5 SKIP** — two hard blockers the sort ignored:

- **Language MUST buried in the JD body.** *"fluency in German and English (must)."* Candidate has no German. Same failure mode as tracker #44 (the Japanese Orbit variant) — the Orbit program localizes by market, and each variant carries a native-language MUST that title/location metadata don't expose.
- **Location + EU work-auth.** Madrid-based 2 yrs → Munich relocation, DACH customer base. `deal_breakers.location_policy.requires_sponsorship_abroad: true` applies; this is a local Spain hire.

Lessons: (a) **a high sortScore is not a fit verdict** — never surface a queued role as "ready" without confirming the JD-body language/work-auth requirements; (b) **graduate/rotational programs (Orbit, etc.) are language-gated per market** — treat any DACH/LatAm/APAC-based grad track as carrying a native-language MUST until the JD says otherwise; (c) consider a queue pre-filter that down-ranks non-US grad-program postings with a foreign-language token in the JD.

## Net-new employers added (Level 3 discovery, US early-career SWE)

SeatGeek (SWE New Grad, NYC) · Sigma Computing (New Grad Program + FDE, SF/NYC) · Nuro (SWE AI Platform New Grad, Mountain View — AV differentiator). Added to `tracked_companies` and the pipeline.
