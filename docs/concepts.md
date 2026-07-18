# Concepts — loops, memory, and the shapes of looping

This is the conceptual map behind `loops`: its memory (the two problems it solves,
its two faces, the three shapes a loop takes, how they nest, and where it helps
versus where it is only overhead), and how that memory sits inside the wider
system, gates, orchestration, multi-model review, human gates, and introspection.
The runnable tour is [`README.md`](../README.md); the measured evidence is
[`bench/RESULTS.md`](../bench/RESULTS.md).

## The bet: fresh context, and a memory it reads

A long-running agent on one growing context window *rots*: the window fills with
stale detail and the agent loses the thread. `loops` answers with **fresh context
every turn**. Each iteration starts clean, and the workspace (files + git) is the
state. But fresh context alone causes the opposite failure, *amnesia*: a clean
iteration N re-derives what iterations 1..N−1 already worked out, and the loop
spins instead of converging.

The **Ledger** closes that gap. It is not a database; it is the git commit log,
used as memory. Each unit of work commits the *way* (a structured body: intent,
alternatives ruled out, constraints) welded to the *what* (the diff), and the next
fresh context reads it back before working. Two reads, two writes:

- **working memory** (`.loops/ledger.md`) — the running log of what the current
  agent(s) are trying. The harness auto-captures each turn (the reasoning + a summary
  of actions); peers fanned out on one task share it.
- **handoff** (`.loops/prompt.md`) — the distilled why for the *next* agent: intent,
  alternatives ruled out, constraints, what is left. Curated, not a raw log.
- **grounding** — before a turn, the branch-local commit log (recent committed
  milestones) and both live scratch files are prepended to the prompt.
- **commit** — at a milestone the body crystallises as the handoff plus a compacted
  working log, welded to the diff; both scratch files reset.

## The two faces of the Ledger

Memory does a *different job* depending on where the boundary is, and both are
measured:

- **Cross-iteration** — *recover from your own failed attempts.* In a retry loop,
  the why from attempt 3 stops attempt 4 re-walking the same dead end. (SWE-bench,
  haiku: the grounded retry builds on its prior attempt where the memoryless one
  regresses.)
- **Cross-node** — *honour an upstream node's decision you could not otherwise
  know.* A downstream agent sees an upstream node's files but not its rationale;
  the Ledger carries the *why* across the boundary. (Graph contract task: +90pp vs
  no memory.)

Both need *headroom*: a regime where one attempt, or the files alone, are not
enough. On one-shot, single-node work the Ledger is pure overhead (+2% to +72%
tokens, +0pp). It is a cost when the task is easy and a lever when it is not.

## The three loop archetypes

A loop is not one shape. Three recur, and they differ in what the Ledger does and
in *what you can even measure*: a harness built for one is blind to the others.

| | **Converge** | **Sweep** | **Tend** |
|---|---|---|---|
| shape | one hard target, retried | a known set, one fresh task per iteration | an unbounded process picking the next unit |
| example | build to a high bar with tests | upgrade each package | triage issues until none remain |
| iteration N vs N−1 | the **same** task | an **independent** task | a **discovered** task |
| terminates when | the gate passes | the worklist is empty | a dynamic condition (maybe never) |
| the Ledger's job | don't re-walk dead ends | transfer the house style | remember what's done + decided, forever |
| right metric | resolve-rate, iters-to-converge | cross-task consistency/conformance | no-redo, correct termination, coherence |
| memory stressed | grounding | handoff + conventions | retrieval + consolidation |
| `loops` shape | `loop({ until: gate, max })` | `loop`/`dag` over a worklist | `loop({ until: dynamic, max: ∞ })` |

**Converge** is the classic agent loop: keep going until the gate passes. The gate
is the quality bar. Pair `commandSucceeds` (tests really pass) with `agentCheck`
so "done" is never a model's self-report.

**Sweep** is a batch: each iteration is a fresh, independent task. Memory's job is
not "avoid my dead ends" but *transfer*: do it the way the earlier items
established. The payoff is **consistency** across the batch, not a pass/fail gate.
(Sweep, haiku: ON held a 6-doc catalog to one house format uniformly; the
no-memory arm drifted erratically.)

**Tend** is an indefinite process whose worklist is *discovered* each iteration
(assess the issues, pick the most important, repeat). It is the most
memory-demanding: over an unbounded horizon the loop must not re-pick a closed
item, must keep its prioritisation coherent, must not re-litigate a settled
decision. This is where recent-N grounding **breaks** (the log outgrows the
window) and retrieval/consolidation become essential, not optional.

## Nesting — the archetypes compose

Real systems nest them. GitHub triage is **Tend ∘ Converge**: the Tend loop picks
the next ticket, *classifies* it, and dispatches to the right shape of sub-loop (a
bug → a Converge loop to a test gate; a research batch → a Sweep). A package upgrade is
**Sweep ∘ Converge**: each package is a multi-step build that must converge.

Because `loop()` and `dag()` both return a `Job`, and a `Job` is just
`(ctx) => Promise<Outcome>`, **dynamic dispatch is a body that selects and invokes
a sub-Job**, with no special node type. When each dispatch needs its own isolated
worktree (parallel tickets must not collide), wrap the sub-Job in
[`isolated()`](../README.md#parallelism-worktrees-and-tournaments): it forks a worktree,
runs the Job, and lands its work back on pass.

The Ledger composes through the nesting via the **land-back merge boundary**, and
the memory granularity *matches* the nesting level:

| tier | granularity | nesting level | where it lives |
|---|---|---|---|
| **scratch** (working memory + handoff) | within an iteration | a sub-loop's attempts | `.loops/ledger.md` + `.loops/prompt.md`, transient → a commit body |
| **milestone commit** | a converged unit | a sub-loop, merged back | a commit body |
| **consolidated ledger** | the whole process | the Tend loop's state | a commit body (`consolidateJob`) |

All three ultimately live in **git commit bodies**: a prompt (the why) welded to a
diff. The scratch files are only *write-ahead buffers* (working memory + handoff)
that crystallise into the next commit body and reset; milestones are commit bodies;
the ledger is a commit body (an empty-tree commit). Nothing durable is a side file.
A commit body does not expire at the next turn: welded to its diff, it is a permanent
record any later agent can look back to, as far back as it wants. Recent-N surfaces
the nearby ones, retrieval selects the relevant ones however old. A Tend loop grounds
on **milestones** (each = a sub-loop that converged and landed back — it sees
outcomes, not raw sub-iterations); the sub-loop grounds on its own **scratch files**.
The merge is where a sub-loop's work becomes visible.

## Scaling the read: recent-N → retrieval → consolidation

As the log grows, *reading* it has to scale, and there is a progression:

- **recent-N** (default grounding) — read the last N commits. Cheap, but **fails
  on a long/noisy log**: the load-bearing commit falls out of the window. (Noisy
  log: 0/6.)
- **retrieval** (`ground: { retrieve: true }`) — a cheap model selects the
  *relevant* commits by subject (a set, up to 8 by default), reaching past the
  window. What it injects is not just a diff: each retrieved commit carries the
  full **way** — the diff welded to the why, the alternatives ruled out, the
  constraints that held, and what not to repeat. (Same noisy log: 5/6.) Use it for
  long-horizon (Sweep/Tend) work; recent-N is the wrong default there. The
  selector runs without tools and counts against timeout, usage, and budget;
  set `ground.retrieve.engine` when the worker engine cannot enforce `tools: []`.
- **consolidation** (`consolidateJob`) — fold the history into a **decision-preserving
  consolidated ledger**: the current state, the open threads, and every accrued
  decision kept verbatim, committed as a **commit body** (an empty-tree commit), so
  grounding surfaces it like any milestone; the prior ledger is read back from the
  last consolidation commit. This is the *coarse* tier, and the one retrieval cannot
  stand in for: top-k retrieval — vector or model — fetches the *k most relevant*
  commits, not *everything you have decided*, so when the work must honour many
  accrued decisions retrieval hits a hard ceiling at k while consolidation folds them
  all into bounded space (and degrades gracefully as the count grows, not off a
  cliff). A naive progress *summary* fails the same way from the other side: it
  compresses the specifics away; the consolidated ledger is tuned to preserve them.
  This is what a Tend loop needs to stay coherent over an unbounded horizon, emergent
  across many commits rather than held in any one. The Tend benchmark is where it is
  measured and tuned: how often to consolidate, how tight the ledger, whether to
  retrieve over the ledger or the raw commits.

## The hard case: decisions that change

A decision is rarely made once. It evolves — `X → X′ → X″` — as the work teaches you
more, and the agent doing step 50 must act on the *current* value, not a stale one. This
is where memory strategies diverge **by construction**:

- **Keyword search / `git log` grep** returns *every* mention of the decision (`X`,
  `X′`, and `X″`) and nothing in a match says which is current. On a history too long to
  read end to end, reading more makes it worse, not better.
- **Similarity retrieval (vector RAG)** ranks by *relevance*, not *recency*. A superseded
  `X` is as similar to the query as the current `X″`, so stale versions surface on equal
  footing, and a larger `top-k` surfaces *more* of them.
- **Append-only fact stores** (a memory layer whose default write *accumulates* rather
  than overwrites) keep `X`, `X′`, `X″` side by side: the same ambiguity, now in a
  database.

Consolidation is the tier the others structurally lack: it folds the history into a
bounded ledger that carries the *current* state of each decision, where a later revision
supersedes an earlier one. Retrieval *finds* commits; consolidation *resolves* them into
where things actually stand. Keeping evolving decisions coherent over a long horizon is
what agentic work needs, and the axis a recall-the-conversation memory benchmark never
tests.

## The whole system

Memory is one pillar of `loops`, not the whole of it. The primitives compose into
a cohesive system, each part covering a failure mode the others cannot:

- **Deterministic, curated memory, no added architecture.** Git is the substrate;
  the loop persists curated decisions to commit bodies deterministically as work
  converges, and reads them back deliberately (recent, selected, or consolidated).
  No vector store, no embeddings, no side database to sync or let go stale.
- **Complex nested workflows from simple primitives.** `loop()` and `dag()` both
  return a `Job`, so a loop inside a dag inside a loop is ordinary composition to
  any depth, not a bespoke harness.
- **Multi-agent orchestration without context rot.** Every turn runs on a fresh
  context; a team coordinates through the workspace and the Ledger, so a long,
  many-agent run never drags a ballooning transcript.
- **Deterministic gates for repeatable workflows.** A gate pairs a real check
  (`commandSucceeds`) with a judge (`agentCheck`), hardened by k-of-n `quorum` and
  a dimensional rubric that fails closed, so "done" is reproducible, not a
  self-report. Retry, backoff, and budget caps bound the run.
- **First-class agent UX.** `validate`/`describe` print a loop's shape before it
  spends a token; `--supervise` plus `list`/`status`/`tail` and the semantic
  `records` stream make a running fleet introspectable; the TUI renders it live.
  Bounded cross-stage **feedback** (`kickback`) sends work back to an earlier node
  with the objection threaded in, capped so it provably terminates.
- **Any model, any harness.** The agent launch touches only a one-method `Engine`,
  so a reviewer can run on a genuinely different model than the worker. The model
  that did the work never grades it.
- **Human-in-the-loop gates.** `humanGate` holds the run at a named checkpoint
  until a person acknowledges it, for the steps that must not proceed on any
  model's say-so.

These are not separate tools bolted together. They share one substrate (git and
the workspace), one unit of work (the `Job`), and one control model (conditions and
outcomes), which is why the nesting above needs no special case. A feedback cycle
is a loop boundary, not a backward edge: the graph stays acyclic and convergence is
what ends it. See
[patterns.md](patterns.md#feedback--a-later-stage-sends-work-back-to-an-earlier-one).

This is what makes "why not just paste the git log into a prompt?" the wrong
question. A dump imitates *recall* on a short history, but it is neither of the
things that make the Ledger memory: it has no **write** discipline (it takes
whatever was committed, curated or not) and no **read** discipline (it injects
everything, which stops scaling the moment the log outgrows the window). And it
replicates none of the rest of the system: to match "classify → fork a worktree →
run the right shape of gated loop → land back → stay coherent across an indefinite
stream," you do not write a prompt, you rebuild `loops`. Nobody runs an agent off a
pasted git log; it was never the comparison.

## Where it helps — the scorecard

| regime | lift | note |
|---|---|---|
| one-shot / single-node | +0pp | the floor — memory is only overhead |
| Converge, multi-attempt | builds vs regresses | the grounded retry builds on prior attempts; the memoryless one regresses |
| cross-node, contract | +90pp | carry an upstream decision (vs no memory) |
| cross-node vs naive log-dump | ~tie | on a short log, memory is ergonomics, not capability |
| noisy log, retrieval vs recent-N | 83% vs 0% | the default is wrong for long horizons; retrieval fixes it |
| Sweep, batch consistency | +83pp | hold a catalog to one house format |

A limited sample size, a weak model, and light hardware bound these results. See
[`bench/RESULTS.md`](../bench/RESULTS.md) for the method, the caveats, and what is
still unproven (notably: retrieval beating brute-force dump at a scale too big to
paste, and the nested Tend ∘ Converge capstone).
