# Patterns — the loop archetypes as recipes

`loops` deliberately ships **no** `converge()` / `sweep()` / `tend()` helpers — the
archetypes are *patterns*, composed from the primitives, not API surface. These are
the canonical recipes, named with the [concepts](concepts.md) terminology, so you
can copy one and fill it in. The whole point: the core stays tiny and these stay
yours to shape.

## Converge — retry one task until an honest gate passes

One hard target, a high quality bar, likely many attempts before true convergence.
The Ledger lets each attempt recover from the last one's dead ends.

```ts
import { loop, agentJob, commandSucceeds, agentCheck } from 'loops';

export const build = loop({
  name: 'build',
  max: 8,
  body: agentJob({
    label: 'implement',
    ground: true, // read prior attempts' why — don't re-walk a dead end
    prompt: (c) => `Attempt ${c.iteration}: make the feature pass its tests.`,
  }),
  // Honest convergence: the tests really pass AND a judge agrees it matches intent.
  until: [
    commandSucceeds('npm', ['test']),
    agentCheck({ question: 'Does the work match the spec, with no shortcuts?', threshold: 0.85 }),
  ],
  commit: { subject: 'feat: the feature' }, // crystallise the milestone on convergence
});
```

## Sweep — one fresh task per item; transfer the house style

A known set of independent tasks (research each OEM, generate each profile). The
Ledger's job is *consistency* — each item done the way the earlier ones established.

```ts
import { sequence, agentJob, commitJob } from 'loops';

export function sweep(items: { id: string; name: string }[]) {
  const steps = items.flatMap((item) => [
    agentJob({
      label: item.id,
      ground: true, // see the house style + the prior items as examples
      prompt: `Produce the deliverable for ${item.name}, following the established house format.`,
    }),
    commitJob({ subject: `docs: ${item.id}` }), // each item becomes a milestone the next grounds on
  ]);
  return sequence('sweep', ...steps);
}
```

## Tend — work the next unit until the backlog is clear

An indefinite process that discovers the next unit each turn. The horizon is
unbounded, so reach for **retrieval** (not recent-N) and **consolidation** to stay
coherent — don't re-pick a done unit, keep prioritisation straight, terminate when
empty.

```ts
import { loop, sequence, agentJob, commitJob, consolidateJob, fnJob, predicate } from 'loops';

export const triage = loop({
  name: 'triage',
  max: 200,
  body: sequence('turn',
    agentJob({
      label: 'pick',
      ground: { retrieve: true }, // recall the full horizon by relevance, not recent-N
      prompt: 'Pick the most important OPEN item you have not handled yet, and handle it.',
    }),
    commitJob({ subject: (_c, last) => `handle: ${last?.summary}` }),
    // Coarse memory: every 10 turns, fold the log into a rolling LEDGER.md roadmap,
    // so recent-N grounding still sees a SUMMARY of the whole horizon.
    fnJob('consolidate', async (ctx) =>
      ctx.iteration % 10 === 0 ? consolidateJob({})(ctx) : { status: 'pass' }),
  ),
  until: predicate(async (ctx) => backlogEmpty(ctx), 'backlog clear'),
});
```

## Tend ∘ Converge — dispatch each ticket to the right shape of sub-loop

The real autonomous system: a Tend loop that evaluates each ticket, classifies it,
and dispatches to the right sub-loop shape — each in its own worktree so parallel
tickets never collide. Nesting is free because a `loop` and a `sweep` are both
`Job`s; `isolated()` is the per-dispatch concurrency boundary.

```ts
import { loop, fnJob, agentJob, isolated, commandSucceeds, predicate } from 'loops';

export const autoTriage = loop({
  name: 'triage',
  until: predicate(async (ctx) => backlogEmpty(ctx), 'backlog clear'),
  body: fnJob('dispatch', async (ctx) => {
    const ticket = await pickNext(ctx);
    const kind = await classify(ticket); // 'bug' | 'research' | 'chore'

    const handler =
      kind === 'bug'
        ? loop({
            name: `fix-${ticket.id}`,
            body: agentJob({ label: 'fix', ground: true, prompt: fixPrompt(ticket) }),
            until: commandSucceeds('npm', ['test']), // a Converge sub-loop
          })
        : kind === 'research'
          ? sweep(ticket.subitems) // a Sweep sub-loop
          : agentJob({ label: 'chore', prompt: chorePrompt(ticket) });

    // Own worktree; its work lands back into the line on pass, merges serialised.
    return isolated(handler, { label: ticket.id })(ctx);
  }),
});
```

The Ledger threads through the whole nesting via the land-back merge: the Tend loop
grounds on **milestones** (each = a sub-loop that converged and merged back), the
sub-loops ground on their own **drafts**. See [concepts.md](concepts.md#nesting--the-archetypes-compose).
