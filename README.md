<p align="center">
  <img src="assets/logo.png" alt="loops" width="320">
</p>

<p align="center">
  <strong>Stop prompting agents. Write the loop that prompts them. Make "done" mean <em>converged</em>, not <em>claimed</em>.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@loops-adk/core"><img src="https://img.shields.io/npm/v/@loops-adk/core" alt="npm"></a>
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="status: alpha">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%3E%3D20-3c873a" alt="node &gt;=20">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT">
</p>

`loops` runs AI agents in **convergence loops**: an agent does a bit of work with a fresh context, a gate *you* define checks the result, and if it's not done, it goes again. Loops and DAGs nest freely, any model runs behind a one-method interface, and progress lives in git — not a chat transcript.

```bash
npm i @loops-adk/core   # Node >= 20
```

## A loop in 30 seconds

```ts
import { loop, agentJob, commandSucceeds, agentCheck } from '@loops-adk/core';

// Keep working until the tests pass AND a judge agrees it matches intent.
export default loop({
  name: 'build-feature',
  max: 20,
  body: agentJob({
    prompt: (c) => `Iteration ${c.iteration}: make concrete progress on TASK.md.`,
    ground: true, // read the commit log + this run's scratch files before working
  }),
  until: [
    commandSucceeds('npm', ['test']), // ground truth
    agentCheck({ question: 'Does it match TASK.md?', threshold: 0.85 }), // intent
  ],
  commit: { subject: 'feat: TASK.md' }, // one milestone commit when it converges
});
```

```bash
loops validate feature.loop.ts   # offline pre-flight: prints the loop's shape, zero spend
loops run feature.loop.ts        # run it (live TUI; --no-tui or --json for headless)
```

Three ideas make this work:

1. **A real done-check.** "Ask the model if it's finished" lets the model grade its own homework. A gate pairs a deterministic signal (the tests genuinely pass) with a separate judge in its own context.
2. **A fresh context every turn.** Long-running agents rot as their history balloons. Each iteration starts clean; progress accumulates in the workspace — files and git commits — not the transcript.
3. **Git is the memory.** Fresh context alone would mean amnesia. The loop writes decisions to commit bodies as work converges and reads them back before the next turn. No vector store, no database, nothing to sync.

## Show me more

Everything below is a `Job` — `loop()` returns one, `dag()` returns one — so they nest both ways with no special cases. Runnable versions of all of these live in [`examples/`](examples/).

### A DAG with a loop inside — and a jury at the gate

A DAG node can be a whole convergence loop. And where the stakes are high, don't trust one judge: `quorum` demands k-of-n independent verdicts, and any judge can run on a different model — or a different vendor.

```ts
import { dag, loop, agentJob, agentCheck, commandSucceeds, quorum, gateJob } from '@loops-adk/core';

export default dag({
  name: 'ship-feature',
  nodes: {
    research: agentJob({ label: 'research', prompt: 'Research the task; write findings to NOTES.md.' }),

    // This node is a loop: iterate until tests pass and the work is complete.
    implement: {
      needs: ['research'],
      job: loop({
        name: 'implement',
        max: 10,
        body: agentJob({ prompt: (c) => `Implement increment ${c.iteration} from NOTES.md.` }),
        until: [
          commandSucceeds('npm', ['test']),
          agentCheck({ question: 'Is every increment in NOTES.md implemented?', threshold: 0.85 }),
        ],
      }),
    },

    // Shipping requires 2-of-3 independent judges to agree.
    review: {
      needs: ['implement'],
      job: gateJob('review', quorum(2,
        agentCheck({ question: 'Is it correct and complete?', model: 'opus' }),
        agentCheck({ question: 'Would this pass a strict code review?', model: 'sonnet' }),
        agentCheck({ question: 'Challenge it: what breaks?', engine: 'codex' }), // different vendor
      )),
    },
  },
});
```

Runnable: [`examples/dag-pipeline.loop.ts`](examples/dag-pipeline.loop.ts)

### A loop with a DAG inside

The body of a loop can be a multi-step pipeline. Each iteration re-runs the whole pipeline with a fresh context until the release gate clears.

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

### Adversarial review with kickbacks

A `review` runs when the gate is met. A rejection doesn't end the run — it re-enters the loop, and the reviewers' findings arrive in the next iteration's prompt (`consumeFeedback`). Put the adversarial seat on a different vendor's model so the worker and its reviewer don't share blind spots.

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
  review, // a rejection re-enters the loop with the findings attached
});
```

In a DAG, feedback can be surgical: `revisionRequest({ target, findings })` kicks work back to a named upstream node and re-runs the dirty subgraph, bounded by `maxKickbacks`. Runnable: [`examples/feedback-pipeline.loop.ts`](examples/feedback-pipeline.loop.ts), and [`examples/build-service.loop.ts`](examples/build-service.loop.ts) for a four-engineer team with a five-lens review battery.

## Core concepts

One universal unit of work, two supporting types:

```ts
type Job = (ctx: JobContext) => Promise<Outcome>;                        // a unit of work, any size
type Condition = (ctx, last) => Promise<{ met; reason; confidence? }>;   // a yes/no gate
interface Engine { run(req, onEvent, signal): Promise<AgentResult> }     // where an agent turn runs
```

`loop()` and `dag()` both return a `Job`, so nesting is the absence of a special case, not a feature. `sequence`, `parallel`, and `pipeline` are sugar over `dag`. A loop's terminal status is `pass · fail · exhausted · aborted · paused` (CLI exit codes `0 · 1 · 2 · 130 · 75`).

### Conditions: what "done" means

`start` / `until` / `stopOn` take one condition or many, freely mixing deterministic predicates and agent judges (arrays are AND; wrap in `any(...)` for OR). Prefer the mixed form — a model's self-reported confidence is a weak signal, so treat it as a guard on *intent* with a deterministic check as the *truth*.

- **Deterministic**: `commandSucceeds`, `predicate`, `all` / `any` / `not`
- **Judges**: `agentCheck` (with `dimensions` scored on the geometric mean, so one weak dimension drags the verdict down), `quorum(k, ...judges)` for k-of-n juries. A missing confidence scores as 0 — the gate fails closed.
- **Hardening at zero model cost**: `ratchet` (a metric may only improve), `writeScope` (changes must stay in declared lanes), `sampled` (run an expensive judge on a deterministic sample of iterations). Recipes in [docs/patterns.md](docs/patterns.md#hardening-gates--keep-the-loop-honest-without-spending-a-model-call).

A failing gate briefs the next attempt: its diagnostic evidence (failing test output, a judge's findings) is handed to the next iteration as `ctx.lastGate`, so a fresh context reads *why* it failed instead of re-discovering it.

### Engines: bring any model

The loop only ever touches the one-method `Engine` interface, so a reviewer can run on a genuinely different model than the worker.

| name            | backend                           | notes                                                        |
| --------------- | --------------------------------- | ------------------------------------------------------------ |
| `claude-cli`    | `claude` subprocess               | uses host Claude auth, no key                                |
| `agent-sdk`     | `@anthropic-ai/claude-agent-sdk`  | fresh `query()` per call                                     |
| `anthropic-api` | `@anthropic-ai/sdk`               | token streaming; cheapest for judges; needs a key            |
| `codex`         | `codex exec` subprocess           | a different vendor behind the same interface                 |
| `mock`          | scripted, offline                 | for tests and examples                                       |

Bring your own in ~10 lines — implement `run`, register a name:

```ts
const myEngine: Engine = {
  name: 'my-provider',
  async run(req, onEvent, signal) {
    return { text, usage: { inputTokens, outputTokens }, model: req.model ?? 'x' };
  },
};
await run(job, { engine: 'my-provider', engines: { 'my-provider': myEngine } });
```

`fallbackEngine(['claude-cli', 'codex'])` reroutes around a dead lane (bad key, missing binary) and latches it; `loops preflight` proves each lane live with one tiny turn before iteration 1 spends anything.

### Memory: the Ledger

Fresh context kills rot; the **Ledger** prevents amnesia. Three tiers, all in git:

- **Scratch files** (`.loops/ledger.md`, `.loops/prompt.md`): working memory and a handoff for the work in flight, auto-captured from grounded turns.
- **Milestone commits**: when a loop converges, `commit:` composes one structured commit body — the *why* welded to the diff — and clears the scratch files.
- **Grounding**: `ground: true` prepends the recent commit log and scratch files to the next turn's prompt. `ground: { retrieve: true }` has a cheap model select the relevant commits instead; `consolidateJob` folds a long history into a bounded, decision-preserving record.

`pullRequestJob` / `mergeJob` keep a PR body as a consolidation of the branch, so the reasoning survives a squash merge. The full model — and where memory helps vs. where it's a tax — is in [docs/concepts.md](docs/concepts.md), with an ablation in [bench/RESULTS.md](bench/RESULTS.md).

### Keeping runs bounded

Three independent hard stops, plus a pause that only a person lifts:

```ts
loop({
  name: 'build',
  body,
  until: commandSucceeds('npm', ['test']),
  max: 50,        // caps attempts
  noProgress: 3,  // exhausts after 3 iterations reaching no new state (novelty, not churn)
});
await run(job, { budget: 2_000_000 }); // caps tokens; engine calls refuse past it
```

- A **rate limit, quota, or hit budget** pauses the run (exit 75) with a ready-to-paste resume command; `--checkpoint` / `--resume` continue warm, restoring completed green DAG nodes.
- **`humanGate({ name: 'prod-approval' })`** holds the run at a named checkpoint until a person re-runs with `--ack prod-approval` — for the steps that must not proceed on any model's say-so.

### Parallelism: worktrees and tournaments

Parallel writers never collide: `isolation: 'worktree'` gives each DAG node its own branch and git worktree, landed back with a `--no-ff` merge on pass; `isolated(job)` is the same boundary as a composable wrapper, for a loop that discovers each unit of work at runtime. `tournament()` races N candidate approaches in isolated worktrees, judges them, and lands only the winner. `withEnv(overlay, job)` pins env vars over a subtree — and pinned values are scrubbed from all captured output, so a credential handed to a gate never lands in a log.

### Environments: gate on the running thing

`commandSucceeds('npm', ['test'])` checks files on disk; an **Environment** brings up the running thing (a local Docker stack, a per-branch cloud preview) so `until` can gate on live behavior — the handle's env vars (e.g. `BASE_URL`) are injected into gate commands. Adapters for command-line IaC tools, sst, and Docker Compose ship as opt-in subpaths.

## The CLI

```bash
loops run feature.loop.ts                 # run a definition file (live TUI)
loops run feature.loop.ts --no-tui        # plain logs        --json  # NDJSON events
loops validate feature.loop.ts            # offline pre-flight: loads + prints the shape, zero spend
loops describe feature.loop.ts --json     # machine-readable shape for agents
loops preflight -e claude-cli -e codex    # prove each engine lane live (a few tokens)

# no file needed — the standard worker → until → review loop from flags:
loops run --prompt "Implement TASK.md" --engine claude-cli \
  --until "Fully implemented with passing tests?" --threshold 0.85 --max 20
```

Supervision is file-based — no daemon, no socket:

```bash
loops run build.loop.ts --supervise   # registers under ~/.loops/runs/
loops list                            # every supervised run, with state
loops status <runId>                  # where it is + what's blocking it
loops tail <runId>                    # stream events live
loops records <runId> --kind revision # the semantic decision stream, filtered
```

`loops helm` puts a driver model in front of all of it: plain English in, strictly-validated intents out, deterministic code executing them ([docs/helm.md](docs/helm.md)).

Recipes can declare their own CLI flags with `defineParams` (values arrive on `ctx.params`), and a recipe-adjacent `loops.config.ts` holds project defaults and profiles. `loops init <dir>` scaffolds a new recipe folder.

> `loops run <file>` **imports and executes** that file's module, like `node <file>`. Only run definition files you trust.

## What loops is (and isn't)

`loops` is a fresh-context loop primitive, not a durable workflow engine. For long-lived replay, embed a `loops` job as a step inside Temporal, LangGraph, or Mastra. The scheduler that fires a loop belongs in cron or CI; acting in external tools is the agent's own job through its tools. `loops` is the body of the loop.

The in-depth comparison with Mastra and LangGraph — dimension by dimension — is in [docs/comparison.md](docs/comparison.md).

## Examples

| Example | Shows |
| --- | --- |
| [`simple-poll.loop.ts`](examples/simple-poll.loop.ts) | the smallest loop; offline, no key (`npm run example:poll`) |
| [`confidence-gate.loop.ts`](examples/confidence-gate.loop.ts) | deterministic + judge gates together |
| [`dag-pipeline.loop.ts`](examples/dag-pipeline.loop.ts) | a DAG with a loop node and a quorum gate |
| [`converge-review.loop.ts`](examples/converge-review.loop.ts) | review rejection re-entering the loop; offline |
| [`feedback-pipeline.loop.ts`](examples/feedback-pipeline.loop.ts) | surgical kickback between DAG stages |
| [`build-service.loop.ts`](examples/build-service.loop.ts) | a four-engineer team with a five-lens, two-vendor review battery |
| [`ship-pr.loop.ts`](examples/ship-pr.loop.ts) | push → PR → gated squash-merge that preserves the Ledger |
| [`stall-demo.loop.ts`](examples/stall-demo.loop.ts) | no-progress detection ending a doomed loop (`npm run example:stall`) |
| [`feature-dev.ts`](examples/feature-dev.ts) | a reusable feature loop wrapped in Commander flags |

## Docs

- [docs/concepts.md](docs/concepts.md) — the memory model, the three loop archetypes (Converge, Sweep, Tend), where the lift shows up
- [docs/patterns.md](docs/patterns.md) — copy-paste recipes: the archetypes, feedback tiers, PR shipping, hardening gates
- [docs/comparison.md](docs/comparison.md) — vs. Mastra and LangGraph, in depth
- [docs/helm.md](docs/helm.md) — the conversational harness and its driver eval
- [docs/semantic-records.md](docs/semantic-records.md) — the versioned decision-stream contract behind `loops records`
- [skills/author-loop/SKILL.md](skills/author-loop/SKILL.md) — the authoring guide an agent reads to compose a loop; supervision skills in [`skills/`](skills/)

## Develop

```bash
git clone https://github.com/jonny981/loops.git && cd loops && npm install
npm test               # vitest: offline, deterministic via the mock engine
npm run typecheck      # tsc --noEmit
node bin/loops.mjs --help
```

Runs from a checkout with no build step (the CLI executes the TypeScript source via [`tsx`](https://github.com/privatenumber/tsx)). **Status: alpha** — the API can still break on a minor bump; [CHANGELOG.md](CHANGELOG.md) records what each version added or broke.

Contributions welcome. Open an issue to discuss anything substantial first. Keep the core focused: resist adding node types or configuration that don't earn their place.

## License

[MIT](./LICENSE)
