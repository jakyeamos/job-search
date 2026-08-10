# Career Ops Persistent Fast-Queue Worker

Process every item in the supplied fast-pass manifest in this single Codex
session. This is discovery work only. Never submit, fill, send, apply, generate
outreach, or create resume/HTML/PDF artifacts.

## Load only

1. The manifest path supplied in the launch prompt
2. `modes/_brief.md`
3. `modes/triage.md`
4. `modes/discovery-card.md`
5. `templates/states.yml`

Do not load the full CV/evaluation stack during this run. In particular, do not
read `cv.md`, `article-digest.md`, `modes/oferta.md`, `modes/_shared.md`,
`modes/_profile.md`, `config/profile.yml`, or `modes/auto-pipeline.md`.

## Route each manifest item

- `expired`: no report. Write a SKIP tracker addition with score `1.0/5` and
  reason `Fast pass: official ATS board no longer lists this posting`.
- `deterministic_skip`: never override the blocker. No report. Write a SKIP
  tracker addition with score `2.0/5` and the first
  `deterministic.autoSkipBlockers` entry.
- `model_triage`: use the supplied JD; do not refetch it. Score from
  `modes/_brief.md` and `modes/triage.md`.
- `model_fallback`: use Codex-native WebFetch, then WebSearch only if necessary.
  Keep verification unconfirmed. If no usable JD is recovered, record SKIP.

For model scoring:

- PASS (`>= 4.0`) and MARGINAL (`3.8–3.9`): create the compact report defined
  by `modes/discovery-card.md`, then create a tracker addition with status
  `Evaluated`, PDF `❌`, and a note beginning `Discovery card:`.
- FAIL (`< 3.8`) and SKIP: no report; create a tracker addition with status
  `SKIP`, PDF `❌`, report `—`, and a note beginning `Fast triage:`.

## Integrity

1. Check `data/applications.md` and pending tracker additions before writing.
   Never create a duplicate company+role.
2. Reserve report numbers only for PASS/MARGINAL cards with
   `node reserve-report-num.mjs`. Release unused reservations.
3. Every report must include `**URL:**` and the manifest verification text.
4. Update the matching unchecked `data/pipeline.md` row to checked after its
   tracker/report disposition is safely written.
5. After all items, run:

   ```bash
   node merge-tracker.mjs
   node verify-pipeline.mjs
   ```

6. Continue past individual fetch or evaluation failures. Leave a failed row
   unchecked and include it in the final error count.

Do not spawn subagents. The manifest already contains the parallel extraction
results; this one persistent worker should classify and write the entire chunk.
