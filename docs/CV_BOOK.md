# Comprehensive CV Book

The Comprehensive CV Book is a separate, evidence-backed public reading layer.
The ATS/full CV remains `cv.md`; `article-digest.md`, the accomplishment ledger,
email, Drive, and dated reports remain source systems and are not rewritten by
this workflow.

## Source layer

The user-owned source layer lives under `data/cv-book/`:

- `entries.yml` contains normalized work, project, research, education,
  leadership, writing, and tooling entries.
- `sources.yml` records provenance and evidence references without copying
  private email or Drive contents.
- `exclusions.yml` records explicit holds, including GCC and CSDS 312 GNU/GCC.
- `public-projection.json` is the reviewed, public-safe projection consumed by
  the website and PDF.

Entry IDs are stable. Dates use `YYYY-MM` internally and are rendered as
human-readable labels. Every entry carries evidence, confidence, visibility,
and review state. Research entries may leave role, contributions, and outcomes
unset while confirmation is pending.

The August 2026 research records for Roger French/SDLE and Professor Datta are
intentionally minimal and public. Roger is identified as leading the research;
both roles and deliverables remain pending. Datta confirmation is still
blocked by Gmail's `Token has been expired or revoked` response, and no private
message, address, credential, or Drive identifier is stored here.

## Refresh, review, and apply

```bash
pnpm cv:book:refresh -- --source-root /path/to/career-ops --root /path/to/projects --root /path/to/Documents
pnpm cv:book:refresh -- --check
pnpm cv:book:validate -- --projection data/cv-book/public-projection.json
pnpm cv:book:apply -- --review-file /path/to/review.json
pnpm cv:book:pdf -- --projection data/cv-book/public-projection.json --output output/cv-book.pdf
```

Refresh is report-only by default. It scans the current CV and digest, resume
and CV artifacts, dated reports, repository evidence, and approved source notes.
It reports candidate additions, conflicts, stale references, recurring report
evidence, and missing confirmation. Report content is summarized as evidence
metadata; raw job-evaluation archives are never copied into the source layer or
public projection.

Apply requires an explicit reviewed decision file bound to the exact refresh
source hash. It may update only the CV-book source/projection and refresh
artifacts. It cannot modify `cv.md`, `article-digest.md`, the accomplishment
ledger, email, Drive, or raw reports.

Evidence precedence is user-confirmed facts and current public artifacts first,
current CV/digest next, and older resumes, Drive, and email as corroboration.
Unresolved conflicts remain in the review queue. Unreviewed current CV/digest
items can appear publicly only as title-only pending entries; unsupported
metrics and accomplishment claims are rejected.

## Public projection and PDF

The website and downloadable PDF must consume the same approved
`public-projection.json`. `cv-book.mjs pdf` writes a manifest containing the
projection hash and PDF byte hash. The website imports the projection and
publishes the same projection hash in its footer and PDF link surface.

The public boundary rejects private email addresses, Drive IDs, raw report
paths, held entries, and metrics without evidence. Explicit GCC holds remain in
the internal exclusion layer and do not appear in the public projection.

## Verification contract

The focused CV-book tests cover schema and evidence references, stable dates and
IDs, report/resume read-only scanning, privacy and held-entry rejection,
unsupported-metric rejection, deterministic refreshes, and the reviewed apply
gate. Website checks cover the `/cv-book` route, anchors, search/filtering,
responsive layout, print styles, and projection-hash parity with the PDF.
