# Triage Brief -- Compact Context for First-Pass Scoring

<!-- ============================================================
     SYSTEM LAYER (auto-updatable), but content is candidate-specific.
     This is a compressed extract of cv.md + config/profile.yml +
     modes/_profile.md, built for ONE purpose: cheap first-pass
     triage scoring in modes/triage.md (~1.5K tokens vs ~26K for
     the full context stack).

     Regenerate this file whenever cv.md, config/profile.yml, or
     modes/_profile.md change materially. Full evaluations
     (modes/oferta.md) still read the complete, authoritative files --
     this brief is ONLY for the triage pass.
     ============================================================ -->

## Candidate

Jakye Amos -- Full-Stack / Backend Software Engineer, New Grad (B.A. Computer Science, Case Western Reserve, expected May 2026).

- Location: Cleveland, OH (America/New_York). Open to remote, hybrid, on-site, and relocation.
- Work authorization: US citizen. No visa, no sponsorship needed for US roles.
- Stack: TypeScript, JavaScript, Python, Java, Go, React, Next.js, Node.js, Prisma, tRPC, PostgreSQL, Docker, AWS, Socket.io, Expo.

## Target Archetypes (6 core + 1 analog)

| Archetype | Signal in JD | Fit |
|---|---|---|
| New Grad / Early-Career SWE | "new grad", "2024-2026 grad", "entry level", "associate" | Primary |
| Full-Stack Engineer | React/Next.js + Node.js + Postgres, product surfaces | Primary |
| Backend Engineer | APIs, services, databases, distributed systems | Primary |
| Product / Platform Engineer | internal tools, DevEx, monorepo, shared infra | Primary |
| Forward-Deployed / Solutions Engineer | client-facing, fast delivery, prototype-to-prod | Secondary (only if 0-2 YOE) |
| Go-to-Market Engineer | growth eng, revenue eng, integration eng | Secondary |
| Data / Analytics Engineer | ETL/ELT, dbt, Airflow, Snowflake/Databricks, data pipelines | Secondary -- no dedicated project yet, lean on CS minor (AI, Applied Data Science, Statistics) + Soundscape's Postgres/Prisma data layer |
| Analog: AI-assisted dev tooling | agents, dev tooling, Claude Code / Copilot-adjacent, RAG/LLM pipelines | Secondary -- Terrace + AIOS are direct proof (promoted from Bonus 2026-07; see research/market-intel-2026-07.md) |

## Proof Points (exact metrics -- never invent, never round differently)

- Cleveland Clinic clinical coaching MVP: shipped in 2 weeks, regulated healthcare deployment (Forward Automations)
- Cleveland architecture firm tool: +400% operational output, deployed in under 5 weeks (Forward Automations)
- STEM Playbook legacy refactor: 11-day rebuild, launched for a major live event (Forward Automations)
- AI marketing automation (Deepr, A16z portfolio company): -90% production timelines, 1.5M organic views
- Amazon SDE Intern (2023-2025): Ads + FinTech/business systems teams, pipeline testing across distributed infra
- Soundscape: full-stack monorepo (Next.js 14, tRPC, Prisma, shared web/mobile, Expo) -- feed/search/market/portfolio/ratings/admin
- Court Vision: Monte Carlo simulation engine, 30 player features, 13 archetypes, real-time multiplayer draft (Socket.io)
- Terrace: spec-driven AI development framework (own project -- direct agentic/AI tooling proof)
- AIOS: personal AI operating system -- session hooks, pattern extraction, second-brain infra for Claude Code workflows
- CWRU Flea Market (Founder/President): recurring campus event, 600+ attendees, roughly $7K revenue per event

## Comp Strategy

- Target range: $120K-$165K USD. Floor: $105K.
- Base salary is the floor test. Equity, bonus, and relocation stack ON TOP of the floor -- they never consolidate into it or substitute for it.
- Base at or above $120K = strong on comp regardless of equity structure.
- Base below $105K needs an exceptional non-comp reason (mission, learning velocity, brand) to survive triage -- flag MARGINAL, don't auto-PASS.
- Undisclosed compensation: -0.5 adjustment, not an auto-DQ.

## Location Scoring

| Situation | Score |
|---|---|
| Full remote (US or global-remote-eligible) | 5.0 |
| Hybrid/onsite in US, relocation covered or feasible | 4.0 |
| Hybrid/onsite outside US, no visa/citizenship required | 3.0 |
| Remote but restricted to a non-US region (EMEA/LATAM/APAC only) | 1.0 (DQ) |
| Onsite outside US requiring visa/sponsorship the candidate doesn't have | 1.0 (DQ) |

## Hard DQ Criteria (auto-FAIL, score capped at 2.0)

1. Minimum experience stated is 3+ years (candidate is new grad / 0-2 YOE)
2. Role geographically restricted to a region excluding the US, with no US-remote option (EMEA-only, LATAM-only, APAC-only)
3. Requires visa/work authorization the candidate doesn't have (candidate is a US citizen -- this only bites on non-US roles requiring local citizenship/visa)
4. Requires fluency in a language other than English or French
5. Stack is fully incompatible: embedded/firmware/FPGA, iOS/Android native only, or JVM-only (Java/Kotlin/Scala) with no TS/JS/Python/Go component
6. Posting is expired or closed (verify before scoring -- if ambiguous, note and continue rather than DQ)

## Soft Red Flags (subtract 0.2-0.5 each, don't auto-DQ)

- Mandatory on-site 4-5 days/week
- Undisclosed compensation
- "Wear many hats" / no defined scope for an entry-level role
- Equity-heavy offer with low or no cash base
- Posting live 60+ days with no clear reason (may signal low urgency or backfill churn)
- Requires a tool/skill with zero candidate overlap (e.g. SAP, Salesforce admin, native mobile only)
