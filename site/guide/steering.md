# Steering a running graph

Real work is re-decided constantly: an incident lands, a review changes a decision, a dependency turns out to be the actual task. **Steering** is preemption done as a first-class operation — the plan is data, edits to it are validated before they apply and recorded after, and the work in flight is preempted with dignity, not destroyed.

## The live plan

Build the graph on a `livePlan` and pass it to `dag()`:

```ts
import { dag, fnJob, livePlan } from '@loops-adk/core';

const plan = livePlan({
  name: 'sprint',
  templates: {
    // The recipe's vocabulary of steerable work: an out-of-process add
    // instantiates one of these by name — JSON cannot carry a function.
    fix: (params) => fixJob((params as { issue: number }).issue),
  },
  nodes: { survey: surveyJob },
});

export default dag({ name: 'work', plan });
```

## The edit vocabulary

Edits apply as an **atomic batch**: the whole batch is validated against the *edited* graph — unknown dependencies, dangling consumers, and cycles refuse it whole — then every accepted batch bumps the plan version and notifies subscribers.

| Edit | Effect |
|---|---|
| `add` | a new node — a ready `node` (in-process) or a `template` + `params` (from JSON) |
| `remove` | delete a node; its consumers must be rewired/removed in the same batch |
| `rewire` | replace a node's `needs` |
| `cancel` | terminate a node — running work is preempted; see wind-down below |
| `reprioritise` | change a node's scheduling priority |

```ts
plan.apply([
  { op: 'add', name: 'fix-9', template: 'fix', params: { issue: 9 }, priority: 5 },
  { op: 'cancel', name: 'refactor', graceMs: 300_000 },
]);
```

## Safepoints and wind-down

Edits take *structural* effect at the next barrier — the safepoint — through the same invalidate-and-re-enter mechanics kickback uses. Cancellation of a running node acts immediately, in one of two modes:

- **Hard** (no grace): the node's own controller aborts — exactly that branch of the frontier, nothing else.
- **Graceful** (`graceMs`): the node's `ctx.windDown` signal fires first. A cooperative body — a loop at its iteration boundary — finishes its current turn and yields; the hard abort lands only when the grace expires. Work that ignores the signal is still bounded by the deadline: honouring wind-down is an optimisation of grace, never a correctness requirement.

Either way, everything durable the node produced is already in the workspace — preemption never loses landed work.

## The rules that keep it safe

- **The past is immutable.** While the dag runs, it guards the plan: any edit touching a node that already passed is refused (`already crystallized`). Its work is a commit; its acceptance is a recorded gate verdict.
- **Cancellation is not failure.** A cancelled node neither fails the graph nor trips `stopOnError` — a deliberate steer is recorded as exactly that.
- **Self-modification is budgeted.** In-graph steers (recipe code editing its own plan) are bounded by `maxSteers` (default 100), so a self-modifying graph provably terminates. External steers — the control channel, a webhook — are exempt: outside force is how an indefinite process stays alive, and it is always a deliberate, recorded act.
- **Everything refuses closed.** An unknown op, a throwing template, a throwing guard, a reentrant apply — each refuses the whole batch with a `STEER` error and leaves the plan untouched.
- **Every edit is audited.** Accepted or refused, each edit is a `dag:edit` event in the run's record, with the plan version and the refusal reason.

## Termination

A live dag completes when a barrier settles with no steer landed since it began — so within any one plan version, execution provably terminates. Unbounded life enters only through steering. *The map is always finite; the mapping never has to stop.*

## Steering from outside the process

Against a supervised run (`--supervise`):

```bash
loops steer <runId> '[
  {"op":"add","name":"fix-9","template":"fix","params":{"issue":9}},
  {"op":"cancel","name":"refactor","graceMs":300000}
]'
loops control <runId> pause    # finish the current turn, pause resumable (exit 75)
loops control <runId> abort
```

Or over HTTP — any webhook can become a steer; see [Webhooks and control](/guide/webhooks).

Run the offline demo to watch all of it happen in half a second:

```bash
npm run example:steer
```
