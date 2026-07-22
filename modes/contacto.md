# Mode: contacto -- Outreach messages

> Apply `voice-dna.md` (if present) to every generated message — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_shared.md` → Voice DNA.

This mode has two variants that share the same persona engine (recruiter → hard
requirements; hiring manager → impact/vision):

- **LinkedIn power move** (default) — find contacts and draft a ≤300-char message
  tied to a specific application/interview. This is the flow below.
- **Greeting** — a single ultra-short first-touch message for platforms with a hard
  character budget (BOSS Zhipin 打招呼, job-board chat, a cold-email opener). No
  contact discovery. See **Greeting variant** at the end of this file.

**Pick the variant:** use **Greeting** when the user says "greeting" / "打招呼" /
"cold opener", names a chat-style platform (e.g. BOSS Zhipin), or asks for a very
short message; otherwise run the LinkedIn power move below.

## LinkedIn power move (default)

1. **Identify targets** via WebSearch:
   - Hiring manager of the team
   - Assigned recruiter
   - 2-3 team peers (people with similar roles)
   - Interviewer (if the candidate already has a scheduled interview)

2. **Classify contact type** -- ask the candidate or infer from context:
   - **Recruiter** -- person whose role is talent acquisition, sourcing, or recruiting
   - **Hiring Manager** -- the person who leads the hiring team
   - **Peer** -- someone with a similar role in the team (indirect referral)
   - **Interviewer** -- someone who will interview the candidate (known date)

3. **Select primary target**: the person who would benefit most from the candidate being there

4. **Generate message** with a 3-sentence framework adapted to the contact type:

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

Public company/job/profile sources qualify an email for automatic sending when
the address is employer-domain verified. A first-party professional relationship
from the authorized Gmail mailbox may also qualify when the address is observed
in a Gmail header, the source message ID is retained, and the domain is
professional. Never guess an address, use a personal mailbox, scrape LinkedIn,
crawl TeamWork Online, or include a contact whose identity or role relevance is
uncertain. LinkedIn output remains a manual draft. If discovery cannot identify
a specific employer from the application evidence, the record is held for
correction and cannot send.

The processor may show a review-only email hypothesis when at least two named
public examples support one employer-domain convention across distinct source
URLs. A hypothesis is not a verified email: it remains marked guessed and
unverified, is not placed in the sendable contact list, and must be checked
against exact public evidence or a first-party Gmail header before anyone may
add it as a contact. Discovery performs a bounded exact-address Firecrawl query
for each hypothesis and promotes it only when the exact address and the same
named person appear together in public evidence. Never test a hypothesis by
sending mail or probing SMTP.

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
