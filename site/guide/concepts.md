# Core concepts

## One universal unit of work

Three types carry the whole library:

```ts
type Job = (ctx: JobContext) => Promise<Outcome>;
type Condition = (ctx, last) => Promise<{ met: boolean; reason: string; confidence?: number }>;
interface Engine { run(request, onEvent, signal): Promise<EngineResult> }
```

- A **`Job`** is a unit of work of any size — a single agent turn, a whole nested pipeline.
- A **`Condition`** is a yes/no gate answered against the current state.
- An **`Engine`** is where an agent turn actually executes (Claude Agent SDK, the `claude` CLI, the Anthropic API, `codex`, or your own).

`loop()` returns a `Job`. `dag()` returns a `Job`. So loops and graphs nest both ways: a graph node can be a loop, a loop body can be a graph. **Nesting is the absence of a special case** — there is no node type that only works in one position.

## The four verbs

The library models a working engineer with four verbs, grounded in the structured program theorem (Böhm & Jacopini, 1966):

| Verb | Construct | What it carries |
|---|---|---|
| **Iterate** | `loop()` | drafts, retries, rework — a loop with a bar to clear |
| **Depend** | `dag()` edges | research before the plan, approval before the build |
| **Judge** | gates (`until`, `when`, `review`) | tests, juries, a person's veto — the predicate made honest |
| **Steer** | `livePlan()` edits | the plan changing under you, validated and recorded |

The graph is always acyclic; iteration lives in one named construct with its own gate, caps, and stall detection. Because the graph never jumps, its shape is knowable before a token is spent — `loops validate` and `assertGraph` exist because of that.

## Two tenets

**A real done-check.** "Ask the model if it is done" lets the model grade its own homework. A gate combines a deterministic signal (`commandSucceeds` — the tests really pass) with an independent judge (`agentCheck`). Hardening comes from `quorum` (a k-of-n jury) and scored `dimensions` (a geometric mean, so one weak dimension drags the verdict down). A missing confidence counts as zero: fail closed, always.

**The workspace is the state.** Progress accumulates on disk — files and git — so each iteration starts with a fresh context. The loop carries only thin bookkeeping. This is why a killed run resumes losslessly, why parallel work forks into worktrees, and why the memory system is the commit history itself.

## The arrow of time

A running graph has three regions with different mutability, enforced in code:

| Region | Contents | Mutability |
|---|---|---|
| **Past** | completed, gate-accepted nodes | immutable — the work is a commit, the acceptance a recorded verdict |
| **Frontier** | the running nodes | contested — safepoints and wind-down govern it |
| **Future** | unstarted nodes | freely editable, subject to validation |

**Momentum** is the rate at which gated work crystallizes from the frontier into the past — never mere activity. A run is `done` when the frontier is empty and no steering refills it: the only honest stop. Within any one plan version, execution provably terminates; indefinite life comes only from deliberate, recorded, external force. The map is always finite; the mapping never has to stop.

Read the full design in [Steering](/guide/steering) and [Momentum](/guide/momentum).
