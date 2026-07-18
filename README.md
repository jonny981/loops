<p align="center">
  <img src="assets/logo.png" alt="loops" width="320">
</p>

<p align="center">
  <strong>Run an agent in a loop until the work is actually done.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@loops-adk/core"><img src="https://img.shields.io/npm/v/@loops-adk/core" alt="npm"></a>
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="status: alpha">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%3E%3D20-3c873a" alt="node &gt;=20">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT">
</p>

`loops` is a library for convergence loops: an agent does a bit of work in a fresh context, a gate you define checks the result, and if it isn't done, it goes again. A loop is a `Job`; so is a DAG; they nest into workflows of any shape. Progress lives in git, not the transcript.

## Install

```bash
npm i @loops-adk/core   # Node >= 20
```

## A first loop

```ts
import { loop, agentJob, commandSucceeds, agentCheck } from '@loops-adk/core';

export default loop({
  name: 'build-feature',
  max: 20,
  body: agentJob({
    prompt: (c) => `Iteration ${c.iteration}: make concrete progress on TASK.md.`,
    ground: true, // read the commit log and scratch files before working
  }),
  until: [
    commandSucceeds('npm', ['test']),                                    // ground truth
    agentCheck({ question: 'Does it match TASK.md?', threshold: 0.85 }), // intent
  ],
  commit: { subject: 'feat: TASK.md' }, // one milestone commit on convergence
});
```

```bash
loops validate feature.loop.ts   # load it and print its shape; no model calls
loops run feature.loop.ts        # live TUI; --no-tui or --json for headless
```

Three principles run through the library:

- **The gate is real.** A deterministic check (the tests pass) pairs with a separate judge in its own context. The model that did the work never grades it.
- **Every turn starts fresh.** Progress accumulates in files and commits, not the transcript, so a long run never rots.
- **Git is the memory.** Decisions land in commit bodies as work converges and are read back before the next turn. Nothing to embed, index, or sync.

## Composition

`loop()` returns a `Job`. So does `dag()`. Anything that expects a `Job` accepts either, so loops and DAGs nest both ways. Runnable versions of the examples below live in [`examples/`](examples/).

### A loop inside a DAG

```ts
import { dag, loop, agentJob, agentCheck, commandSucceeds, quorum, gateJob } from '@loops-adk/core';

export default dag({
  name: 'ship-feature',
  nodes: {
    research: agentJob({ label: 'research', prompt: 'Research the task; write findings to NOTES.md.' }),

    implement: {
      needs: ['research'],
      job: loop({ // a node that iterates until its own gate clears
        name: 'implement',
        max: 10,
        body: agentJob({ prompt: (c) => `Implement increment ${c.iteration} from NOTES.md.` }),
        until: [
          commandSucceeds('npm', ['test']),
          agentCheck({ question: 'Is every increment in NOTES.md implemented?', threshold: 0.85 }),
        ],
      }),
    },

    review: {
      needs: ['implement'],
      job: gateJob('review', quorum(2, // two of three independent verdicts
        agentCheck({ question: 'Is it correct and complete?', model: 'opus' }),
        agentCheck({ question: 'Would this pass a strict code review?', model: 'sonnet' }),
        agentCheck({ question: 'What breaks?', engine: 'codex' }),
      )),
    },
  },
});
```

### A DAG inside a loop

The body of a loop can be a pipeline. Each iteration runs it again, with a fresh context, until the gate clears.

```ts
import { loop, sequence, agentJob, gateJob, commandSucceeds, agentCheck } from '@loops-adk/core';

export default loop({
  name: 'clear-release-blockers',
  max: 6,
  body: sequence('attempt',
    agentJob({ label: 'triage', prompt: 'Pick the highest-impact open blocker in TRIAGE.md.' }),
    agentJob({ label: 'fix', prompt: 'Fix it. Small diff, with a test.', ground: true }),
    gateJob('build', commandSucceeds('npm', ['run', 'build'])),
  ),
  until: [
    commandSucceeds('npm', ['test']),
    agentCheck({ question: 'Is TRIAGE.md free of release blockers?', threshold: 0.9 }),
  ],
  commit: { subject: 'fix: release blockers' },
});
```

### Review

A `review` runs once the gate is met. A rejection re-enters the loop, and the findings arrive in the next iteration's prompt.

```ts
import { loop, agentJob, agentCheck, commandSucceeds, reviewPanel } from '@loops-adk/core';

const review = reviewPanel({
  label: 'ship-review',
  reviewers: [
    { name: 'adversarial', review: agentCheck({ question: 'Challenge the design. What breaks?', engine: 'codex' }) },
    { name: 'security', review: agentCheck({ question: 'Is it safe?', model: 'opus' }) },
    { name: 'simplicity', review: agentCheck({ question: 'Is it simple?', model: 'haiku' }) },
  ],
});

export default loop({
  name: 'build-and-review',
  max: 8,
  body: agentJob({ prompt: 'Implement TASK.md.', consumeFeedback: true }), // findings land here
  until: commandSucceeds('npm', ['test']),
  review,
});
```

The adversarial seat runs on a different vendor's model, so the worker and its reviewer don't share blind spots. In a DAG, `revisionRequest({ target, findings })` sends work back to a named upstream node and re-runs the affected subgraph, bounded by `maxKickbacks`.

## Conditions

`start` / `until` / `stopOn` take one condition or many, mixing deterministic predicates and agent judges. Arrays are AND; wrap in `any(...)` for OR. Prefer the mix: a model's self-reported confidence guards *intent*, a deterministic check is the *truth*.

- **Deterministic** — `commandSucceeds`, `predicate`, `all` / `any` / `not`
- **Judges** — `agentCheck` (with `dimensions`, scored on the geometric mean so one weak dimension drags the verdict down) and `quorum(k, ...judges)`. A missing confidence scores as 0; the gate fails closed.
- **Guards** — `ratchet` (a metric may only improve), `writeScope` (changes stay in declared lanes), `sampled` (run an expensive judge on a deterministic sample of iterations). No model calls. Recipes in [docs/patterns.md](docs/patterns.md#hardening-gates--keep-the-loop-honest-without-spending-a-model-call).

A failing gate briefs the next attempt: its evidence (failing test output, a judge's findings) arrives in the next iteration as `ctx.lastGate`, so a fresh context reads why it failed instead of rediscovering it.

## Engines

The loop only touches a one-method `Engine` interface, so any model can run any role — a reviewer on a different model than the worker.

| name            | backend                          | notes                                             |
| --------------- | -------------------------------- | ------------------------------------------------- |
| `claude-cli`    | `claude` subprocess              | uses host Claude auth, no key                     |
| `agent-sdk`     | `@anthropic-ai/claude-agent-sdk` | fresh `query()` per call                          |
| `anthropic-api` | `@anthropic-ai/sdk`              | token streaming; cheapest for judges; needs a key |
| `codex`         | `codex exec` subprocess          | a different vendor behind the same interface      |
| `mock`          | scripted, offline                | for tests and examples                            |

Bring your own by implementing `run` and registering a name:

```ts
const myEngine: Engine = {
  name: 'my-provider',
  async run(req, onEvent, signal) {
    return { text, usage: { inputTokens, outputTokens }, model: req.model ?? 'x' };
  },
};
await run(job, { engine: 'my-provider', engines: { 'my-provider': myEngine } });
```

`fallbackEngine(['claude-cli', 'codex'])` reroutes around a dead lane (bad key, missing binary) and remembers it. `loops preflight` checks each lane with one tiny turn before iteration 1 spends anything.

## Memory

Fresh context prevents rot; the Ledger prevents amnesia. Three tiers, all in git:

- **Scratch files** — `.loops/ledger.md` (working memory) and `.loops/prompt.md` (the handoff), auto-captured from grounded turns.
- **Milestone commits** — on convergence, `commit:` writes one structured commit body: the why, welded to the diff. The scratch files are cleared.
- **Grounding** — `ground: true` prepends the recent commit log and scratch files to the next turn. `ground: { retrieve: true }` has a cheap model select the relevant commits instead; `consolidateJob` folds a long history into a bounded, decision-preserving record.

`pullRequestJob` / `mergeJob` keep a PR body as a consolidation of the branch, so the reasoning survives a squash merge. The full model is in [docs/concepts.md](docs/concepts.md); [bench/RESULTS.md](bench/RESULTS.md) has the memory-on-vs-off ablation.

## Limits

Three independent stops, plus a pause only a person lifts:

```ts
loop({
  name: 'build',
  body,
  until: commandSucceeds('npm', ['test']),
  max: 50,        // caps attempts
  noProgress: 3,  // ends the loop after 3 iterations reaching no new state
});
await run(job, { budget: 2_000_000 }); // caps tokens; engine calls refuse past it
```

A rate limit, quota, or spent budget pauses the run (exit 75) and prints a resume command; `--checkpoint` / `--resume` continue warm, restoring completed green DAG nodes. `humanGate({ name: 'prod-approval' })` holds the run at a named checkpoint until someone re-runs with `--ack prod-approval` — for steps that must not proceed on any model's say-so.

## Parallel work

`isolation: 'worktree'` gives each DAG node its own branch and git worktree, merged back on pass, so parallel writers never collide. `isolated(job)` is the same boundary as a wrapper, for work discovered at runtime. `tournament()` runs N candidate approaches in isolated worktrees, judges them, and keeps the winner. `withEnv(overlay, job)` pins env vars over a subtree; pinned values are scrubbed from all captured output.

## Environments

A gate is only as good as what it tests. An `Environment` brings up the running thing — a local Docker stack, a per-branch cloud preview — and injects its env vars (`BASE_URL`) into gate commands, so `until` can test live behavior rather than files on disk. Adapters for command-line IaC tools, sst, and Docker Compose ship as opt-in subpaths.

## CLI

```bash
loops run feature.loop.ts                 # run a definition file (live TUI)
loops run feature.loop.ts --no-tui        # plain logs        --json  # NDJSON events
loops validate feature.loop.ts            # load + print the shape; no model calls
loops describe feature.loop.ts --json     # machine-readable shape
loops preflight -e claude-cli -e codex    # check each engine lane with one tiny turn

# or no file at all — the standard worker → until → review loop from flags:
loops run --prompt "Implement TASK.md" --engine claude-cli \
  --until "Fully implemented with passing tests?" --threshold 0.85 --max 20
```

Supervision is file-based; no daemon, no socket:

```bash
loops run build.loop.ts --supervise   # registers under ~/.loops/runs/
loops list                            # every supervised run, with state
loops status <runId>                  # where it is and what's blocking it
loops tail <runId>                    # stream events live
loops records <runId> --kind revision # the decision stream, filtered
```

`loops helm` is a conversational front end: plain English in, strictly validated intents out, deterministic code executing them ([docs/helm.md](docs/helm.md)). Recipes can declare their own CLI flags with `defineParams`, and a `loops.config.ts` beside the recipe holds project defaults; `loops init <dir>` scaffolds a new recipe folder.

> `loops run <file>` imports and executes that file's module, like `node <file>`. Only run definition files you trust.

## Scope

`loops` is the body of the loop, nothing more. Scheduling belongs in cron or CI. Durable replay belongs in Temporal, LangGraph, or Mastra — embed a `loops` job inside them. The detailed comparison is in [docs/comparison.md](docs/comparison.md).

## Examples

| Example | Shows |
| --- | --- |
| [`simple-poll.loop.ts`](examples/simple-poll.loop.ts) | the smallest loop; offline (`npm run example:poll`) |
| [`confidence-gate.loop.ts`](examples/confidence-gate.loop.ts) | deterministic and judge gates together |
| [`dag-pipeline.loop.ts`](examples/dag-pipeline.loop.ts) | a DAG with a loop node and a quorum gate |
| [`converge-review.loop.ts`](examples/converge-review.loop.ts) | a review rejection re-entering the loop; offline |
| [`feedback-pipeline.loop.ts`](examples/feedback-pipeline.loop.ts) | kickback between DAG stages |
| [`build-service.loop.ts`](examples/build-service.loop.ts) | four engineer loops in a DAG, five-lens review, two vendors |
| [`ship-pr.loop.ts`](examples/ship-pr.loop.ts) | push → PR → gated squash-merge that preserves the Ledger |
| [`stall-demo.loop.ts`](examples/stall-demo.loop.ts) | no-progress detection (`npm run example:stall`) |
| [`feature-dev.ts`](examples/feature-dev.ts) | a reusable feature loop with its own CLI flags |

## Docs

- [docs/concepts.md](docs/concepts.md) — the memory model and the three loop shapes (Converge, Sweep, Tend)
- [docs/patterns.md](docs/patterns.md) — copy-paste recipes: the loop shapes, feedback tiers, PR shipping, guards
- [docs/comparison.md](docs/comparison.md) — vs. Mastra and LangGraph
- [docs/helm.md](docs/helm.md) — the conversational harness and its driver eval
- [docs/semantic-records.md](docs/semantic-records.md) — the decision-stream contract behind `loops records`
- [skills/author-loop/SKILL.md](skills/author-loop/SKILL.md) — the authoring guide an agent reads to compose a loop

## Develop

```bash
git clone https://github.com/jonny981/loops.git && cd loops && npm install
npm test               # vitest: offline, deterministic via the mock engine
npm run typecheck      # tsc --noEmit
node bin/loops.mjs --help
```

Runs from a checkout with no build step (the CLI executes the TypeScript source via [`tsx`](https://github.com/privatenumber/tsx)). Status: alpha — the API can break on a minor bump; [CHANGELOG.md](CHANGELOG.md) records what each version added or broke.

Contributions welcome. Open an issue to discuss anything substantial first. Keep the core focused: resist adding node types or configuration that don't earn their place.

## License

[MIT](./LICENSE)
