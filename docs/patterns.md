# Patterns — the loop archetypes as recipes

`loops` deliberately ships **no** `converge()` / `sweep()` / `tend()` helpers: the
archetypes are *patterns*, composed from the primitives, not API surface. These are
the canonical recipes, named with the [concepts](concepts.md) terminology, so you
can copy one and fill it in. The core stays minimal and these stay yours to shape.

## Converge — retry one task until a gate passes

One hard target, a high quality bar, likely many attempts before convergence.
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
  // The gate combines a deterministic check with a judge: the tests really
  // pass AND a judge agrees it matches intent.
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
coherent: don't re-pick a done unit, keep prioritisation straight, terminate when
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
    // Coarse memory: every 10 turns, fold the log into a rolling ledger commit
    // body, so recent-N grounding still sees a SUMMARY of the whole horizon.
    fnJob('consolidate', async (ctx) =>
      ctx.iteration % 10 === 0 ? consolidateJob({})(ctx) : { status: 'pass' }),
  ),
  until: predicate(async (ctx) => backlogEmpty(ctx), 'backlog clear'),
});
```

## Tend ∘ Converge — dispatch each ticket to the right shape of sub-loop

The full autonomous system: a Tend loop that evaluates each ticket, classifies it,
and dispatches to the right sub-loop shape, each in its own worktree so parallel
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
sub-loops ground on their own **scratch files** (working memory + handoff). See
[concepts.md](concepts.md#nesting--the-archetypes-compose).

## Feedback — a later stage sends work back to an earlier one

Real teams loop back: marketing reads the build and tells engineering the contract
drifted. A feedback cycle is a **loop boundary, not a backward edge**: the graph
stays acyclic, the cycle lives in a bounded re-run, and because every feedback cycle
in a working org *converges* (the objection is addressed or a cap is hit), it
terminates. There are two granularities.

### Tier 1 — coarse loop-back (a downstream review gate)

The whole stage that participates in the cycle is a `loop` whose gate is the
downstream check. A failed `review` re-enters the loop body with the objection as
`ctx.lastReview` (rendered as "## Next"), and git carries prior work forward so the
re-run **builds** rather than restarts. No new API — `loop` already has `review`.

```ts
import { dag, loop, sequence, agentJob } from 'loops';

export const ship = dag({
  name: 'ship',
  nodes: {
    delivery: loop({
      name: 'delivery',
      body: sequence('build', spec, engineering, testing),
      review: marketingReview, // a rejection re-runs spec→engineering→testing
      until: testsPass,
      maxReviewRestarts: 3, // bound the worker/reviewer standoff
    }),
  },
});
```

You set how far a kickback propagates by *which* loop holds the gate: the delivery
loop sends work back to `spec`; an outer loop wrapping more stages sends it back
further. The cost: a coarse re-run repeats the **whole** body, so a nit on engineering
also re-runs spec and testing. Grounding makes that cheap (each re-run sees its prior
committed work), not free.

### Tier 2 — surgical kickback (re-run one subgraph)

When you want to re-run only a *specific* earlier node and its dependents, a node
returns a targeted `revisionRequest({ target, findings })`. The enclosing `dag`
marks the target plus its transitive dependents dirty, threads the reason in as
`lastReview`, and re-runs just that subgraph in topological order, bounded by
`maxKickbacks`, the re-run budget that guarantees termination. `kickback(to,
reason)` is the terse compatibility helper for the same routed feedback.
Findings use structured severity: `block` and `should-fix` require another pass;
`nice-to-have` and `approve` can surface without closing the gate. Legacy
`blocking` and `advisory` inputs remain valid aliases.

```ts
import { dag, agentJob, fnJob, kickback } from 'loops';

export const ship = dag({
  name: 'ship',
  maxKickbacks: 2, // total re-run budget across the dag (default 0 = kickbacks off)
  nodes: {
    engineering: agentJob({ label: 'engineering', ground: true, prompt: buildPrompt }),
    marketing: {
      needs: ['engineering'],
      acceptsKickbackTo: ['engineering'], // optional: restrict valid targets
      job: agentJob({
        label: 'marketing',
        prompt: reviewPrompt,
        // Map the review into a verdict: approve, or kick the work back upstream.
        outcome: (text) =>
          /off-brand/i.test(text)
            ? kickback('engineering', text) // re-runs engineering with this note
            : { status: 'pass', summary: 'approved' },
      }),
    },
  },
});
```

The target must be an **ancestor** (a kickback to a non-ancestor, a disallowed
target, or one past budget is rejected and logged via a `dag:kickback` event, never
silently dropped). The default `kickback(...)` status is `fail`, so if the budget is
spent before the work converges, the dag fails rather than shipping unaddressed
feedback. Same idea as Tier 1's review — a downstream check sends work back, bounded,
with the feedback threaded in — at a finer grain. The runnable offline version is
[`examples/feedback.loop.ts`](../examples/feedback.loop.ts).

## Ship via PR — keep the squash-merge body intact

loops' memory *is* the commit log: each milestone commits a structured "way" welded to
its diff. A **squash merge** threatens that. It collapses every milestone body on the
branch into one commit whose body GitHub defaults to a list of subject lines, so the
reasoning is lost from the base branch's history. The fix reuses the fold loops already
has: a PR body that is `consolidate`d from the branch's commit bodies, kept current, and
written as the squash commit message.

```ts
import { loop, sequence, agentJob, commandSucceeds, pullRequestJob, mergeJob, forgeChecks } from 'loops';

export const ship = sequence('ship',
  loop({
    name: 'build',
    body: agentJob({ label: 'engineer', ground: true, prompt: buildPrompt }),
    until: commandSucceeds('npm', ['test']),
    commit: { subject: 'feat: the feature' }, // rich milestone bodies on the branch
  }),
  // Push, then open or update the PR. The body is a synthesis of the branch's commit
  // bodies (consolidate, scoped `since: base`), refreshed each run — so it stays current.
  pullRequestJob({ base: 'main', title: 'feat: the feature' }),
  // Opt-in squash merge with that synthesis as the commit body, gated on CI being green.
  mergeJob({ base: 'main', auto: true, deleteBranch: true }), // --auto: GitHub merges when checks pass
);
```

`pullRequestJob` is **idempotent create-or-update**: run it after each milestone (or at
convergence) and the PR description tracks the branch, which is what makes the eventual
squash body correct. Two ways to gate the merge for "when CI passes":

- `mergeJob({ auto: true })` → `gh pr merge --squash --auto` (non-blocking; GitHub lands it
  once required checks pass — the recommended path), or
- `mergeJob({ when: forgeChecks() })` → a synchronous loops gate that checks the PR's required
  checks before loops issues the merge (`forgeChecks()` is a `Condition`, usable anywhere one is).

`mergeJob` writes the synthesis as the squash body directly, so it survives the squash
regardless of the repo's merge settings; body-only (drop `mergeJob`, let a human merge)
instead relies on the repo's squash default being "PR title and description". The host is the
injectable `Forge` interface (gh-backed by default), so the whole flow runs offline against a
`MockForge` — see [`examples/ship-pr.loop.ts`](../examples/ship-pr.loop.ts).
