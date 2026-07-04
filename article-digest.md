# Article Digest — Proof Points

Compact, resume-ready proof points for CV/cover-letter tailoring. The evaluator and PDF
generator read this to pull evidence per role. **Rules:** everything here must be true and
speakable in an interview. Items marked `⚠ NEEDS CONFIRMATION` are truthful skeletons awaiting
detail — do not invent specifics to fill them. Last updated 2026-07-04.

> **Title note:** Forward Automations role = **CTO** (confirmed 2026-07-04).
> **Excluded from resumes:** `GitNexus` — 0 commits authored by Jakye, not in contributor list; it is a mirror of `abhigyanpatwari/GitNexus`, not original work. Never present as his.

---

## Lane A — AI / Agent Dev-Tooling  *(PRIMARY — verified from repo READMEs)*

The cohesive, differentiated story: Jakye builds **agent infrastructure and developer-quality tooling** — MCP servers, LSP servers, CLIs, published packages, and evidence/governance/quality-gate systems. Strong lead for AI-infra, dev-tools, platform, and builder-culture roles.

### Terrace — spec-driven, test-governed workflow CLI  *(published: npm `@jakyeamos33/terrace`)*
- Built and **published an npm CLI** (Node 22+) for spec-driven, test-governed AI-assisted development.
- Enforces recoverable repo state, explicit spec intent, protected tests, and **deterministic quality gates**; `ship check --json` exits nonzero on any blocking gate for CI use.
- Manages governance state in a versioned `.terrace/` contract and scaffolds agent config (AGENTS.md/CLAUDE.md/skills) when absent.

### AIOS — local-first operating layer for agent sessions  *(Python + SQLite)*
- Designed a **local-first operating system for agent work**: session-lifecycle hooks capture events at session boundaries into a **SQLite-backed** event store.
- Built a project-memory model that separates raw automation artifacts from human-reviewed notes (promotion only after review), treating Git repos as source of truth.
- Documented as a public engineering case study (architecture + operating principles).

### quality-runner — evidence-based quality orchestrator  *(Python; CLI + MCP server)*
- Built a **local-first audit-and-plan** tool that compiles standards, detects available quality gates, normalizes **evidence-backed findings**, and writes versioned `.quality-runner/` artifacts + an ordered remediation plan.
- Ships as both a **CLI and an MCP server**; read-only by design (no source edits/commits) so agents/humans review evidence before acting. Includes a backend-platform case study.

### pre-cr-suite — coverage-first pre-PR readiness  *(TypeScript monorepo; LSP)*
- Built a **TypeScript monorepo** delivering identical changed-line-coverage readiness across **VS Code, Neovim, and a headless CLI**.
- Authored a **Language Server (LSP)** so all editor clients share one behavior instead of duplicating logic; shared `@pre-cr/core` package owns coverage parsing, changed-line evaluation, and protocol contracts; `.pre-cr.json` is the versioned repo contract.

### eslint-plugin-anti-slop — product-quality lint rules  *(ESLint 9 flat config)*
- Authored an **opinionated ESLint 9 plugin** with config-driven rules that catch React/TypeScript product-quality problems (unjustified client components, placeholder copy, gradient text, arbitrary z-index, missing reduced-motion fallbacks, weak empty states, and more).
- Ships custom rules plus a CLI (`anti-slop check` / `anti-slop gate`) for pre-merge enforcement.

### tmcp — portable skill-packet workflows for MCP agents  *(Node; MCP stdio server)*
- Built an **MCP stdio server** that turns scattered agent instructions (skills, docs, rules, prompts, evidence) into task-specific packets: extracts behavior atoms, compiles the smallest useful packet, and runs repeatable workflows.
- Runs standalone or inside Claude/Codex plugin hosts; includes skill **harvesting and recommendation with confidence scoring**.

### research-domain-writing — claim-safe writing harness  *(published: PyPI `research-domain-writing`)*
- **Published a PyPI package** (`rdw`) — an agent-first harness for research-grounded writing that validates structured research packets, emits exact prompt bundles, and keeps outputs auditable.
- Domain-aware (technical/music/basketball) with explicit evidence limits and confidence values; installs agent slash-commands/skills.

**Lane A one-liner (summary use):** *"Ships agent infrastructure and developer-quality tooling — published npm/PyPI packages, MCP and LSP servers, and evidence-driven quality-gate systems."*

---

## Professional experience proof points  *(from cv.md — real)*

### Forward Automations — CTO (2023–present)
- Delivered a **Cleveland Clinic** clinical-coaching MVP in 2 weeks (regulated healthcare, full-stack architecture). *← lead hook for healthtech roles (Abridge/Ambience/OpenEvidence).*
- Built productivity software that increased a Cleveland architecture firm's operational output **~400%**, deployed in under 5 weeks.
- Led a legacy refactor for STEM Playbook, launching a stable app in **11 days** for a major live event.
- Developed AI marketing-automation tools that cut production timelines **~90%** and drove ~1.5M organic views for an a16z startup.

### Deepr (a16z portfolio) — Technical Consultant (2025)
- Engineered an AI-powered photo-carousel content-generation system that increased marketing viewership.
- Built an inline coverage-vector tool for real-time test-coverage awareness during code review.

### Amazon — SDE Intern, 3 terms (2023–2025)  `⚠ NEEDS CONFIRMATION`
Truthful skeleton only — **do not invent specifics.** Confirmed from cv.md:
- Completed **three SDE internship terms** across multiple teams, including **Ads** and **FinTech / business-systems** environments.
- Built a **data-analytics project delivering hiring insights** to business leaders and hiring managers.
- Contributed to internal testing/pipeline capabilities across distributed-systems infrastructure.

*To strengthen (backfill when available): stack/language per team, whether shipped to prod, scope/scale, end-of-internship demo. Sources to check: old resume, LinkedIn, return/offer letters, Amazon notes.*

---

## Lane B — Full-stack products  *(SECONDARY — repo descriptions only, READMEs not yet mined)*
- `soundscape-app` — full-stack music social platform; Next.js 14, tRPC, Prisma, Expo web+mobile monorepo.
- `Bball` (Court Vision) — basketball IQ platform; React, Node/Express, Socket.io real-time, Monte Carlo draft/season simulation.
- `portfolio` — personal portfolio site with project-truth sync and current-work surfaces.
- `realtime-messenger` — realtime messenger (built as a Legora-targeted application).
- `Hoopscout` — basketball recruiting-intelligence demo (athlete search, fit scoring, ranked cards).

## Lane C — Data science / analytics  *(SECONDARY — repo descriptions only, READMEs not yet mined)*
- `Dsci-proj` — survival-analysis pipeline + Next.js dashboard modeling GitHub issue-resolution risk. *← pairs with CWRU Data Science minor; relevant to healthtech-data roles.*
- `BBDS-Analytics-Product-Suite` / `BBDSE` — analytics product suite (TypeScript).
- Sports-analytics cluster: `Coach-Value-Over-Expected`, `Cap-Fit-Builder`, `Signal-Lab`, `Womens-Stats`, `Fantasy`, and others (Python).

*(Lanes B/C: verify each README before quoting specific technical claims on a resume.)*
</content>
