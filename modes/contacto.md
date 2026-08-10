# Mode: contacto -- Outreach messages

> Apply `voice-dna.md` (if present) to every generated message — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_shared.md` → Voice DNA.

This mode has two variants that share the same persona engine (recruiter → hard
requirements; hiring manager → impact/vision):

- **Targeted outreach** (default) — find contacts across verified professional
  email, X/Twitter, and LinkedIn, then draft a message tied to a specific
  application/interview. This is the flow below.
- **Greeting** — a single ultra-short first-touch message for platforms with a hard
  character budget (BOSS Zhipin 打招呼, job-board chat, a cold-email opener). No
  contact discovery. See **Greeting variant** at the end of this file.

All generated outreach must run through the shared Humanizer and outreach
quality gate before it is persisted anywhere. The resulting
`outreach-draft-quality-receipt/v1` receipt is bound to the exact final copy;
any later content change invalidates it. Email is also an RDW career artifact:
research the recipient and role, bind the selected candidate proof to `cv.md`,
the profile, or the accomplishment ledger, then obtain an
`rdw-artifact-receipt/v1` receipt before the message can enter the Gmail-draft
path. Passing either gate means ready for human review, never authorized to send.

**Pick the variant:** use **Greeting** when the user says "greeting" / "打招呼" /
"cold opener", names a chat-style platform (e.g. BOSS Zhipin), or asks for a very
short message; otherwise run targeted outreach below.

## Targeted outreach (default)

1. **Identify targets** via WebSearch:
   - Hiring manager of the team
   - Assigned recruiter
   - 2-3 team peers (people with similar roles)
   - Interviewer (if the candidate already has a scheduled interview)
   - If none of those can be verified, any current employee at the company.
     Current employment is the eligibility gate; role relevance is a ranking
     preference, not a reason to discard an otherwise valid contact.

2. **Classify contact type** -- ask the candidate or infer from context:
   - **Recruiter** -- person whose role is talent acquisition, sourcing, or recruiting
   - **Hiring Manager** -- the person who leads the hiring team
   - **Peer** -- someone with a similar role in the team (indirect referral)
   - **Interviewer** -- someone who will interview the candidate (known date)

3. **Select primary target** using this enforced channel hierarchy:
   1. Exact, independently verified professional email
   2. Verified current-employer X/Twitter profile
   3. Verified current-employer LinkedIn profile

   LinkedIn-only contacts are valid fallback candidates, but they must not
   displace an otherwise eligible email or X/Twitter candidate. Within the same
   channel tier, prefer the person who would benefit most from the candidate
   being there. An X bio does not need to name the employer when a separate
   current-employment source binds the exact person to the company and the X
   profile's displayed identity matches that person.

4. **Generate message** with the researched relevance → candidate proof →
   low-friction CTA framework adapted to the contact type. Use
   `domains/career/research-basis.md` from the RDW checkout as the maintained
   source basis; do not present any one template as universally optimal.

   ### Recruiter
   - **Sentence 1 (Fit)**: Direct match criteria -- role, relevant experience, availability, or location
   - **Sentence 2 (Proof)**: Data that answers their screening questions before they ask them (e.g., "5 years building ML pipelines, currently in Berlin, available immediately")
   - **Sentence 3 (CTA)**: "Happy to share my CV if this aligns with what you're looking for"

   ### Hiring Manager
   - **Sentence 1 (Hook)**: Specific challenge their team is facing (extracted from the JD, company blog, or news)
   - **Sentence 2 (Proof)**: Candidate's greatest quantifiable achievement showing they have solved similar problems
   - **Sentence 3 (CTA)**: "Would love to hear how your team is approaching [specific challenge]"

   ### Peer (referral)
   - **Sentence 1 (Interest)**: Genuine reference to their work -- blog post, talk, open-source project, or publication
   - **Sentence 2 (Connection)**: Something the candidate is doing in the same space (NOT a job pitch)
   - **Sentence 3 (CTA)**: "I've been working on similar problems at [company], would love to hear your take on [topic]"
   - **Note**: DO NOT ask for a job. The referral happens naturally if the conversation flows.

   ### Interviewer (pre-interview)
   - **Sentence 1 (Research)**: Reference to something specific from their work or trajectory
   - **Sentence 2 (Context)**: Light connection to the candidate's experience in that area
   - **Sentence 3 (CTA)**: "Looking forward to our conversation on [date]"
   - **Note**: Light tone, not desperate. The goal is to show that you prepared.

   ### Company-adjacent employee (routing fallback)
   - State that the application was submitted.
   - Ask them to point the candidate to the appropriate hiring or engineering
     contact.
   - Do not imply that they work on the role or know the hiring team.

5. **Versions**:
   - EN (default)
   - ES (if Spanish company)

6. **Alternative targets** with justification for why they are good second choices

**Message rules:**
- Maximum 300 characters (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Something that makes them want to respond
- NEVER share phone number
- The contact type changes the EMPHASIS, not the structure
- Recipient relevance must cite public or first-party relationship evidence
- Candidate proof must bind to an existing Career Ops evidence source
- A content change after RDW validation invalidates the receipt
- A content change after Humanizer/quality validation invalidates that receipt
- X copy is persisted to the local X outbox and shown in the UI only after both
  Humanizer and quality stages pass
- LinkedIn copy is shown in the UI only after both stages pass
- Email copy enters `jakyejobs@gmail.com` Drafts only after Humanizer, outreach
  quality, RDW, recipient verification, and application-confirmation gates pass
- Unsent draft creation is not rate-limited; sending remains manual and no
  automatic-send path is enabled

## Career Ops outreach handoff

When this mode is run for an application already marked `Applied`, it may write
public professional contact candidates to the local ignored file
`data/outreach-contacts.json` using the shape below. This is an input manifest
for the outreach processor, not a permission to send. The scheduled processor
also runs its own bounded Firecrawl-backed public discovery pass after an
application signal, so this manifest is a supplement or a correction path, not
a manual prerequisite.

```json
{
  "applications": [
    {
      "applicationKey": "company::rolewithnospaces",
      "contacts": [
        {
          "name": "Public professional name",
          "title": "Engineering Manager",
          "company": "Company",
          "email": "name@company.com",
          "emailVerified": true,
          "publicProfessional": true,
          "sourceType": "company-site",
          "sourceUrl": "https://company.example/team/name",
          "profileUrl": "https://www.linkedin.com/in/name",
          "roleRelevance": "high"
        }
      ]
    }
  ]
}
```

Public company/job/profile sources qualify an email for Gmail draft creation when
the address is employer-domain verified. A first-party professional relationship
from the authorized Gmail mailbox may also qualify when the address is observed
in a Gmail header, the source message ID is retained, and the domain is
professional. Ad-hoc guesses, personal mailboxes, LinkedIn scraping, TeamWork
Online crawling, and contacts whose identity or current employment is uncertain
remain blocked. Role relevance affects ordering, not eligibility. X/Twitter and
LinkedIn output remain manual drafts in the Career Ops UI, with LinkedIn-only
contacts ranked as the weakest fallback. If discovery cannot
identify a specific employer from the application evidence, the record is held
for correction and cannot send.

When `outreach_policy.requireVerifiedPublicEmail: false`, a named convention
hypothesis may also enter the sendable contact list when at least two named
public examples support the same employer-domain convention across distinct
source URLs. It remains marked guessed and unverified, and the UI preserves that
state; it is not promoted to `emailVerified`. With the default `true` setting,
the same hypothesis remains review-only. Discovery still performs a bounded
exact-address Firecrawl query and promotes the hypothesis to verified only when
the exact address and the same named person appear together in public evidence.
Never test a hypothesis by sending mail or probing SMTP. Career Ops creates a
Gmail draft only after application confirmation, verified recipient evidence,
a valid content-bound Humanizer/quality receipt, and a valid content-bound RDW
receipt. The user reviews and sends manually; no receipt or outbox state makes
an unverified hypothesis eligible.

When a named public candidate has no address, discovery may run at most two
exact-name Firecrawl searches for each of the top four candidates, whether the
candidate came from the public company search or a warm-network search. These
are evidence searches, not address generation: only the same person, an exact
employer-domain address, and an allowed public source can be promoted. Data
brokers and blocked job boards never qualify.

---

## Greeting variant

A single, punchy first-touch message for platforms where the opener has a hard
character budget — BOSS Zhipin's 打招呼, job-board chat boxes, or the first line
of a cold email. Reuses the persona engine above; the difference is brevity, and
that there is **no contact discovery**.

1. **Skip target identification.** There is no WebSearch/contact-finding step —
   the message goes to whoever the platform connects you with (usually the poster
   or the recruiter). Do not fabricate a named recipient.

2. **Classify the recipient's persona** from context (default to **Recruiter** if
   unknown) and set the emphasis exactly as above:
   - **Recruiter** → hard requirements met (role, years, stack, location, availability)
   - **Hiring Manager / Founder** → impact and vision (a result that maps to their goal)

3. **Synthesize the top 3 match points** between the JD and `cv.md` (same JD↔profile
   fit logic the LinkedIn flow uses). These are the raw material — you will surface
   only the strongest one or two that fit the budget.

4. **Compose ONE message within the character budget.**
   - **Budget:** read `outreach.greeting_max_chars` from `config/profile.yml`.
     **Default 150** when the key is absent. The message MUST fit — count and trim.
   - **Lead with a specific value proposition** (the single strongest match point),
     not an introduction. Punchy sentences, not paragraphs.
   - **Language:** match the JD / platform language (e.g. Simplified Chinese for
     BOSS Zhipin). Character count applies to the output language.

5. **No-fluff policy (hard):** remove filler and replace it with a concrete value
   prop. Ban phrases like "I'm looking for a job", "I'm passionate about",
   "I hope to have the opportunity", generic self-description. Every clause must
   earn its characters.

6. **Output:** the greeting, its character count vs the budget, and a one-line note
   of which match point(s) it used. Offer a shorter fallback if it's near the limit.

**Greeting rules:**
- Platform-agnostic — never assume LinkedIn; works for any chat/opener surface.
- Within `outreach.greeting_max_chars` (default 150). Never exceed it.
- Same non-fabrication rule as the rest of career-ops: reformulate real experience
  from `cv.md`, never invent a skill, metric, or claim.
- NO corporate-speak, NO "I'm passionate about...", NEVER share a phone number.
- Persona changes the EMPHASIS, not the structure.
