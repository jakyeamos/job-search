# career-ops — Operations Index

**Read this first, then open ONLY the file(s) it points to.** This is a navigation map,
not content. Hard rules live in [CLAUDE.md](CLAUDE.md) (always loaded); everything else is
read on demand. Goal: right file, first try, minimal tokens.

## Hard rules (never violate — full text in CLAUDE.md)

1. **Never** click Submit/Send/Apply. Fill/draft to submit-ready and stop; the human sends. Discourage applying below 4.0/5.
2. **Verify a posting is live with Playwright** (navigate + snapshot) before evaluating. WebFetch fallback only in headless batch mode (mark `Verification: unconfirmed`).
3. **Personalization → User Layer only** (`modes/_profile.md`, `config/profile.yml`). System updates never touch User Layer. Never put user data in System Layer. See [DATA_CONTRACT.md](DATA_CONTRACT.md).
4. **Never hand-add rows to `data/applications.md`.** Write a TSV to `batch/tracker-additions/`, run `node merge-tracker.mjs`. Update existing entries in place; never duplicate company+role.
5. **Never hardcode CV metrics** — read them from `cv.md` / `article-digest.md` at runtime.
6. **Record durable lessons** in `research/` (see [research/INDEX.md](research/INDEX.md)); personalization in profile files. No valuable lesson dies in one conversation.

## Task → mode  (details & full list: [modes/INDEX.md](modes/INDEX.md))

| User does… | Mode |
|---|---|
| Pastes a JD or URL (default) | `modes/auto-pipeline.md` |
| Evaluate one offer / compare many | `modes/oferta.md` / `modes/ofertas.md` |
| Quick first-pass score | `modes/triage.md` |
| Generate tailored CV/PDF | `modes/pdf.md` |
| Fill an application form | `modes/apply.md` + [apply/README.md](apply/README.md) |
| LinkedIn outreach / deep research | `modes/contacto.md` / `modes/deep.md` |
| Scan portals / process inbox / batch | `modes/scan.md` / `modes/pipeline.md` / `modes/batch.md` |
| Evaluate a course or project | `modes/training.md` / `modes/project.md` |
| Application status | `modes/tracker.md` |

## Canonical sources (read the file — never assume)

| Need | File |
|---|---|
| CV & proof-point metrics | `cv.md`, `article-digest.md` |
| Archetypes / scoring / framing | `modes/_shared.md` |
| User profile & personalization | `config/profile.yml`, `modes/_profile.md` |
| Application PII for auto-fill | `config/application-profile.json` (gitignored) |
| Pipeline data | `data/applications.md`, `data/pipeline.md`, `data/scan-history.tsv` |
| Portal / query config | `portals.yml` |
| Canonical statuses | `templates/states.yml` |
| User vs System layer rules | `DATA_CONTRACT.md` |

## Directory indexes

| Area | Index |
|---|---|
| Modes (evaluation, apply, scan…) | [modes/INDEX.md](modes/INDEX.md) |
| User & setup guides | [docs/INDEX.md](docs/INDEX.md) |
| Research & lessons learned | [research/INDEX.md](research/INDEX.md) |
| Deterministic ATS auto-fill adapters | [apply/README.md](apply/README.md) |

## Key scripts  (`node <script>` — full reference: [docs/SCRIPTS.md](docs/SCRIPTS.md))

| Do | Command |
|---|---|
| Pipeline health check | `node verify-pipeline.mjs` |
| Merge tracker TSV additions | `node merge-tracker.mjs` |
| Normalize statuses / dedup | `node normalize-statuses.mjs` · `node dedup-tracker.mjs` |
| Generate CV PDF | `node generate-pdf.mjs` |
| Scan portals | `node scan.mjs` · `node scan-ats-full.mjs` |
| Civic discovery lane | `node civic-discovery.mjs` · `node civic-discovery.mjs --json` |
| Dismiss a sent X message | `node x-outreach-outbox.mjs mark-sent <draft-id>` |
| Prepare/run a fast 30-role Codex chunk | `node pipeline-fast-runner.mjs --prepare-only` · `node pipeline-fast-runner.mjs` |
| Cache a repeated browser fallback | `node pipeline-liveness-cache.mjs status|record|clear|list` |
| Inspect/sync authenticated Handshake tabs and inbox | `node handshake.mjs doctor` · `node handshake.mjs sync --write` · `node handshake.mjs inbox --write` |
| Auto-fill an application | `node apply/fill-{greenhouse,ashby,lever}.mjs <url> --resume <pdf>` |
| Check / apply / rollback updates | `node update-system.mjs check\|apply\|rollback` |
| Diagnostics | `node doctor.mjs` |
