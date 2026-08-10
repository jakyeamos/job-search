# Mode: discovery-card — Compact Queue Decision

Purpose: turn a fast-pass job description into a concise, evidence-bound decision
record. This is the default output while clearing a large discovery queue. It is
not the full A-G evaluation from `modes/oferta.md`.

## Context budget

Read only:

1. The matching item in `batch/fast-pass/latest.json`
2. `modes/_brief.md`
3. This file

Do not read `cv.md`, `article-digest.md`, `modes/_shared.md`,
`modes/_profile.md`, `config/profile.yml`, `modes/oferta.md`, or
`modes/auto-pipeline.md`. Do not refetch a JD that the manifest already contains.

## Scoring

Use the five dimensions in `modes/triage.md`: archetype fit, compensation,
location, rough CV match, and red-flag adjustment. Honor every deterministic
blocker already recorded in the manifest. Never raise a deterministic SKIP into
a PASS.

Verdicts:

- `PASS`: score >= 4.0
- `MARGINAL`: score 3.8–3.9
- `FAIL`: score < 3.8
- `SKIP`: deterministic blocker, expired role, or unusable JD

Only PASS and MARGINAL roles receive a decision-card report. FAIL, SKIP, and
expired roles receive tracker/pipeline dispositions without a report.

## Report format

Keep the complete report below 350 words:

```markdown
# Discovery: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Score:** {X.X}/5
**URL:** {official URL}
**Verification:** {copy the manifest verification value}
**Evaluation depth:** compact discovery decision card; full A-G evaluation not run
**Resume artifacts:** not generated — create only after the user shortlists this role

## Decision

**{PASS or MARGINAL}** — {one-sentence reason}

## Strongest fit

- {up to three JD-to-brief matches}

## Material risks

- {up to three concrete risks, including missing compensation or verification}

## Next step

{One concrete validation or full-evaluation action. Never apply or send.}
```

## Hard rules

- Use only facts present in the manifest JD and `modes/_brief.md`.
- Do not invent metrics, tools, tenure, compensation, sponsorship, or location.
- Missing information remains explicitly unknown.
- Do not generate HTML, PDF, resume, cover-letter, outreach, or application artifacts.
- Do not submit, fill, send, or apply.
- Browser verification remains mandatory before any application decision.
