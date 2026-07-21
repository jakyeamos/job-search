# AI Platform Engineer — Application Answers (Jakye Amos)

Final, humanized answers. Paste-ready.

---

## 1. Configuring and deploying an AI agent on a managed platform

Most of my agent work runs on the Anthropic Claude API, with Gemini as a second model when I want a cross-check. The clearest example is Tenure, a LaunchNY-backed platform I built that turns recorded interviews with specialists into reviewed SOPs, a permissioned company wiki, and cited Q&A.

The pipeline works like this: transcribe an interview, run a Claude extraction agent to pull out the actual steps and facts, embed everything with VoyageAI, then answer questions through hybrid vector and full-text retrieval over Postgres. Every answer is tied back to a source span, and nothing publishes without a human reviewing it first.

The hard part wasn't the happy path, it was making the agent trustworthy and affordable. Extraction gave me different results run to run, so I stopped writing prompts as loose paragraphs and started making the agent return a typed, validated shape (Pydantic). That work became my open-source package, agent-eval-contract. I wrote promptfoo eval suites for the extraction and retrieval steps, and I put OpenTelemetry and Arize tracing in front of the whole thing so I could see what was actually happening in production. On cost, I cached and batched the steps that didn't need full context and saved the bigger model for the reasoning that did.

What I ended up with is a pilot-ready pipeline where the agent's output is typed, tested, observable, cited, and gated behind a person.

---

## 2. An AI system that didn't behave as expected in production

In Tenure's extraction step, Claude would sometimes produce SOP steps that read as authoritative but weren't actually in the transcript. It was inventing steps, or merging two things the person said into one instruction that they never gave. The output looked clean, which is exactly what made it dangerous.

I caught it because of the human review gate at the end of the pipeline. A reviewer flagged extracted steps that didn't match the recording. That was reassuring and worrying at the same time. Good that it got caught, but the only thing standing between a hallucinated step and a published SOP was a person spotting it by hand every single time. That's not a control I wanted to rely on.

So I made grounding a hard requirement instead of a hope. Every extracted claim now has to cite a specific span of the transcript, and if it can't ground itself, I reject it. I took the exact example that failed and turned it into a permanent promptfoo test case, so any change to the prompt or the model gets checked against it before it ships. The tracing helped me see which kinds of inputs tended to trigger the shaky extractions.

The bigger shift was in how I think. I stopped treating model output as fact and started treating it as a proposal that has to prove itself. Cite your source, pass the evals, and keep a human in the loop for anything that gets published. That's baked into most of what I build now.

---

## 3. Prompt design and agent behavior configuration: I'd say a 4 out of 5

I'll give myself a 4. I've shipped several LLM and agent systems where getting the prompt and the agent's behavior right was the actual work, and I've built tooling around that problem. I'm not going to claim a 5, because my depth is on Claude and Gemini, and I haven't done the same hands-on work across Bedrock or Snowflake Cortex yet.

The thing that earns the 4 is that I stopped treating prompts as prose I nudge until they feel right, and started treating agent behavior as something I specify and test. I define the output schema, write the prompt against it, and run it through promptfoo so I know a change didn't quietly break something that used to work. I cared about this enough to publish it as a package, agent-eval-contract, which is basically a way to pin down cases, rubrics, and evidence for agent runs.

A concrete one: in Chiron's Forge, a live product of mine, I set up a workflow where a few models research and synthesize an answer, and then a separate model judges those outputs against a rubric before a final refinement pass. Designing that judge is the interesting problem. You have to define what a good answer even is and keep the judge from just rubber-stamping whatever it's handed. That's the prompt and agent-configuration muscle I'd bring to your team. I'm a 4 because I do this on purpose and can show the receipts. I get to 5 when I've done it across more platforms.

---

## 4. Data privacy and security, and a privacy-by-design decision

My clearest example is EliHealth, a mobile health and recovery product I built. Health data is about as sensitive as it gets, so I set the boundaries before I wrote the features, not after.

Two decisions stand out. The first was drawing a hard non-diagnostic line through the entire product. The app captures and organizes health and recovery data and lab imports, but it never infers a diagnosis or presents model output as a medical fact, and that limit shows up everywhere a user might otherwise misread what they're looking at. That meant deliberately not building something that would have been easy and tempting, because it wasn't safe to build.

The second was keeping the data on a short leash technically: authenticated capture, Row-Level Security so a person's data is isolated at the database layer instead of trusting the app code to behave, and a human verification step for imported lab data rather than auto-trusting the integration.

The same rule runs through all my AI work. The model doesn't get to be the final authority over sensitive or user-facing output. In Tenure and BidCamp that looks like Row-Level Security for tenant isolation plus a human review gate. In EliHealth it looks like a non-diagnostic boundary plus verification. I'd rather design the constraint in on day one than try to add privacy back after something has already leaked.

---

## 5. Explaining an AI system, and its limits, to a non-technical stakeholder

The one I go back to is presenting Tenure to my LaunchNY cohort: mentors, operators, and investors who are sharp people but not AI engineers. They didn't want to hear about embeddings or retrieval. They wanted to know whether the thing could be trusted with a company's actual knowledge.

So I explained it in their terms. I described Tenure as capturing what a company's most experienced people know and turning it into reviewed procedures other employees can rely on. Then I was upfront about the limit: the AI writes a first draft, but a person reviews every SOP before it becomes official, because the model can get a detail wrong or state something too confidently. Instead of asking them to take that on faith, I showed a real extraction that was good next to one that needed correcting. Seeing the weak one did more for their confidence than any promise about accuracy would have.

The outcome was that they stopped thinking of it as a magic answer box and started seeing it for what it is, which is a way to capture expert knowledge fast with a human check built in. That framing is a big part of why it moved forward in the cohort. What I took from it is that with a non-technical audience, calibrating how much to trust the system matters more than explaining how it works.

---

## 6. Staying current with the AI platform landscape

I stay current by building on new things early instead of just reading about them. I follow Anthropic's and Google's releases directly, and when a new protocol or primitive shows up, I test it by shipping something real with it. I keep seven published packages across PyPI, npm, and the MCP ecosystem, several built on the Model Context Protocol within a few months of it stabilizing. I also run a fairly heavy personal AI coding setup, so I have a real stake in where this is going.

The thing that recently shifted my thinking started with a statistic. I read that only about 2% of US households pay for an AI subscription. My first reaction was that I'm way out on the tail of adoption. My second reaction was more useful: access is the least durable advantage I have. Whatever premium model I'm paying for today, a new user gets something comparable for free in a year or two.

So I started thinking about my advantage in layers. Raw access is the bottom and it decays fast. Technique, meaning prompting and knowing which model to reach for, is a little stickier. The durable layers are the systems and the assets: the evaluation suites, the context pipelines, the routing between cheap and frontier models, the CI gates, and the proprietary data and products those produce. New users inherit the models. They don't inherit your eval suite or your accumulated context.

That reframed how I measure myself. Instead of tracking tokens, I care about the longest, messiest task my setup can finish reliably at an acceptable cost with little intervention, and how to keep stretching that horizon without letting quality slip. It's also why my recent work leans so hard on tooling: agent-eval-contract, Quality Runner, promptfoo suites, Arize tracing, and routing policies that don't send every task to the most expensive model. The interesting problem in agent systems isn't getting one good answer. It's building the harness that keeps answers good as the models, the prompts, and the inputs all keep changing, and turning cheap intelligence into reliable systems other people can't easily copy. I'd rather compound that than bet on any single model staying ahead.
