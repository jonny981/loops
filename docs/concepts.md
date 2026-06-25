# Concepts — loops, memory, and the shapes of looping

This is the conceptual map behind `loops`: the two problems it solves, the two
faces of its memory, the three shapes a loop takes, how they nest, and — honestly
— where the memory earns its keep and where it is only a tax. The runnable tour is
[`README.md`](../README.md); the measured evidence is
[`bench/RESULTS.md`](../bench/RESULTS.md).

## The bet: fresh context, and a memory it reads

A long-running agent on one growing context window *rots*: the window fills with
stale detail and the agent loses the thread. `loops` answers with **fresh context
every turn** — each iteration starts clean, and the workspace (files + git) is the
state. But fresh context alone causes the opposite failure, *amnesia*: a clean
iteration N re-derives what iterations 1..N−1 already worked out, and the loop
spins instead of converging.

The **Ledger** closes that gap. It is not a database — it is the git commit log,
used as memory: each unit of work commits the *way* (a structured body: intent,
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
  haiku: +33pp, a strict superset of the no-memory arm.)
- **Cross-node** — *honour an upstream node's decision you could not otherwise
  know.* A downstream agent sees an upstream node's files but not its rationale;
  the Ledger carries the *why* across the boundary. (Graph contract task: +90pp vs
  no memory.)

Both need *headroom* — a regime where one attempt, or the files alone, are not
enough. On one-shot, single-node work the Ledger is pure overhead (+2% to +72%
tokens, +0pp). It is a tax when the task is easy and a lever when it is not.

## The three loop archetypes

A loop is not one shape. Three recur, and they differ in what the Ledger does and
in *what you can even measure* — a harness built for one is blind to the others.

| | **Converge** | **Sweep** | **Tend** |
|---|---|---|---|
| shape | one hard target, retried | a known set, one fresh task per iteration | an unbounded process picking the next unit |
| example | build to a high bar with tests | research each OEM | triage issues until none remain |
| iteration N vs N−1 | the **same** task | an **independent** task | a **discovered** task |
| terminates when | the gate passes | the worklist is empty | a dynamic condition (maybe never) |
| the Ledger's job | don't re-walk dead ends | transfer the house style | remember what's done + decided, forever |
| right metric | resolve-rate, iters-to-converge | cross-task consistency/conformance | no-redo, correct termination, coherence |
| memory stressed | grounding | handoff + conventions | retrieval + consolidation |
| `loops` shape | `loop({ until: gate, max })` | `loop`/`dag` over a worklist | `loop({ until: dynamic, max: ∞ })` |

**Converge** is the classic agent loop: keep going until an honest gate passes.
The gate is the quality bar — pair `commandSucceeds` (tests really pass) with
`agentCheck` so "done" is never a model's self-report.

**Sweep** is a batch: each iteration is a fresh, independent task. Memory's job is
not "avoid my dead ends" but *transfer* — do it the way the earlier items
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
bug → a Converge loop to a test gate; a research batch → a Sweep). OEM research is
**Sweep ∘ Converge**: each OEM is itself a multi-step build that must converge.

Because `loop()` and `dag()` both return a `Job`, and a `Job` is just
`(ctx) => Promise<Outcome>`, **dynamic dispatch is a body that selects and invokes
a sub-Job** — no special node type. When each dispatch needs its own isolated
worktree (parallel tickets must not collide), wrap the sub-Job in
[`isolated()`](../README.md#composition--loops-and-dags): it forks a worktree,
runs the Job, and lands its work back on pass.

The Ledger composes through the nesting via the **land-back merge boundary**, and
the memory granularity *matches* the nesting level:

| tier | granularity | nesting level | where it lives |
|---|---|---|---|
| **scratch** (working memory + handoff) | within an iteration | a sub-loop's attempts | `.loops/ledger.md` + `.loops/prompt.md`, transient → a commit body |
| **milestone commit** | a converged unit | a sub-loop, merged back | a commit body |
| **consolidated roadmap** | the whole process | the Tend loop's state | a commit body (`consolidateJob`) |

All three ultimately live in **git commit bodies** — a prompt (the why) welded to a
diff. The scratch files are only *write-ahead buffers* (working memory + handoff)
that crystallise into the next commit body and reset; milestones are commit bodies;
the roadmap is a commit body (an empty-tree commit). Nothing durable is a side file.
A commit body does not expire at the next turn: welded to its diff, it is a permanent
record any later agent can look back to, as far back as it wants — recent-N surfaces
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
  long-horizon (Sweep/Tend) work; recent-N is the wrong default there.
- **consolidation** (`consolidateJob`) — fold milestones into a rolling synthesised
  roadmap (done / current state / open threads), committed as a **commit body** (an
  empty-tree commit), so grounding surfaces it like any milestone; the prior roadmap
  is read back from the last consolidation commit. The *coarse* tier: synthesised
  state, not found commits. Where retrieval *finds* the relevant past commit,
  consolidation *maintains* the process's working state — what a Tend
  loop needs to stay coherent over an unbounded horizon, and emergent across many
  commits rather than held in any one. The Tend benchmark is where it is measured
  and tuned: how often to consolidate, how tight the roadmap, whether to retrieve
  over the roadmap or the raw commits.

## Two halves: memory *and* enforcement

Memory is one half of `loops`. The other is **enforcement of how the graph
executes** — honest gates that loop until verified (`commandSucceeds` +
`agentCheck`), k-of-n `quorum` judging, the dimensional gate that fails closed,
retry/backoff, budget caps, deterministic DAG control flow, worktree isolation.

This distinction matters competitively. Pasting the git log into a prompt
replicates the *memory* half cheaply (on a small log it ties `loops`). It does not
replicate the *enforcement* half: to match "classify → fork a worktree → run the
right shape of honest-gated loop → land back → remember across an indefinite
stream," you do not write a prompt, you rebuild `loops`. The memory is the
commodity; the enforcement of convergence over a nested, long-horizon structure is
the part that is hard to hand-roll.

## Where it helps — the honest scorecard

| regime | lift | note |
|---|---|---|
| one-shot / single-node | +0pp | the floor — memory is only a tax |
| Converge, multi-attempt | +33pp | recover from your own attempts |
| cross-node, contract | +90pp | carry an upstream decision (vs no memory) |
| cross-node vs naive log-dump | ~tie | on a small log, memory is ergonomics, not capability |
| noisy log, retrieval vs recent-N | 83% vs 0% | the default is wrong for long horizons; retrieval fixes it |
| Sweep, batch consistency | +83pp | hold a catalog to one house format |

Small n, a weak model, and light hardware bound these — see
[`bench/RESULTS.md`](../bench/RESULTS.md) for the method, the caveats, and what is
still unproven (notably: retrieval beating brute-force dump at a scale too big to
paste, and the nested Tend ∘ Converge capstone).
