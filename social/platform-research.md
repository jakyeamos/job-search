# Platform-wide build-in-public research

**Research date:** 2026-07-15
**Scope:** Platform-level patterns for LinkedIn, X, Instagram, native short video,
and owned publishing surfaces. This is not an audit of Jakye's individual accounts
or project URLs.

## Executive read

The strongest repeatable unit is not “a project update.” It is:

> one problem, decision, or constraint -> one visible proof artifact -> one honest
> current-state or next-step note.

That unit can travel across platforms, but the output should be native to the
destination. LinkedIn is the hiring and professional-conversation surface. X is a
compact technical conversation surface where links should support the post rather
than carry it. Instagram is a visual-discovery surface: original Reels can create
discovery, while carousels are better suited to saveable explanations and diagrams.
The portfolio is the canonical proof hub. FRMWRK Labs is the reflective lab note;
it should not be forced into a social cadence.

The current research engine was useful for discovery but returned a small,
general-web sample for this query. The conclusions below therefore weight official
platform documentation and large current benchmark studies more heavily than
generic build-in-public playbooks.

## What the current evidence says

### LinkedIn: concrete first-hand usefulness on a personal profile

- Lead with a clean, keyword-relevant opening that names the problem or decision.
- Keep one post about one idea. A short case study, decision, failure, or demo is
  easier to understand than a project inventory.
- First-hand explanation and real conversation matter more than engagement tricks;
  avoid pods, automated comments, and generic “excited to announce” language.
- Current benchmark data favors carousels and multi-image posts for engagement and
  clicks in many cases, while video is common but not automatically the strongest
  format. Treat this as a format test, not a universal rule.
- Longer articles and structured owned pages help people and AI systems discover
  the deeper version of the work. Social posts should give a reason to continue,
  not just point at a naked homepage.

**Operating rule:** publish one useful idea with a concrete opening, then invite a
real technical response. Measure profile visits, project clicks, recruiter replies,
conversations, referrals, and interviews—not likes alone.

### X: native conversation first, links as support

- X recommendations and search ranking use network relevance plus interaction
  signals such as replies, reposts, quotes, clicks, dwell, and media consumption.
- Current benchmark evidence shows that link posts can be especially weak for
  regular accounts. Put the idea, decision, image, or short demo in the post;
  use a link only when it adds useful context, often in a reply.
- Short technical observations, tradeoffs, “I changed my mind” notes, and compact
  threads are a better fit than resume-like announcements.
- Replies are part of distribution. Build a small habit of responding thoughtfully
  to adjacent builders and hiring-relevant conversations.

**Operating rule:** make the post worth reading before anyone clicks. Record replies,
reposts, profile visits, project clicks, conversations, and recruiter/referral
signals separately from reach.

### Instagram: original visual proof for discovery and saves

- Current benchmark data favors original Reels for discovery and interactions, with
  average watch time making the opening seconds important.
- Carousels remain useful for saveable explanations: architecture diagrams,
  before/after workflow, checklists, “three decisions,” or a compact case study.
- Stories are better for lightweight interaction and replies than for deep project
  explanation.
- Originality matters. Avoid recycled clips, platform watermarks, and generic
  cross-posts that do not make sense in the visual context.
- Instagram is a discovery and visual-proof surface for this system, not the main
  hiring funnel. Use profile actions, saves, shares, watch time, and replies as the
  useful signals.

**Operating rule:** show the working surface early. A Reel should move through
problem -> screen -> one technical point -> honest limitation. A carousel should
teach one thing and end with a question or next step.

### Native short video: show the evidence, not a trailer

Native video is a format shared by LinkedIn, X, and Instagram, but it should be
recorded once and captioned/adapted per destination. The first two seconds should
state the problem or show the relevant surface. A 60–120 second video should spend
most of its time on the working product, CLI, report, or diagram; the technical
point should be singular; the ending should name what is unfinished.

Use captions and a clear first frame. Keep private repositories, credentials,
customer data, and client-sensitive screens out of the approved asset directory.

### Portfolio: canonical proof hub

The portfolio should answer the questions social cannot: what problem was being
solved, what was built, what judgment shaped the design, what is live or private,
and what remains incomplete. Use clear headings, natural-language titles, named
authorship, structured metadata, screenshots with captions/alt text, and transcripts
for demos. Link social posts to a relevant case-study section or artifact, not only
to the homepage.

The portfolio can stay concise and scouting-oriented. Its job is to make a curious
recruiter or hiring manager able to verify the work quickly.

### FRMWRK Labs: a separate reasoning voice

FRMWRK should remain a lab note, not a louder version of LinkedIn. Preserve the
restrained, analytical voice: the question underneath the build, the decision being
tested, the edge that is still unresolved, and the reason a claim is being withheld.
Use longer notes when a project has an actual idea to examine. Do not force every
social atom into a FRMWRK article.

### Product/client surfaces: direct and bounded

Client and product surfaces such as Chiron's Forge can use direct product language:
what the system does, what the user sees, and what the current boundary is. They
should remain supporting proof for the personal identity, not become separate
project accounts. Forward Automations stays professional client-delivery proof;
only approved, anonymized outcomes belong in public content.

## Destination voice matrix

| Destination | Job | Best first line | Native formats | Main measure |
| --- | --- | --- | --- | --- |
| LinkedIn | Hiring discovery and professional conversation | Problem, decision, or lesson | 200–300 word case study, carousel, native demo | Profile visits, project clicks, recruiter replies |
| X | Builder conversation and technical signal | Sharp observation or tradeoff | Short post, reply, compact thread, native clip | Replies, reposts, profile visits, conversations |
| Instagram | Visual discovery and proof | What is on screen and why it matters | Original Reel, saveable carousel, Story question | Watch time, saves, shares, profile actions |
| Portfolio | Verification and conversion | Plain-language project problem | Case study, screenshots, transcript, architecture note | Project clicks, contact actions, interview mentions |
| FRMWRK Labs | Reasoning and durable archive | Question underneath the build | Lab note, technical essay, unresolved edge | Qualified reads, references, conversations |

## BIP Console implications

1. Keep `career-ops` as the evidence registry. The registry should hold claims,
   status, proof artifact, disclosure rules, and destination strategy; it should not
   pretend to know performance before a human publishes and records an outcome.
2. Keep the pipeline as **verified brief -> domain/claim QA -> general humanizer ->
   destination voice -> human approval**. The general humanizer should remove
   robotic metadata labels and filler, but the destination pass should decide shape,
   length, and link behavior.
3. Keep LinkedIn and X manual. Add Instagram as an explicit, manual-only variant
   destination, but do not multiply the default backfill into a full copy of every
   atom. Instagram should be selected for visual-ready items.
4. Rank “publish next” using evidence strength, hiring relevance, visual proof,
   owned-surface availability, readiness risk, and project fatigue. A project with
   more code is not automatically the next story.
5. Record outcomes that connect distribution to hiring: profile visits, project
   clicks, recruiter replies, conversations, referrals, and interviews. Keep reach,
   likes, saves, and watch time as diagnostic signals rather than the end goal.
6. Reuse one canonical article for the portfolio and FRMWRK only when the underlying
   idea deserves both surfaces. Adapt it; do not mechanically duplicate it.

## Sources

- [LinkedIn: maximize AI visibility for posts](https://www.linkedin.com/business/marketing/blog/ai-search/how-to-maximize-ai-visibility-for-your-linkedin-posts)
- [LinkedIn: authentic content and conversations](https://news.linkedin.com/2026/authentic-content-and-conversations)
- [LinkedIn: owned content and AI discovery](https://www.linkedin.com/business/marketing/blog/content-marketing/introducing-a-guide-to-optimizing-your-owned-content-for-ai-discovery)
- [Metricool: 2026 LinkedIn study](https://metricool.com/press-release-linkedin-study-2026/)
- [X: recommendation systems](https://help.x.com/en/rules-and-policies/recommendations)
- [X: search recommendations](https://help.x.com/en/resources/recommender-systems/search-recommendations)
- [Buffer: links on X benchmark](https://buffer.com/resources/links-on-x/)
- [Meta: Instagram creator best practices](https://about.fb.com/news/2024/10/best-practices-education-hub-creators-instagram/amp/)
- [Metricool: 2026 Instagram study](https://metricool.com/press-release-instagram-study-2026/)
- [Instagram recommendation eligibility](https://www.facebook.com/help/instagram/653964212890722)
