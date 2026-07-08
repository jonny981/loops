---
name: author-loop
description: Use when writing, running, or validating a loops `.loop.ts`: the mental model, the convergence gate, the git-memory tiers, the loop archetypes, and copy-paste recipes for authoring convergence loops with the `loops` library. Load this before composing a loop.
---

# Authoring loops

`loops` runs an agent in a convergence loop: do a bit of work with a fresh context, check whether it is *actually* done against a gate you define, and if not, go again. You author a loop as a TypeScript file, validate it offline, then run it.

## The one idea

There is one unit of work and two supporting types:

- `Job = (ctx) => Promise<Outcome>`: a unit of work of any size.
- `Condition = (ctx, last) => Promise<{ met, reason, confidence? }>`: a yes/no gate.
- `Engine`: where an agent turn runs (a model backend).

`loop()` returns a `Job`. `dag()` returns a `Job`. So loops and DAGs **nest both ways**: a DAG node can be a loop, a loop body can be a DAG. Nesting is the absence of a special case. Author with that freedom; do not reach for a node type that only works in one position.

## A loop file

A `.loop.ts` `export default`s a `Job`. Wrap it in `defineJob(...)` to pin the type.

```ts
import { defineJob, loop, agentJob, commandSucceeds, agentCheck } from '@loops-adk/core';

export default defineJob(
  loop({
    name: 'build-feature',
    max: 20,
    body: agentJob({
      prompt: (c) => `Iteration ${c.iteration}: make concrete progress on TASK.md.`,
      ground: true, // read the commit log + scratch files before working
    }),
    until: [
      commandSucceeds('npm', ['test']),                       // ground truth
      agentCheck({ question: 'Does it match TASK.md?', threshold: 0.85 }), // intent
    ],
    commit: { subject: 'feat: TASK.md' }, // one milestone commit on convergence
  }),
);
```

`loop()` config worth knowing: `body` (the Job per iteration), `until` (stop gate), `start` (gate before iterating), `stopOn` (hard early-exit), `review` (runs when `until` is met; a failing review folds its findings back into the next iteration), `max` (iteration cap), `noProgress` (end `exhausted` after n consecutive iterations that reach no new state; `{ window, gate: true }` also fingerprints the failing gate's `output`, so the same failure signature repeating counts as stall evidence — deterministic gates only, and it requires an explicit `until`), `delayMs` (polling delay), `commit` (milestone commit on convergence).

## Recipe parameters

Put run inputs in `defineParams(...)`, not in shell env prefixes. The CLI exposes
them as recipe-owned flags, shows them in `loops run <file> --help`, and passes
the parsed values to `ctx.params`.

```ts
import { defineJob, defineParams, fnJob } from '@loops-adk/core';

export const params = defineParams({
  oem: { type: 'string', required: true, help: 'OEM name' },
  device: { type: 'choice', choices: ['battery', 'inverter'], default: 'battery' },
  skip: { type: 'string[]', default: [] },
  repoRoot: { type: 'string', defaultFrom: 'gitRoot' },
});

export default defineJob(
  fnJob('use-params', async (ctx) => ({
    status: 'pass',
    summary: JSON.stringify(ctx.params),
  })),
);
```

Project boilerplate belongs in `loops.config.ts`:

```ts
import { defineConfig } from '@loops-adk/core';

export default defineConfig({
  run: { supervise: true, tui: false, record: 'auto' },
  profiles: {
    live: { run: { permissionMode: 'bypassPermissions', defaultModel: 'claude-sonnet-5' } },
  },
});
```

`record: 'auto'` writes the default thin record under `.loops/records/`; an
explicit `--record <path>` writes the full event stream.

Run it as `loops run onboard.loop.ts --profile live --oem Sigenergy`.

## The gate

A gate that just asks the model whether it is done lets it grade its own homework, and it always says yes. Make the gate real:

- Combine a **deterministic** signal (`commandSucceeds('npm', ['test'])`: the tests really pass) with a **separate judge** (`agentCheck`). Prefer this mixed form over a lone judge.
- `until`/`start`/`stopOn` take one item or many. Arrays are `all` by default; wrap in `any(...)` for or.
- Harden the judge: `quorum(2, judgeA, judgeB, judgeC)` is a k-of-n jury. `agentCheck({ dimensions: [...] })` opens on the geometric mean, so one weak dimension drags the verdict down.
- A missing confidence scores 0 (fail-closed). Never lean on the model's self-report alone.

```ts
until: [
  commandSucceeds('npm', ['test']),
  quorum(2,
    agentCheck({ question: 'Correct?', dimensions: ['intent match', 'evidence', 'no regressions'] }),
    agentCheck({ question: 'Correct?', model: 'opus' }),
  ),
],
```

A failing gate briefs the next attempt. The previous iteration's `until` verdict — including its diagnostic `output` (a failing command's stdout/stderr, a judge's full findings, scrubbed and truncated) — arrives as `ctx.lastGate`, so write a fix-up body that reads **why** the gate failed instead of spending a turn re-running it:

```ts
body: agentJob({
  prompt: (c) =>
    c.lastGate && !c.lastGate.met
      ? `The gate failed:\n${c.lastGate.output ?? c.lastGate.reason}\n\nFix exactly that.`
      : 'Implement the feature in TASK.md.',
}),
```

## Memory is git

Progress accumulates on disk, so each iteration starts with a clean context but not a blank one.

- `ground: true` on an `agentJob` reads the recent commit log + this run's scratch files into the next prompt, so a fresh turn knows what was already tried. The bounded prompt keeps the task and handoff instruction first, then the live handoff, working memory, and committed context. To default it on for every `agentJob` in a run, set `RunOptions.ground` or pass `--ground`; a job's own `ground` (including an explicit `false`) wins.
- `commit: { subject }` (or `commit: true`) writes one structured milestone commit on convergence: the reasoning welded to the diff. Later turns ground on it.
- For long, noisy histories use `ground: { retrieve: true }` (select relevant commits, not recent-N); for indefinite processes add `consolidateJob` to fold history into a bounded, decision-preserving record.

## Three archetypes

A loop is not one shape. Pick the one that matches the work:

- **Converge**: one hard target, retried until a gate passes: `loop({ until: gate, max })`.
- **Sweep**: a known worklist, one fresh task each: a `loop`/`dag` over the list.
- **Tend**: an unbounded process picking the next unit: `loop({ until: dynamicCondition, max })`, body dispatches to a sub-loop (wrap in `isolated(...)` for its own worktree).

They nest: triage is Tend ∘ Converge; a research sweep is Sweep ∘ Converge.

## Compose

```ts
import { dag, sequence, parallel } from '@loops-adk/core';

dag({
  name: 'ship',
  nodes: {
    research: agentJob({ label: 'research', prompt: '…' }),
    implement: { needs: ['research'], job: loop({ /* a loop as a node */ }) },
    review: { needs: ['implement'], job: gateJob('review', agentCheck({ /* … */ })) },
  },
});
```

`needs` are dependencies; a failed `optional` producer neither fails the dag nor blocks its dependents (they run, and must tolerate its artifacts being absent); an unmet `when` skips a node; `isolation: 'worktree'` (on the dag) or `isolate: true` (per node) runs writers in parallel worktrees that land back on pass. `sequence` and `parallel` are sugar over `dag`.

When the graph is a straight line, declare it as one: `pipeline(name, stages)` chains ordered named stages (stage *i* `needs` stage *i−1*; an explicit `needs` replaces that default, so fan-out/fan-in stays available). All dag semantics apply: a skipped stage counts green so the chain continues, and an `optional` stage's failure does not block later stages.

```ts
pipeline('ship', [
  { name: 'build', job: buildLoop },
  { name: 'bench', job: benchJob, optional: true },
  { name: 'release', job: releaseJob },
]);
```

To pin env vars over a subtree (gate commands, judges, and agent subprocesses all see them, with no `process.env` mutation), wrap it in `withEnv({ API_BASE: '…' }, job)`. Precedence, least to most specific: `process.env < environment.env < withEnv overlay < per-call env` (`commandSucceeds(cmd, args, { env })` / `agentJob({ env })`).

## Human gates

A step no model may approve (deploy to prod, spend real money) is a `humanGate({ name })` node: unacknowledged, it pauses the whole run (`paused`, exit code 75) and the CLI prints the resume command with `--ack <name>` appended; acknowledged, it passes. Run with `--checkpoint <path>` so the pause is resumable, then `loops run <file> --resume <path> --ack <name>`. With `--checkpoint`, completed green DAG nodes are restored from checkpoint on resume; non-DAG jobs rerun as ordinary jobs. An `AgentDef`'s `humanGates` entries construct directly: `humanGate(def.humanGates[0])`.

## Agents and feedback

A node can be a named specialist instead of an inline prompt. Define it once with `defineAgent` (persona in markdown via `fromFile`, structure in TS) and hand it to `agentJob({ agent })`; `defineSkill` folds a methodology into its system. An existing Claude Code agent `.md` loads directly with `defineAgentFromMarkdown(path, overrides?)`: frontmatter (`name`/`description`/`model`/`tools`) maps onto the def, the body becomes `system`, and the result is always a leaf (the `Task`/`Agent` spawn tools are dropped). The contract fields (`tier`, `outputs`, `failureModes`, …) are metadata for `describe` and validation, not scheduling power: the `dag` orchestrates, agents stay workers.

Review feedback is a structured revision request that flows back to the worker on one channel. In a loop, a failing `review` is threaded into the next turn as `ctx.lastReview`; set `consumeFeedback: true` and `agentJob` folds it into the prompt. Aggregate several reviewers with `reviewPanel`; route a fix back to an earlier dag node with a targeted `revisionRequest({ target, findings })` (or the terse `kickback(to, reason)`) when the dag's `maxKickbacks` allows it.

Composing a team of specialists, gates, and routed feedback is its own skill: see `skills/design-agent-team/SKILL.md`.

## Author → validate → run

```bash
loops validate path/to/feature.loop.ts     # offline pre-flight: loads + prints the shape, no model calls, no spend
loops describe path/to/feature.loop.ts     # print the loop's shape (gate, body, nodes) without running
loops describe path/to/feature.loop.ts --json # the same shape as JSON (incl. each agent node's contract)
loops run path/to/feature.loop.ts          # live Ink TUI
loops run path/to/feature.loop.ts --no-tui # plain streamed logs
loops run path/to/feature.loop.ts --json   # raw NDJSON event firehose (to supervise a run, prefer --supervise + records, below)
```

Always `loops validate` first. It imports and constructs the loop (catching syntax, import, and bad-export errors) without running it, so you fix authoring mistakes for free before spending a single agent turn. It also prints the loop's shape (its gate, body, and dag nodes), so you can confirm you built what you intended. `loops describe` prints that shape on its own.

In a composer's test suite, pin the shape with `assertGraph(job, shape)`: a partial expectation over the same introspection (`{ kind: 'dag', nodes: [{ name: 'bench', needs: ['build'], optional: true }] }`), throwing with the JSON path to the first mismatch. Only asserted fields are compared; add `exactNodes: true` to also reject extra nodes.

`loops run` works from any repo, including one that uses `loops` as a submodule or dependency. The recipe's folder must be an ES module scope (a `package.json` with `{"type":"module"}`); repos that consume `loops` already have this. If a load fails with an ES-module error, that scope is what is missing.

Add `--supervise` to make a run observable from another process: it registers under `~/.loops/runs/`. From an agent, the primary read API is `loops records <runId>`, the semantic decision stream (dispatch / completion / surfacing / revision), filterable with `--kind`, `--path`, `--last`, `--json`, rather than the raw `run --json` firehose. `loops tail <runId>` streams live events, `loops status <runId>` reports terminal state, and `loops list` enumerates runs. Watching a long run or supervising several at once is its own skill: see `skills/supervise-loop-run/SKILL.md`.

For a reusable feature-development skeleton, start with `examples/feature-dev.ts`.
It is a Commander wrapper around `examples/feature-dev.loop.ts`, so feature name,
actionable scopes, proof directory, checkpoint gate, main engine, and
adversarial reviewer engine/model are ordinary CLI flags. With live agents
enabled, the ordinary reviewers follow the main engine and the adversarial
reviewer defaults to the opposite engine family; override it with
`--adversarial-engine` and `--adversarial-model`.

## Gotchas

- **Test offline first.** Use the `mock` engine, or an engine-free `fnJob`/`predicate` body, to prove the loop's shape with zero network. A change to convergence logic deserves a deterministic check, not a live model call.
- **Conditions default to `all`.** A bare array of conditions must *all* hold. Wrap in `any(...)` when you mean or.
- **The body is a Job, so it can be another `loop`/`dag`.** Reach for nesting before inventing a new construct.
- **One milestone, not one commit per iteration.** `commit` fires on convergence. Want finer commits? Compose finer loops or nodes.

The full surface is the package's only export (`loops`); see the repo README for engines, environments, budgets, and the PR/forge jobs.
