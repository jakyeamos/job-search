# Resume Standard — Career Ops policy

This is the adapted version of the 2026 Resume Standard supplied for Jakye
Amos. It is a quality policy for resume generation, not a replacement for the
candidate evidence files or the application queue.

## Source of truth

Before drafting a resume, read:

1. `cv.md` — canonical resume facts and current experience.
2. `article-digest.md` — detailed proof, metrics, and confirmation status.
3. `config/profile.yml` — target roles, lane matrix, location policy, and
   deal-breakers.
4. `modes/_profile.md` — candidate-specific framing and disclosure rules.
5. The job description and its live posting status.

Never fill an evidence gap with a plausible metric, customer, technology,
certification, or outcome. A claim marked as needing confirmation is not ready
for a resume.

## Resume tiers

Career Ops is optimized for an early-career candidate with substantial project
and client-delivery evidence:

- **Standard:** one page. This is the default for new-grad, early-career, SWE,
  backend, data, platform, and most product applications.
- **Evidence master:** up to two pages. Use when the role genuinely benefits
  from the additional applied-AI, client-delivery, data, or product context.
  It is a source document for tailoring, not the default upload.

Do not use senior/director length rules or imply seniority that the evidence does
not support.

## Document structure

- Use a single readable flow. No sidebars, text boxes, multi-column resume
  sections, icons, photos, skill meters, or image-based text.
- Put name, email, phone when appropriate, location, and key links in the
  document body near the top.
- Prefer these machine-readable headings: `Professional Summary`, `Work
  Experience`, `Projects`, `Education`, and `Skills`. `Core Competencies` and
  `Certifications` are optional when they add signal.
- Keep the document selectable and text-native. The existing HTML/Playwright
  renderer is the canonical PDF path.
- Use verified dates. Prefer `Month YYYY` when the source evidence provides the
  month; never invent a month just to satisfy formatting.

The visual template may use flex layout for contact rows or competency tags.
That is acceptable as long as the resume content remains one linear reading
order and does not put experience into parallel columns.

## Content rules

The top third should make three things obvious: the target lane, the strongest
credibility anchor, and the kind of systems the candidate ships.

- Write a short, role-specific summary that connects the job to verified proof.
- Mirror a target title or keyword only when it describes the work honestly. Do
  not rename an actual job or project to manufacture seniority.
- Put relevant technologies inside achievement bullets when they clarify the
  system or outcome. Do not force a tool into every sentence.
- Use exact, speakable metrics and vary bullet length and structure. Avoid
  stacked power verbs, generic claims, keyword stuffing, and AI-sounding filler.
- Expand an acronym on first use when the audience may not know it; use the
  job description's literal term afterward when truthful.
- Keep the standalone Skills section compact and secondary to evidence.
- Do not add a repeated `Key Skills Applied` line to every role. Use the summary,
  bullets, project descriptions, and compact Skills section to carry keywords.

## Lane and project selection

Choose one lane before drafting. Use the lane matrix in `config/profile.yml` and
the adaptive framing in `modes/_profile.md`; do not present every project on
every resume.

The default backend / AI / platform packet is:

1. Tenure
2. BidCamp
3. Quality Runner

Swap projects for developer-tools, applied-AI/client, full-stack/product,
data/analytics, or solutions roles according to the configured matrix. The
project block is evidence selection, not a popularity ranking.

## Candidate-specific guardrails

- Keep Forward Automations under professional experience as **CTO**.
- Leave Amazon bullets unchanged until the candidate supplies the updated
  versions.
- Describe Tenure as a LaunchNY cohort venture and pilot-ready product. Do not
  claim customers, revenue, or completed pilots without confirmation.
- Keep BidCamp as live and closed beta; Hoopscout as private beta.
- Describe CrimClock as legal-time intelligence, not legal advice.
- Describe RemodelVision as a working but incomplete product pipeline.
- Do not claim Salesforce certification, Snowflake, named AWS services, or
  other job requirements unless they appear in the evidence base.
- Resume education may state Spring 2027 completion and immediate availability;
  LinkedIn-facing copy follows its separate rule and omits graduation timing.

## Quality gate

Before a resume is approved for upload:

1. Confirm the target lane and tier.
2. Confirm every metric, technology, customer-facing statement, and status in
   the evidence files.
3. Check that the top third answers target role, strongest fit, and availability
   without overexplaining.
4. Run the source/HTML/PDF audit:

   ```sh
   node resume-audit.mjs --cv cv.md --html output/cv-<candidate>-<company>.html --pdf output/cv-<candidate>-<company>.pdf
   ```

5. Inspect the rendered page count, spacing, links, and extracted text.
6. Human-review the final PDF before the application is marked ready or
   submitted. Career Ops never submits the application automatically.
