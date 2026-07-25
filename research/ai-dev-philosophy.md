# AI-Assisted Development Philosophy (Jakye)

Evergreen. Jakye's own framing for how he works with coding agents. Use this when
drafting "how do you use AI / how has AI changed your work" answers, when positioning
the tooling projects (TMCP, Quality Runner, Pre-CR), and when calibrating what these
projects are *for* in evaluations. This is who he is, stated in his words.

## The core thesis: build a high quality floor

The most important thing in AI-assisted development right now is a **high, guaranteed
quality floor**. No matter which agent or model produced the code, Jakye wants to be
confident it is "at least this good" before he ever looks at it.

- **He built his own gates to be that floor** (Quality Runner, Pre-CR, Terrace's
  deterministic ship-gates). They are not incidental side projects — they are the
  mechanism that makes agent productivity safe to accept: infrastructure for trusting
  output he did not hand-write.
- The floor is the priority *because* agent throughput is high. Speed without a floor
  is a liability; the floor is what converts speed into confidence.
- **In answers, do not name-drop the tools** — a recruiter does not know them and the
  names add nothing. Say "I built my own checks and gates." The signal is that he built
  tooling *with the floor as the explicit goal*, not the product names.
- **TMCP is a ceiling-raiser, not a floor tool.** It is skill-packet/workflow
  orchestration (raising output quality), not a gate every change must clear. Keep it
  out of the floor list.

Compare Uncle Bob Martin's framing (the tweet that prompted this): "surround the agents
with extreme constraints... they've had to run the gauntlet." Same instinct — Jakye's
version is his own published gauntlet.

## The trust boundary has moved: decisions, not code quality

Frontier models can now produce quality *code*. What they **cannot be trusted with yet
is consistently making the right decisions** — the branching choices, the assumptions,
the "which approach" calls made mid-run.

- So the floor tools handle code quality (the ceiling-work of correctness, coverage,
  standards), and Jakye's own judgment moves **up the stack to the decisions**.

## The workflow shift: review decisions, not diffs

Because the risk is in decisions rather than syntax, his review changed:

- **Old:** read the commit diff line by line.
- **Now:** ask the agent *what branching decisions it made during the run.*
- Misconceptions and wrong turns are far easier to spot in the decision narrative than
  buried in a finished diff. "A lot of the time you can very easily see where mistakes
  or misconceptions could be harbored."

## How to use this in answers / positioning

- "How has AI changed your work" → lead with floor-building + review-decisions-not-diffs.
  Canonical answer lives in `config/profile.yml` → `application_answers.ai_impact_on_work`.
- Positioning the tooling projects → frame the quality gates (Quality Runner, Pre-CR,
  Terrace ship-gates) as *the floor*, not as generic dev tools. That framing is on-thesis
  for engineering-intelligence / LLMOps / dev-tooling employers (e.g. Faros AI, report
  #049). TMCP belongs in a ceiling / output-quality story, not the floor story.
- Interviews → this is a strong, differentiated point of view. It shows he has a
  *system* for trusting agent output, not just tool familiarity.

## Sources

- Jakye, 2026-07-24 (conversation): the floor thesis, the decisions-vs-code trust
  boundary, and the review-the-branching-decisions workflow.
- Prompt: Uncle Bob Martin tweet on surrounding agents with extreme constraints.
- Evidence projects: `/Users/jakyeamos/projects/tmcp`, `.../quality-runner`,
  `.../pre-cr-suite-lsp`.
