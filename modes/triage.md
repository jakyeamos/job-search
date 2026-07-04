# Mode: triage -- Fast First-Pass Scoring

Purpose: cheaply filter a batch of job URLs down to the ones worth a full A-G evaluation (`modes/oferta.md`). Optimized for token cost, not depth. Designed to be run as one parallel agent per URL from `modes/pipeline.md`.

## Context Budget (IMPORTANT)

Read **ONLY** `modes/_brief.md`. Do NOT read `cv.md`, `modes/_shared.md`, `modes/_profile.md`, `config/profile.yml`, or `modes/oferta.md` during triage -- that full context (~26K tokens) is reserved for the full evaluation pass. A triage pass should cost roughly 15K tokens total (brief + JD fetch + reasoning), not the ~65K a full A-G evaluation costs.

## Steps

### 1. Fetch the JD

WebFetch the URL. If WebFetch fails or returns no usable JD content (common on SPA-heavy portals), fall back to WebSearch for the role + company. If neither works, stop and output verdict `SKIP` with reason "JD unreachable".

Do NOT use Playwright for triage -- it's too expensive for a first pass and reserved for full-evaluation verification (see `CLAUDE.md` Offer Verification rules).

### 2. Score 5 dimensions against `modes/_brief.md`

| Dimension | Weight | What to check |
|---|---|---|
| Archetype fit | 30% | Does the role match one of the 6 core archetypes or the analog in the brief? |
| Comp | 25% | Base salary vs the target range/floor in the brief's Comp Strategy |
| Location | 25% | Per the Location Scoring table in the brief |
| CV match | 15% | Rough stack/experience overlap -- yes/no per major requirement, no line-by-line mapping |
| Red flag adjustment | up to -1.5 | Apply Hard DQ (cap score at 2.0) or Soft Red Flags (subtract 0.2-0.5 each) from the brief |

### 3. Compute and clamp

Weighted score of the first 4 dimensions, then apply the red flag adjustment. Clamp to `[1.0, 5.0]`.

### 4. Map to verdict

| Score | Verdict |
|---|---|
| >= 4.0 | **PASS** |
| 3.8 - 3.9 | **MARGINAL** |
| < 3.8 | **FAIL** |
| JD unreachable, or a Hard DQ fires | **SKIP** -- don't bother computing a precise score, cap at 2.0 and report |

## Output (MAX 500 tokens)

Return exactly one line, no markdown table, no headers, no bullet analysis:

```
TRIAGE | {company} | {role} | {score}/5 | {verdict} | {reason in <15 words}
```

Pick the single deciding factor for the reason field -- don't summarize all 5 dimensions.

## Hard Rules

- **Write ZERO files.** No reports, no TSV tracker additions, no cover letters, no PDFs. Triage reads `modes/_brief.md` plus one JD fetch and nothing else.
- Do not register anything in `data/applications.md`. Tracker registration happens only after a full evaluation (`modes/oferta.md`), or when `modes/pipeline.md` logs a batch FAIL/SKIP summary line itself after collecting triage results.
- If run as a parallel Agent (see `modes/pipeline.md`), return the `TRIAGE | ...` line as your final message -- the orchestrator collects these into a summary table.
