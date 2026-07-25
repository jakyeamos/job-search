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

## Scanner implication — built 2026-07-25

`scan-calibration-lessons-2026-07.md` covers title/geo/sector filtering. Experience floors are the
gap it does not close, because the floor lives in the JD body rather than the title. This is now
closed by `experience-floor.mjs`, called from `scoreCandidate()` in `queue-lib.mjs`.

The naive version proposed here — regex `\b([3-9]|1[0-9])\+?\s*(-\s*\d+)?\s*(years|yrs|YOE)\b` and
DQ on any match ≥3 — is what shipped originally and it was **wrong twice over**:

- **Context-blind.** It fired on benefits prose ("25 days after five years of service"), vesting
  schedules, ROI copy ("payback in one to three years"), company history, four-year degrees, and
  descriptions of the *colleagues* you'd work with. Measured against the live queue, 116 of its 131
  hits were either not hiring bars at all or floors low enough to be harmless.
- **Structurally blind to the worst cases.** A `[3-9]` character class cannot see a 10+ year floor.
  Four genuinely senior reqs (Slack/Salesforce Staff SWE at 10, Sundayy at 12, Reserv at 10) sailed
  through the filter it was supposed to be.

What replaced it:

- Match `3+ / 3-5 / 1 to 3 / three` year quantities, then require an experience anchor nearby
  (experience, background, expertise, track record, professional, industry, career) and reject on
  negative context (vesting, accrual, PTO, tuition, ROI, company history, degree length, peers).
- Clip every context window to its sentence, or preference cues and negatives leak across
  boundaries — this was the source of two separate bugs during implementation.
- Required floors shadow preferred ones entirely. Across separate bullets the **highest** floor
  binds (requirement bullets are conjunctive — UiPath asking `5+ yrs Java` *and* `1+ yrs B2B` has a
  bar of 5, not 1); within a single range the **low end** binds (`1–4 years` admits a 1-yr
  candidate).
- Response is graduated, not binary: ≤2 free, 3 costs 0.5, 4–5 costs 1.2 and blocks only when the
  role's substance also misses, ≥6 is a hard DQ. See `modes/_profile.md` → "Your Scoring Rules".

Live-queue effect: 1,282 items, 168 carrying a real required floor (≤2: 62, 3: 48, 4–5: 39, ≥6: 19).
Hard DQs drop from 131 to 19.

Still unbuilt: parsing published comp bands and flagging base floors above ~$170K for manual review
(Heuristic 1). Lower value — most reqs do not publish comp.

## Related

- `scan-calibration-lessons-2026-07.md` — the filtering layers that run *before* this one
- `pipeline-latency-lessons-2026-07.md` — the opposite failure: good-fit reqs lost to delay
- `modes/_profile.md` → "Your Scoring Rules" — the graduated floor policy
- `experience-floor.mjs` / `tests/experience-floor.test.mjs` — the implementation and its cases
