# Modes Index

Thin router. Open the ONE mode file for the task — don't read the whole directory.
Modes are System Layer except `_profile.md` (User Layer personalization). See
[../DATA_CONTRACT.md](../DATA_CONTRACT.md).

| Mode file | Trigger (user does…) | Purpose |
|---|---|---|
| [auto-pipeline.md](auto-pipeline.md) | pastes a JD or URL | **Default.** Evaluate → report → PDF → tracker in one pass |
| [oferta.md](oferta.md) | "evaluate this offer" | Full A–G offer evaluation + scored report |
| [ofertas.md](ofertas.md) | "compare these offers" | Multi-job ranking/comparison |
| [triage.md](triage.md) | "quick score these" | Fast first-pass scoring (cheap filter) |
| [contacto.md](contacto.md) | wants LinkedIn outreach | Find contacts + draft outreach messages |
| [deep.md](deep.md) | "research this company" | Deep company/market research prompt |
| [pdf.md](pdf.md) | "make my CV/PDF" | ATS-optimized tailored CV generation |
| [apply.md](apply.md) | filling an application form | Live application assistant (see also [../apply/README.md](../apply/README.md) for deterministic ATS auto-fill) |
| [scan.md](scan.md) | "find new offers" | Portal scanner / job discovery |
| [pipeline.md](pipeline.md) | "process my inbox" | Work pending URLs from `data/pipeline.md` |
| [batch.md](batch.md) | "batch process these" | Mass parallel job processing |
| [training.md](training.md) | evaluates a course/cert | Training/course evaluation vs goals |
| [project.md](project.md) | evaluates a project idea | Portfolio project evaluation |
| [tracker.md](tracker.md) | "application status?" | Applications tracker overview |
| [weekly.md](weekly.md) | "what should I do now?" / weekly review | Current job-search scoreboard, funnel diagnosis, and next actions |
| [sheets.md](sheets.md) | refresh or sync the career tracker spreadsheet | Export and connector-backed Google Sheets refresh with non-destructive tab rules |

## Context files (read as dependencies, not triggered directly)

| File | Role |
|---|---|
| [_shared.md](_shared.md) | System context: archetypes, scoring logic, framing — read by evaluation modes |
| [_profile.md](_profile.md) | **User Layer.** Personalization: narrative, proof points, negotiation, comp. Write customizations HERE |
| [_profile.template.md](_profile.template.md) | Template copied to `_profile.md` on first run |
| [_brief.md](_brief.md) | Compact context block for first-pass/triage scoring |
| [resume-standard.md](resume-standard.md) | ATS-safe, lane-aware resume quality policy and audit gate |

## Language variants

- **German (DACH):** [de/](de/) — `_shared`, `angebot` (eval), `bewerben` (apply), `pipeline`
- **French:** `fr/` — `_shared`, `offre` (eval), `postuler` (apply), `pipeline`

Use when the user targets that language market or sets `language.modes_dir` in
`config/profile.yml`. English roles at foreign companies → default English modes.
