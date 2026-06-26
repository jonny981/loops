# What loops is

loops runs AI agents until the work is **actually done**.

A unit of work runs with fresh context, gets checked against an *honest gate* (real
tests plus an independent judge, never "ask the model if it's finished"), and repeats,
carrying its accumulated decisions forward in git. Units **nest**: a loop's body can be a
DAG, a DAG's node can be a loop. So the same tiny primitive scales from one agent fixing
a bug, to an engineering team shipping a feature, to an org working a backlog, with the
**tribal knowledge baked into the commit log**.

Memory is one part of it. The whole is **convergence with institutional knowledge**.

## The one idea

Three types, and everything composes from them:

- **Job** `(ctx) => Promise<Outcome>` — a unit of work of any size.
- **Condition** `(ctx, last) => { met, reason, confidence? }` — a yes/no gate.
- **Engine** — the one place an agent turn actually executes (Claude CLI, the SDK, the
  API, a mock; swappable).

`loop()` returns a Job. `dag()` returns a Job. So loops and DAGs nest both ways. Nesting
is the absence of a special case, not a feature.

Two tenets hold the whole thing up:

1. **Honest convergence.** "Ask the model if it's done" is the trap the library exists to
   avoid. A gate combines a deterministic signal (the tests really pass) with a separate
   judge, hardened by a k-of-n quorum and dimensional scoring, and it fails closed. The
   loop's memory is not the model's say-so.
2. **The workspace is the state.** Progress accumulates on disk (files, git), so every
   iteration starts with a clean context and inherits the accumulated decisions by reading
   the commit log. Fresh context kills rot; git kills amnesia.

## What loops is *not*

- **Not conversational memory.** Mem0, Letta, Zep, and the benchmarks they cite
  (LoCoMo, LongMemEval, DMR) measure recalling a fact from a chat transcript. loops is not
  trying to remember your preferences across sessions. It is trying to *finish a task*, and
  to get better at task N+1 because it remembers task N.
- **Not a memory product.** Memory is one capability. There is no vector database, no
  embedding model, no index to build, sync, or let go stale. Git *is* the index, and it
  cannot drift from the code because it is the code's history.
- **Not just an orchestrator.** LangGraph and Temporal route steps and persist state, but
  they let the model declare itself done. loops' differentiator is the *honest gate*: the
  loop only converges when an external, deterministic-plus-judged check says so.

## The shapes it takes

The same primitive expresses every form of task completion. That generality is the value.

| Form | Shape |
|---|---|
| **Single task** — build this thing, loop until the quality bar passes | `loop({ until: qualityGate, max: high })` |
| **Repetitive batch** — do every item in a worklist, one per loop | `loop` whose body takes the next undone item; `until` = worklist empty |
| **Task selection** — work a backlog from an issue tracker, indefinitely | outer `loop` selects a task → nested `loop`/`dag` does it → repeat |
| **Feedback** — real-team dynamics, where a later stage kicks work back | nested loops with downstream review gates (see below) |

## A team in a primitive

A loop iteration *is* a session: fresh context, do work, commit, the next unit grounds on
the log. So a `dag` of loops is a team, each node a specialist that converges past its own
gate, leaving its reasoning welded to its diff for the next node to read. Scale the graph
up and it is an org working a backlog, with the institutional knowledge that usually lives
in people's heads instead living in the commit history, readable by every fresh agent.

**Feedback is a loop boundary.** Real teams send work back (marketing pushes on
engineering; QA pushes on a spec). A DAG is acyclic, so loops does not model this as a
backward edge. It models it as a **convergence loop**: wrap the stages that participate in
the cycle in a `loop` whose gate is the downstream stage's approval. A rejection re-runs
the body with the objection threaded in, and git carries the prior work forward so the
re-run *builds* rather than restarts. You control how far a kickback propagates by which
loop boundary you put the gate on. The principle:

> Every feedback cycle in a real org is a convergence loop. loops models orgs as nested
> convergence loops, not arbitrary cyclic graphs, so feedback always terminates (the gate
> passes, or the cap is hit).

## Why today's benchmarks don't capture it

The recognized memory benchmarks are **conversational recall** (LoCoMo, LongMemEval, DMR),
a different axis from task completion, and the most-cited (LoCoMo) is small, has a corrupt
answer key, and is beaten by a no-memory full-context baseline. The **agentic-memory**
benchmarks that actually measure "does memory help an agent finish work" are new and
unconsolidated (MemoryArena, STATE-Bench, MemoryAgentBench, SWE-ContextBench), and **no
benchmark exists yet for memory in coding agents specifically**.

So loops is not behind on its thesis, it is ahead of the measurement. The closest in-kind
result is GCC's git-context ablation (+13.0pp same-scaffold on SWE-bench Verified, N=500),
the standard loops should be measured against. Until then, loops' own ON−OFF ablation (see
`measured-metrics.md`) is the honest evidence: directional, in-kind, deliberately not
overstated. See `competitive-landscape.md` for the full field.

## Where loops shines

Scenarios where the mechanism gives a confident edge over no structured memory or a
competitor:

1. **A team building a system where an upstream decision must reach a downstream
   component that cannot re-derive it.** A wire-format, a protocol version, a field
   convention decided in one node and needed three nodes later. This is the cleanest
   measured win (+90pp on a cross-node contract task) because the decision is genuinely
   unguessable downstream, and git is the only thing carrying it.
2. **Enforced quality beyond tests.** A single agent grades its own homework. loops makes
   a multi-lens, multi-model review a *convergence gate*, so the work only ships past a
   bar the author structurally cannot apply to itself. Model-size-independent.
3. **Consistency across a repetitive batch.** N documents, N services, N migrations that
   must all follow one house style. Systematic grounding holds the batch to one format
   (+83pp conformance, uniform vs erratic) where ad-hoc generation drifts.
4. **Long-horizon autonomous work** where decisions accumulate across many context
   boundaries and must stay coherent, the backlog/org shape, where amnesia between units
   is the failure mode loops is built to remove.
5. **Where zero-infra and auditability matter.** No vector DB to stand up; the memory is
   human-readable, diffable, reviewable commit history, not opaque embeddings.

## Honest status

- **Proven (directionally):** the cross-node contract win; convergence direction (with
  memory the loop's next attempt builds, without it it regresses); batch consistency; the
  enforcement mechanism end to end.
- **Not yet proven:** a statistically significant resolve-rate lift (the samples are small
  and noisy); the read at dump-infeasible scale (retrieval has not beaten a naive
  full-log dump until the log is too big to paste); supersession (keeping the *current*
  value coherent as decisions evolve), the one capability the field engineered hardest and
  loops has not yet measured.
- **The bet:** git-commit-log-as-memory, zero-infra, honest convergence, nestable, aimed
  at agentic task completion. Independently validated by GCC's result and Letta's 2026
  pivot to git-backed memory. The work ahead is proof, not invention.
