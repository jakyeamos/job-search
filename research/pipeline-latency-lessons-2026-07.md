# Pipeline Latency — Evaluate-but-Don't-Ship Costs Offers

**Date:** 2026-07-04

## The lesson

Between the April 7–8 batch evaluations and July 4, **the pipeline evaluated 41 roles but shipped zero applications.** When the three top-scored targets were re-verified live on 2026-07-04, two of the three had already closed:

| Role | Score | April status | July 4 re-verification |
|---|---|---|---|
| Replit — SWE New Grad (Summer 2026) | 4.5/5 | Evaluated, never applied | **CLOSED** — "Job not found" |
| Salesforce — AI FDE Early Career | 4.2/5 | Evaluated, never applied | **CLOSED** — listing removed |
| RunPod — SWE Full-Stack | 4.2/5 | Evaluated, never applied | **Re-posted** at new Ashby URL (Greenhouse → Ashby migration); still Remote-USA and live |

**~66% of the highest-fit opportunities decayed to zero solely because of application latency.** The evaluation work was sound; the failure was operational — a filtering machine with no shipping step.

## Why it matters

- New-grad / early-career postings are **especially perishable** — cohort programs fill and close on rolling deadlines, often within weeks.
- A high score is worthless if the window closes before applying. **Time-to-apply is a first-class metric**, not an afterthought.
- ATS migrations (RunPod's Greenhouse→Ashby) silently break stored URLs even when the role is still open — always re-resolve from the company careers page, don't trust a stale link's 404.

## How to apply going forward

1. **Apply within days of a ≥4.0 evaluation, not months.** Treat a high score as a deadline, not a bookmark.
2. **Re-verify freshness before any PDF/application effort** on evals older than ~2–3 weeks (mandatory Playdwright verify per CLAUDE.md).
3. **A 404 on a stored URL ≠ role closed.** Check the company's live careers listing for a re-posted equivalent before discarding.
4. **Cap the evaluation backlog.** Don't batch-evaluate faster than you can act; a smaller queue that gets applied to beats a large queue that rots.

## Related
- Apply-order tracker + live-URL gaps: [pre-ipo-target-list-2026-07.md](pre-ipo-target-list-2026-07.md)
- Tracker entries #1 (Replit) and #10 (Salesforce) marked `Discarded` (offer closed); #27 (RunPod) re-verified live.
</content>
