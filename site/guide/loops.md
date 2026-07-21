# Loops and gates

`loop(config)` returns a `Job` that runs its `body` repeatedly — a fresh context each turn — until its gate is met, a review accepts the result, or a hard stop ends it.

## Anatomy

```ts
import { loop, agentJob, agentCheck, commandSucceeds } from '@loops-adk/core';

loop({
  name: 'converge',
  start: () => process.env.CI !== 'true',   // gate before iterating (unmet ⇒ aborted)
  body: agentJob({ prompt: 'Make progress on TASK.md', ground: true }),
  until: [                                   // met ⇒ stop (then review, if any)
    commandSucceeds('npm', ['test']),
    agentCheck({ question: 'Ready to ship?', threshold: 0.85 }),
  ],
  review: agentJob({ prompt: 'Adversarial review. Fail anything questionable.' }),
  stopOn: (ctx) => ctx.state.emergency === true, // hard early-exit ⇒ aborted
  max: 20,                                   // iteration cap ⇒ exhausted
  noProgress: 3,                             // 3 flat iterations ⇒ exhausted, with evidence
  commit: { subject: 'feat: converged' },    // one milestone commit on pass
  delayMs: 0,
  retry: { onError: 'continue', maxConsecutive: 3, backoffMs: 1000 },
})
```

The lifecycle of one loop: `start` gate → repeat (`body` → `stopOn`? → `until`?) → when `until` is met, run `review` — a passing review completes the loop; any other result re-enters it, bounded by `maxReviewRestarts`.

## Gates

A gate (`start` / `until` / `stopOn`) accepts one condition or an array — arrays mean **all must hold**. Deterministic checks and agent judges are the same type, freely mixed:

```ts
until: [
  commandSucceeds('npm', ['test']),                            // the truth
  agentCheck({ question: 'Is it correct?', threshold: 0.85 }), // the intent
]
```

**Ask a jury, not a judge.** `quorum(k, ...conditions)` passes when any *k* agree:

```ts
quorum(2,
  agentCheck({ question: 'Is it correct?', model: 'opus' }),
  agentCheck({ question: 'Would this pass code review?', model: 'sonnet' }),
  agentCheck({ question: 'What breaks?', engine: 'codex' }),
)
```

**Score dimensions, not vibes.** A judge with `dimensions` opens on the geometric mean, so one weak dimension drags the verdict down. A missing confidence is treated as `0` — fail closed.

**Show the failure to the next attempt.** A failed gate hands its evidence — test output, a judge's findings — to the next iteration as `ctx.lastGate`:

```ts
prompt: (c) => c.lastGate?.met === false
  ? `The gate failed:\n${c.lastGate.output}\n\nFix exactly that.`
  : 'Implement the feature in TASK.md.',
```

## Hard stops

Three independent backstops keep a loop from spinning forever:

1. **`max`** — the iteration cap. Reached without passing ⇒ `exhausted`.
2. **`budget`** — the run's token budget (`RunOptions.budget`). Engine call sites refuse to spend past it.
3. **`noProgress`** — the stall detector. Ends the loop `exhausted` when N consecutive iterations reach no state the run has not already seen: no new workspace fingerprint, no gate confidence beating its best, no new custom signal. Off by default — a polling loop legitimately makes no progress until the world changes. The stalled outcome carries its evidence as `Outcome.stall`.

## Pausing for a person

`humanGate` produces the halt only a person lifts — the run exits with code `75` and resumes with an acknowledgement:

```ts
humanGate({ name: 'prod-approval', prompt: 'Review the staging deploy, then approve.' })
// loops run … --resume … --ack prod-approval
```

The same `paused` status carries operator pauses (`loops control <runId> pause`) and rate-limit exits, so a supervisor handles every resumable halt one way.

See the [`loop` API reference](/api/) for every option and the [`LoopConfig`](/api/) type for the full contract.
