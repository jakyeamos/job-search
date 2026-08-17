# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range |
| `config/google-sheets.json` | The user-owned Google Sheet target and tab mapping for tracker sync |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `modes/_brief.md` | Your compact triage brief (regenerated from cv.md/profile.yml/_profile.md, never overwritten by updates) |
| `article-digest.md` | Your proof points from portfolio |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `portals.yml` | Your customized company list |
| `data/applications.md` | Your application tracker |
| `data/search-ops.md` | Your active weekly job-search scoreboard and funnel notes |
| `data/pipeline.md` | Your URL inbox |
| `data/scan-history.tsv` | Your scan history |
| `data/application-policy.json` | Your revocable auto-apply authorization and limits |
| `data/application-question-ledger.json` | Your explicit answers to recurring application questions |
| `data/application-runs.json` | Idempotency and submission outcome audit trail |
| `reports/*` | Your evaluation reports |
| `output/*` | Your generated PDFs |
| `output/lanes/*` | Canonical lane-based resume artifacts selected by `config/profile.yml` |
| `output/application-artifacts/*` | Per-role cover letters and evidence manifests; resumes are referenced from the lane shelf |
| `jds/*` | Your saved job descriptions |
| `research/*` | Your market/company research and lessons-learned docs, indexed by `research/INDEX.md` |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/triage.md` | Fast first-pass triage scoring instructions |
| `modes/oferta.md` | Evaluation mode instructions |
| `modes/pdf.md` | PDF generation instructions |
| `resume-contract.mjs` | Single queue-facing resume request, manifest, and artifact contract |
| `resume.mjs` | Resume plan and artifact-registration commands |
| `apply/application-artifacts.mjs` | Evidence-bound cover-letter generator and canonical lane-resume selector |
| `modes/scan.md` | Portal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/auto-apply.md` | Authorized queue application worker instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/contacto.md` | LinkedIn outreach instructions |
| `modes/email.md` | Formal application email draft instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/ofertas.md` | Comparison instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/weekly.md` | Weekly job-search scoreboard and funnel review |
| `modes/sheets.md` | Google Sheets refresh and non-destructive sync rules |
| `modes/training.md` | Training evaluation instructions |
| `modes/de/*` | German language modes |
| `CLAUDE.md` | Agent instructions |
| `*.mjs` | Utility scripts |
| `sheets-export.mjs` | Builds the non-destructive Career Ops queue and weekly-board export packet |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## Locally-Forked System Files (protected automatically)

Some System Layer files have been locally customized beyond stock upstream career-ops (e.g. the two-pass triage gate in `modes/pipeline.md`/`modes/_shared.md`, or this document's `research/*` row). Blind-replacing these on update would silently destroy that work.

`update-system.mjs` compares the recorded upstream baseline, the current working tree and index, and the incoming upstream commit. Any local deviation is protected automatically: the incoming version is staged at `.update-incoming/<path>` for review while the local bytes and index entry remain untouched.

The local test suite is force-protected as a coupled behavior contract. Upstream test changes are staged for review with the locally customized implementation instead of being mixed into the active suite ahead of that implementation.

While `.update-incoming/` contains pending files, `node update-system.mjs check` returns `review-required` before performing a remote version check. An applied upstream baseline therefore cannot hide unfinished reconciliation.

`.local-overrides.json` is an additional force-protection list, not the only safety boundary. Use it when a path must always require review even if it currently matches the baseline. Invalid protection metadata blocks the update.

Before applying, run `node update-system.mjs preview upstream/main`. A `review-required` result names every locally divergent path whose upstream version will be staged rather than applied.

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a System Layer file matches the recorded upstream baseline in both the working tree and index, the incoming version may be applied.**

**If a System Layer file differs locally, has staged work, or matches `.local-overrides.json`, it is protected — updates stage the upstream copy for review instead of overwriting it.**
