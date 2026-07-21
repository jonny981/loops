# Graphs

`dag(config)` runs named nodes with declared dependencies. It returns a `Job`, so a graph nests inside a loop and a loop inside a graph. `sequence()` and `pipeline()` are sugar over it.

## Nodes and dependencies

```ts
import { dag, agentJob } from '@loops-adk/core';

dag({
  name: 'feature',
  nodes: {
    research:  agentJob({ prompt: 'Research the issue; write FINDINGS.md' }),
    plan:      { needs: ['research'], job: agentJob({ prompt: 'Write PLAN.md' }) },
    implement: { needs: ['plan'],     job: buildLoop },   // a node can be a whole loop
    docs:      { needs: ['implement'], optional: true, job: docsJob },
    deploy:    { needs: ['implement'], when: () => !!process.env.DEPLOY, job: deployJob },
  },
  concurrency: 4,
})
```

The failure policy:

- a failed **required** producer blocks its dependents (they record `aborted`);
- a failed **optional** producer neither fails the graph nor blocks dependents — consumers must tolerate its artifacts being absent;
- an unmet **`when`** gate *skips* the node, which counts green;
- with `stopOnError` (the default) the first required failure stops scheduling anything not already in flight.

## Parallel work without collisions

Give writers their own git branch, merged back on pass:

```ts
dag({ name: 'team', isolation: 'worktree', nodes: { server, web, integrate } })
```

Each isolated node runs in its own worktree on a fork branch; committed work lands back into the parent branch serially, so concurrent writers never race on files or the index. A merge conflict fails the node — or set `onConflict: 'synthesize'` to have an agent resolve it and write a synthesised merge body. `tournament()` runs N candidates in isolated worktrees, judges them, and lands the winner.

## Kickback — send work back

A reviewer node can return work to an earlier step. The target and everything downstream of it re-run, with the reason threaded in as `ctx.lastReview`:

```ts
// inside a review node's outcome
revisionRequest({ target: 'implement', findings })
```

The cycle lives in *execution* — the graph stays acyclic — and the re-run budget (`maxKickbacks`) guarantees termination. Nodes can restrict who may kick back to them with `acceptsKickbackTo`.

## Priority

`priority` orders admission among simultaneously-ready nodes — higher runs first. It is a scheduling hint over the concurrency queue, not an execution guarantee, and it is steerable at runtime via a `reprioritise` edit.

## Live graphs

Pass a `plan` instead of static `nodes` and the graph becomes data you can edit while it runs. That is the subject of [Steering](/guide/steering).
