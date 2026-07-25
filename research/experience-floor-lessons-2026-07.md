# Experience-Floor DQs — the dominant SKIP reason

**Last updated:** 2026-07-25
**Status:** Living doc. Update when a new signal proves or breaks the heuristics below.

## The finding

Of **70 SKIP rows** in `data/applications.md`, **at least 21 (~30%)** were killed by a stated
years-of-experience floor, not by domain, location, or comp mismatch. It is the single largest
source of wasted evaluation effort in the pipeline.

Distribution of stated floors across those rows:

| Floor | Count |
|---|---|
| 3+ years | 5 |
| 4–5 years | 6 |
| 5+ years | 6 |
| 6+ years | 2 |
| 8+ years | 2 |

The floors cluster at **3–5 years** — meaning most of these are *not* obviously senior reqs. They
carry non-senior titles ("Software Engineer", "Infrastructure Engineer") and read as approachable
until the requirements section. Title-based filtering does not catch them. Several are explicitly
noted in the tracker as "5 YOE required despite non-senior title."

## Heuristic 1 — a published comp band well above target is a seniority tell

**Confidence: moderate. Sample of 2 — treat as a hypothesis to test, not a rule.**

| Company | Stated base band | Stated floor | Target band |
|---|---|---|---|
| Pylon — Infrastructure Engineer | $180K–$280K | 3+ yrs backend/infra | $120K–$165K TC |
| Amazon (tracked SKIP) | $143.7K–$194.4K | 3+ yrs non-internship FTE + II leveling | $120K–$165K TC |

The reasoning: a company publishing a band whose *floor* exceeds the top of the new-grad target is
pricing for tenure it intends to require. The comp premium and the experience floor are the same
fact stated twice.

**Practical use:** when a JD publishes a base floor above ~$170K for an IC engineering role, read
the requirements section for a YOE floor *before* investing in a full A–G evaluation. High comp is
a warning in this pipeline, not a draw.

**How this could be wrong:** SF/NYC-weighted new-grad bands at top-of-market AI labs can legitimately
clear $170K without a tenure floor. Location-adjust before applying the heuristic, and do not let it
override a JD that explicitly says "new grad" or "university."

## Heuristic 2 — strength on secondary JD bullets does not offset a tenure floor

Pylon (2026-07-25) is the clean case. The JD's six responsibility bullets split cleanly:

- Bullets 1–3 (own core cloud infra; prevent incidents; make systems scale) → thin evidence
- Bullets 4 and 6 (developer velocity / CI-CD / internal tooling; AI-first workflow with agents) → **exceeds bar**

The tooling and AI-leverage evidence (Quality Runner, Pre-CR Suite, AIOS, Terrace, TMCP) is genuinely
strong and maps to the JD's own language. It changes nothing, because the req asks for *years of
infrastructure operating experience*, not seniority signals. Leading with tooling strength against
an infra-ownership req produces a confident answer to a question nobody asked.

**Rule:** when the evidence base is strong on a JD's secondary bullets and thin on its primary ones,
that is a mismatch finding — not a framing problem to solve.

## Heuristic 3 — the company is usually fine; the requisition is wrong

Experience-floor DQs are req-level, not company-level. Pylon scored 4.5 on cultural signals and is a
strong target overall; it was the *Infrastructure Engineer* req that hard-DQ'd. Pylon was already
tracked at **#003** (New Grad SWE, 3.9/5) and has concurrent **SWE — AI Agents** and **SWE — AI Infra**
openings.

**Rule:** on an experience-floor SKIP, do not discard the company. Scan its board for an IC1 or
new-grad req in the same lane and record the redirect in the tracker note. Several tracker rows
already do this well ("redirect to early-career OpenAI roles", "Pivot to SDE I + warm Amazon
outreach") — make it standard.

## Scanner implication (not yet implemented)

`scan-calibration-lessons-2026-07.md` covers title/geo/sector filtering. Experience floors are the
gap it does not close, because the floor lives in the JD body rather than the title. Two candidate
changes, both unbuilt:

1. Regex the fetched description for `\b([3-9]|1[0-9])\+?\s*(-\s*\d+)?\s*(years|yrs|YOE)\b` during
   enrichment and downscore or auto-archive on a match ≥3.
2. Parse published comp bands where available and flag base floors above ~$170K for manual review.

Item 1 is the higher-value one — it addresses ~30% of wasted evals directly and does not depend on
comp being published (most reqs do not publish it).

## Related

- `scan-calibration-lessons-2026-07.md` — the filtering layers that run *before* this one
- `pipeline-latency-lessons-2026-07.md` — the opposite failure: good-fit reqs lost to delay
- `modes/_profile.md` → "Your Scoring Rules" — where the ≥3-year Hard DQ rule is defined
