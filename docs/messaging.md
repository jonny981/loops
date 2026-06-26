# Messaging

Source material for the public docs site. Persuasive points for loops, each with the
psychological lever it pulls and the *grounded* proof behind it. Rule: no hype. Every claim
traces to something real (`measured-metrics.md`, `competitive-landscape.md`, the code). The
honesty is the brand: never headline a number the measurement has not earned at
significance, which is exactly the failure mode this doc exists to avoid.

## The core narrative (one paragraph)

loops runs AI agents until the work is *actually* done: fresh context, an honest gate, and
git as the memory, composed into nestable loops that scale from one agent to a whole
engineering team. It is not a memory product and not conversational recall. It is task
completion that compounds, and it is the architecture the field's leaders independently
arrived at.

## The persuasive points

### 1. "You're not early. You're right." (the strongest point)
**Hook:** *We didn't invent this. We arrived where the field's best independently landed.*
**Levers:** Authority bias + Social proof + the Lindy effect (an idea that keeps getting
reinvented is a true idea).
**Proof:** GCC's git-context ablation is **+13.0pp on SWE-bench Verified, N=500** (67.2% →
80.2%). Letta, the company that coined "agent memory," pivoted to **git-backed memory** in
2026. Google's ReasoningBank reports **+34% relative** on agentic tasks. Three serious,
independent efforts converged on git-as-memory and convergence-with-gates. Convergent
evolution is the most reliable signal in early-stage tech.
**Where it lives:** homepage hero subtext; a "why git" essay; the launch post.

### 2. "Not conversational recall. Task completion that compounds."
**Hook:** *Memory benchmarks ask if your agent remembers a chat. We ask if it finishes the
job, and finishes the next one faster because it remembers the last.*
**Levers:** Jobs-to-be-Done + Category design (rename the category) + Contrast.
**Proof:** The recognized memory benchmarks (LoCoMo, LongMemEval, DMR) all measure
conversational recall; the most-cited (LoCoMo) has a ~6.4% corrupt answer key and is beaten
by a no-memory full-context baseline. loops competes on the *agentic* axis, where no
recognized benchmark even exists yet.
**Where it lives:** the positioning page; comparison pages.

### 3. "No vector database. Git is the index."
**Hook:** *No embeddings. No index to build, sync, or let go stale. The memory is the
commit log, and it can't drift from the code because it is the code's history.*
**Levers:** Occam's razor + Contrast effect (one line vs a vector-DB + embedding-model +
sync + staleness stack) + Loss aversion (no infra to stand up or maintain).
**Proof:** Structurally true and verified across the field, every memory competitor (Mem0,
Letta, Zep, cognee) requires an embedder and a vector or graph store, most a running
server. None is git-native at the level of "the work's own history is the memory."
**Where it lives:** homepage; the "why git" essay; comparison pages.

### 4. "We don't ask the model if it's done. We check."
**Hook:** *An honest gate: the tests really pass, and an independent judge agrees, hardened
by a jury vote. And we'll tell you straight when memory is just a tax.*
**Levers:** First principles + the Pratfall effect (admitting a flaw makes the rest
credible) + Authority (honest measurement).
**Proof:** The gate combines a deterministic signal with a separate judge, a k-of-n quorum,
and dimensional scoring, fail-closed. And `measured-metrics.md` openly reports the ceilings
where memory is only a token tax, and refuses to headline a resolve-rate number that is not
statistically significant. The honesty is the differentiator.
**Where it lives:** the "how convergence works" page; the trust/honesty section.

### 5. "With memory, the next attempt builds. Without it, it thrashes."
**Hook:** *Memory is what makes a loop converge instead of going in circles.*
**Levers:** Contrast + a clean, measured mechanism.
**Proof:** Measured convergence direction, three trials: with memory the second attempt
never regresses (Δ ≥ 0 every trial); without it, it never builds (Δ ≤ 0 every trial). The
mechanism, demonstrated.
**Where it lives:** the "how it works" page; a short demo/visual.

### 6. "An engineering team's tribal knowledge, in the commit log."
**Hook:** *Compose one agent into a team into an org, with the institutional knowledge that
usually lives in people's heads living in the history instead, readable by every fresh
agent. And real-team feedback, where a later stage sends work back, is a loop boundary.*
**Levers:** Jobs-to-be-Done (the job is a team that ships) + Aspiration.
**Proof:** Nesting is the absence of a special case; the four task-forms all fall out of one
primitive; the cleanest measured win (+90pp) is exactly a cross-node decision propagating
through a team.
**Where it lives:** the homepage vision; the "teams and orgs" page.

### 7. "Memory you can read in a diff."
**Hook:** *Your agent's memory is reviewable, diffable git history, not an opaque vector
blob you have to trust.*
**Levers:** Contrast + transparency/trust.
**Proof:** Structured commit bodies welded to their diffs vs opaque embeddings.
**Where it lives:** the "why git" essay; enterprise/trust section.

### 8. "A Job, a Condition, an Engine. That's the whole idea."
**Hook:** *So much more than memory, and so much simpler.*
**Levers:** Occam + the elegance signal (simple core = trustworthy core).
**Proof:** Three types; everything composes from them; nesting both ways.
**Where it lives:** the docs landing; the developer pitch.

## Honest-marketing guardrails

- **Lead with the validated, not the unproven.** The convergent-evolution point and the
  cross-node win are solid. The resolve-rate magnitude is not, do not headline a pp number
  loops has not earned at significance.
- **Pratfall on purpose.** Stating "memory is a tax on one-shot tasks" and "a naive git-log
  dump matches us at small scale" *builds* credibility for the real claims. Keep that voice.
- **Comparisons stay fair.** Different axes from Mem0/Zep (recall vs completion), say so;
  don't claim a head-to-head win that hasn't been run.

## Distribution ideas that fit (from the marketing-ideas set)

A pre-launch OSS developer tool. The highest-fit, lowest-cost plays:
- **Comparison pages (#11):** loops vs Mem0 / Letta / Zep / "just paste the git log". The
  `competitive-landscape.md` research is the raw material, the honest version wins trust.
- **Engineering as marketing (#15):** loops itself, the bench harness, and the offline
  grounding probe *are* the free tools, ship them legibly.
- **Glossary / programmatic SEO (#1, #4):** own the terms, "agentic memory", "convergence
  loop", "git as agent memory", "honest gate".
- **DevRel content (#133-136) + Show HN / Product Hunt (#78):** the launch narrative is the
  convergent-evolution essay plus the honest-benchmarking story ("we found our headline
  number was noise, here's what we did"), authentic developer marketing, pure pratfall +
  authority. (DiffMem launched this exact lane via Show HN.)
