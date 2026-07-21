# Momentum — the design for preemption

`loops` runs on three verbs — iterate, depend, judge
([README](../README.md#iterate-depend-judge)) — and names preemption as the
deliberate fourth. This document is that fourth verb's design: **steer** — the
rewrite of a running graph done as a first-class, validated, recorded
operation. It defines the model (past / frontier / future), the quantity the
verbs conserve (**momentum**), the mechanism (the live plan and its
safepoints), and the role each existing subsystem plays. The first slice of
this design is implemented — see [What ships](#what-ships) for the mapping —
and the changelog remains the record of exactly what shipped when.

## Why: the path is never mapped

Every planning formalism flatters itself that the plan will survive contact
with the work. It never does. Real work is re-decided constantly: an incident
lands, a review changes a decision, a dependency turns out to be the actual
task. The plan is always finite; the planning never stops.

The Tend pattern ([concepts](concepts.md)) approximates this — a loop whose
body picks its next job at runtime — but only at iteration boundaries of one
loop. Preemption moves the re-decision anywhere in a running graph: pause it,
rewrite it on new information, resume it, without losing the work in flight or
the reasoning behind the change.

## The model: past, frontier, future

A running graph has an arrow of time, and the three regions have different
mutability by construction:

| region | contents | mutability | substrate |
|---|---|---|---|
| **past** | completed, gate-accepted nodes | immutable | git commits + bodies, semantic records |
| **frontier** | the running leaf nodes | contested — safepoints govern | worktrees, scratch files |
| **future** | unstarted nodes | freely editable | the plan (data) |

The past is immutable because it is not bookkeeping — it *is* the work: a
diff welded to its why in a commit body, with the gate verdict that accepted
it in the records. A completed node cannot be edited, only consolidated and
retrieved. The future is only data; edits land there without ceremony,
subject to validation. Everything hard about preemption lives in the thin
band between them: the frontier is a moving boundary a few nodes wide, and
managing that boundary is the whole problem.

## Momentum

**Momentum is the rate at which gated work crystallizes from the frontier
into the past.** It is not activity. A graph can be furiously busy —
spinning, retrying, re-litigating — and have zero momentum; motion is not
progress, which is the exact distinction the `noProgress` detector already
enforces inside a single loop. Momentum generalises it to the graph: a unit
of momentum is a node crossing the frontier into history, which means a
commit with a fail-closed gate verdict welded to it. It cannot be faked,
because every claimed unit is auditable.

The definition induces a state taxonomy:

| state | frontier | crystallization | meaning |
|---|---|---|---|
| **alive** | active | flowing | work is passing the gates and landing |
| **idle** | quiet | zero, legitimately | potential energy — a Tend loop watching the world (`noProgress` is opt-in for exactly this) |
| **stalled** | active | zero | motion without momentum — the pathological case the `ProgressTracker` detects |
| **done** | empty | — | zero momentum **and** no pending steer: genuinely nothing more to do |

A loop stops when it has no momentum. `done` is the only honest stop, and it
is a *dynamic* condition — the halting question is not "is the list empty"
but "is anything still crystallizing, and is anyone still steering".

Momentum is also the supervision number. The roadmap's `convergence count`
and `cost per accepted change` are momentum metrics in plainer clothes;
`loops status` reporting momentum per run, a helm driver steering by it, and
a visualisation of history crystallizing at the claimed rate are all folds
over the same event stream. The metric, the control surface, and the demo
are one object.

## Steering

**Steering is force: momentum injected from outside the run.** Left alone, a
plan's momentum decays monotonically to zero as the frontier drains — the
run completes. A steer refills the future, and the system lives on.

The mechanical model is a stick spinning a wheel: **contact is intermittent,
and the system is autonomous between contacts.** A steer is a discrete
impulse applied at a safepoint; between impulses the graph runs entirely on
the plan it has. Steering is cheap, occasional, and recorded — never a hand
resting on the wheel.

### The edit vocabulary

| edit | future | frontier | past |
|---|---|---|---|
| **add** (node/subgraph) | freely | — | refused |
| **remove** | freely | cancel via preempt | refused |
| **rewire** (edges) | freely | applies at next scheduling decision | refused |
| **cancel** | freely | wind-down, then per-node abort | refused |
| **reprioritise** | freely | affects scheduling order only | refused |

Every edit is validated against the current plan before it applies — the
**live toposort**: acyclicity and unknown-dependency checks, per edit, with
the same `CONFIG`-error discipline `dag()` applies once at construction.
An invalid edit is rejected whole; a valid one applies atomically and bumps
the plan version. Every accepted or rejected steer emits an event and a
semantic record — who changed the plan, when, why, and what was abandoned —
so the plan's history is as auditable as the work's. `dag:kickback`
(from/to/reason/accepted/note) is the template.

### Who may steer

Two sources, with different budgets:

- **Out-of-process** — a person, or a helm driver, through the control
  channel. Unbudgeted: external steering is exactly how an indefinite
  process is supposed to stay alive.
- **In-graph** — a node requesting a plan change, the generalisation of
  kickback. Budgeted, like `maxKickbacks`, so self-modification provably
  terminates.

This split is what keeps the theory intact (see
[Termination](#termination-and-decidability)).

## The live plan

`dag()` computes its graph once, at construction: the node map, the edges,
the derived relations (`dependents`, ancestors, dirty-sets) are closure
constants, and the toposort is consulted only for validation and kickback
ordering. Execution is demand-driven promise-chasing — there is no
precomputed schedule to invalidate, because there never was a schedule.
That accident is the design's foundation: going live means making the
*inputs* to scheduling mutable, not replacing the scheduler.

The deltas, in dependency order:

1. **The plan object.** The graph moves from closure constants to a
   first-class, versioned structure that every scheduling decision reads
   through. Derived relations are computed against the current version.
2. **The epoch loop.** The single `Promise.all(names.map(run))` barrier
   assumes a static node set. Its replacement is already written in embryo:
   the kickback loop invalidates a dirty subgraph (clears memo, results,
   and checkpoint entries), threads the reason in as `lastReview`, resets
   the stop flag, and re-enters the barrier. Steering generalises that from
   "re-run the same subgraph" to "edit the graph, then re-run what is
   dirty".
3. **Per-node abort.** Every node shares the run's one signal; a live
   frontier needs a child controller per node so one branch can be
   preempted without stopping the graph. This is the escalation behind
   `cancel`.
4. **Checkpoint identity.** Node state is keyed by name within the dag's
   checkpoint; removals and rewires invalidate exactly the entries the
   kickback path already knows how to clear.

## Safepoints

A safepoint is where an edit takes effect. The contract:

1. **Unstarted nodes always see the current plan.** The version is read at
   the scheduling decision, immediately before a node starts.
2. **A running node finishes its turn.** Cooperative wind-down is the
   default: the body completes its current engine turn, commits its scratch,
   and yields; the new plan governs what happens next. Loop bodies get the
   same courtesy at their iteration boundary — the same yield points the
   abort path already uses.
3. **Hard preemption is the escalation, not the mechanism.** A per-node
   abort ends the turn; the workspace already holds everything durable the
   node produced, because the workspace is the state.
4. **Parking is a memory event, not a destruction event.** A preempted
   node's in-flight state is folded into a commit body — `consolidateJob`
   is the machinery — so the work is retrievable, not lost.
5. **Resumption grounds on current decisions.** The reason for a steer is
   usually that a decision changed; every parked job was mid-flight on the
   old value. A revived node grounds on the consolidated ledger — current
   values, superseded ones marked — so it acts on X″, never the X it was
   parked with. Consolidation is the correctness mechanism here, not
   garnish.

## Termination and decidability

The library's standing claim — the graph layer stays decidable, execution
provably terminates ([theory](theory.md)) — survives preemption in
conditional form, and the condition is the honest one:

- **Within a plan version, execution terminates.** The per-version argument
  is the existing one: acyclic graph, bounded kickbacks, loop caps and
  stall detection.
- **In-graph steering is budgeted**, so a self-modifying run also
  terminates.
- **Unboundedness enters only through external steering** — a deliberate,
  recorded act by a person or a driver. An indefinitely-lived run is not a
  runaway; it is a supervisor choosing, impulse by impulse, to keep the
  wheel spinning.

The map is always finite; the mapping never has to stop.

## The embryo: what exists

None of this starts from zero. Each piece of the design has a subsystem
whose semantics it inherits:

| existing machinery | role in this design |
|---|---|
| kickback (`dag.ts`) | subgraph invalidation + barrier re-entry — the epoch loop's mechanics, shipped and tested |
| checkpoint node-clearing | plan-edit invalidation of per-node state |
| `noProgress` / `ProgressTracker` | the zero-momentum detector, already fail-safe |
| `paused` / exit 75 / `--ack` | the externally-lifted halt — the precedent for a steer-induced pause |
| semantic records | the steer audit stream (`dag:kickback` is the event template) |
| the supervisor registry (`~/.loops/runs`) | the control channel substrate — the reads exist; steering adds the write side |
| `isolated()` / worktrees | frontier branches that can be parked or preempted without collateral damage |
| `consolidateJob` | park-and-resume memory; the stale-decision hygiene on revival |

## What ships

The first implemented slice of this design, and where each piece lives:

| design element | implementation |
|---|---|
| the live plan (versioned graph, atomic batches, live toposort) | `livePlan()` / `LivePlan` (`src/core/plan.ts`); templates give out-of-process `add` a vocabulary of work |
| the epoch scheduler + per-node abort | `dag({ plan })` (`src/core/dag.ts`): edits apply structurally at the barrier (the safepoint); `cancel`/`remove` of a running node aborts its own signal immediately |
| the arrow of time | the running dag guards the plan: any edit touching a passed node is refused (`already crystallized`) |
| out-of-process control | the registry's command side (`src/runtime/control.ts`): `loops control <runId> pause\|abort`, `loops steer <runId> '<edits>'`; `pause` lands at the loop/dag safepoints as the standard resumable `paused` (exit 75) |
| the steer audit | one `dag:edit` event per edit, accepted or refused, in the event stream and registry |
| momentum, measured | `momentumFromEvents` (`src/core/momentum.ts`): crystallization count/rate + the alive/idle/stalled/done read, surfaced in `loops status` |
| the offline demo | `npm run example:steer` — discovered work steered in, a running node preempted, an urgent node injected, completion when momentum runs out |

Per-version termination holds as designed: a live dag completes when a
barrier settles with no steer landed since it began.

## Sequencing

Stages 1–2 (and the steer vocabulary of stage 3) are the shipped slice above.
What remains, each landing standalone value:

1. **Deeper safepoints** — cooperative wind-down inside a node (finish the
   engine turn, commit the scratch, then yield) instead of signal abort;
   steerable loop bodies at their iteration boundary.
2. **Park-and-consolidate** — fold a preempted node's in-flight state into a
   commit body on cancellation, and ground its revival on the consolidated
   ledger.
3. **Out-of-process kickback** — inject a revision into a running dag from
   the control channel, completing the operator's verb set.
4. **Proof** — the Tend ∘ Converge capstone benchmark
   ([bench](../bench/RESULTS.md) names it unproven) and a team-shaped
   recipe as the demonstration that momentum, not scale, is what makes
   long-lived agent work trustworthy.

## Non-goals

- **Durable mid-run replay stays out.** The workspace is the state; a
  killed run resumes from disk and checkpoint, and orchestration-grade
  replay remains an embedding concern (Temporal and friends), per the
  standing tenet.
- **No node type that only works in one position.** Steer edits compose
  through nesting like everything else; a preempted node may itself be a
  loop or a dag, and the safepoint contract is the same at every depth.
- **No exemption from judgment.** Crystallization requires the same
  fail-closed gate verdicts as any converged work. Momentum is earned at
  the gate or it is not momentum.
