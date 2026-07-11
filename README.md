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

`loops` is a library for building agentic workflows that converge on work that is *actually* done. The unit is a loop: an agent does a bit of work with a fresh context, a gate _you_ define checks the result, and if it is not done it goes again, so you write the loop once and it drives the run rather than prompting by hand. Because `loop()` and `dag()` both return the same `Job`, that unit scales without a new abstraction, from a single retry loop to a nested, multi-agent team that builds a whole service, run against any model behind a one-method `Engine` and watched in a live terminal UI.

Every iteration runs with a **fresh context**, so a long run never rots. Progress accumulates in **git, not the chat transcript**: the agent forgets between turns, the repository does not. The loop stops only when the gate clears: a deterministic check (the tests genuinely pass) alongside a separate judge in its own context, so the model that did the work is never the one that grades it. That gate is what keeps a loop from declaring itself finished on a half-built job.

Where most "agent memory" recalls a _conversation_, this keeps your _decisions_ consistent across long work. Git is the substrate, with no extra architecture: no vector database, no embeddings, no index to sync or let go stale. The discipline is what makes it memory and not just history. The loop persists curated decisions to commit bodies deterministically as work converges, and reads them back deliberately (recent, selected, or consolidated), never by pasting the whole log into a prompt. **Git is the memory.**

A loop is a single file:

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

## Features

A loop is easy to start and hard to keep on track. What decides whether `loops` earns its cost is a set of parts that share one substrate (git and the workspace), one unit of work (the `Job`), and one control model (conditions and outcomes). Not separate tools bolted together, which is why they nest without a special case.

- **Curated memory on git, no extra architecture.** Decisions persist to commit bodies deterministically as work converges and are read back deliberately (recent, selected, or consolidated). No vector store, no embeddings, no side database to sync. ([Ledger](#ledger-memory-built-on-git))
- **Nested workflows from two primitives.** `loop()` and `dag()` both return a `Job`, so a loop inside a dag inside a loop composes to any depth. ([Composition](#composition-loops-and-dags))
- **Multi-agent orchestration without context rot.** Every turn runs on a fresh context; a team coordinates through the workspace and the Ledger, never a ballooning transcript.
- **Parallelism without collisions.** `isolation: 'worktree'` gives each writer its own branch and worktree, landed back on pass with a `--no-ff` merge; `tournament` races N approaches in isolated worktrees, judges them, and keeps only the winner. ([Composition](#composition-loops-and-dags))
- **Deterministic gates for repeatable workflows.** A real check (`commandSucceeds`) plus a judge (`agentCheck`), hardened by k-of-n `quorum` and a rubric that fails closed, so "done" is reproducible, not a self-report. ([Conditions](#conditions))
- **Environments: gate on the running thing.** A third provider axis beside the engine (where the agent thinks) and the workspace (where the code lives): bring up a local stack or per-branch preview so `until` tests what actually runs, not just files on disk. ([Environments](#environments-test-the-running-thing))
- **Safe, scoped env injection.** `withEnv` pins variables over a job subtree without mutating the global `process.env`, layered with clear precedence (a live stack's vars, a subtree overlay, a per-call `env`). Values pinned through any layer are scrubbed from captured gate output, judge replies, and run records, so a credential handed to a gate never lands in the log. ([withEnv](#pinning-env-vars-withenv))
- **Bounded and resumable.** `max` caps iterations, `budget` caps tokens (a stop the engine refuses to cross), and stall detection ends a loop that reaches no new state; a rate limit, quota, or hit budget pauses and resumes warm from a checkpoint instead of failing. ([No progress](#no-progress-the-third-hard-stop), [resume](#budget-records-resume))
- **Any model, any harness.** The agent launch touches only a one-method `Engine`, so a reviewer runs on a genuinely different model than the worker. The model that did the work never grades it. ([Engines](#engines-bring-any-model))
- **Ship via PR, memory survives the squash.** `pullRequestJob`/`mergeJob` keep the PR body a consolidation of the branch, so a squash merge doesn't flatten the Ledger into a list of subject lines. ([Ledger](#ledger-memory-built-on-git))
- **Human-in-the-loop gates.** `humanGate` holds the run at a named checkpoint until a person acknowledges it, for the steps that must not proceed on any model's say-so. ([Human gates](#human-gates-a-pause-only-a-person-lifts))
- **First-class agent UX.** `validate`/`describe` print a loop's shape before it spends a token; `--supervise`, `list`/`status`/`tail`, and the semantic `records` stream make a running fleet introspectable; a live TUI renders it. ([Supervise](#supervise-a-running-loop))
- **A conversational harness.** `loops helm` puts a driver model in front of it all: plain English in, strictly-validated intents out, deterministic code executing them — with a driver eval that measures which models can hold the wheel. ([Helm](#helm-talk-to-your-loops), [docs/helm.md](docs/helm.md))
- **Hardening gates at zero model cost.** `ratchet` (a metric may only improve, against a baseline the loop cannot loosen), `writeScope` (declared write lanes), `sampled` (reproducible sampling for expensive judges). ([Conditions](#conditions))
- **Dead-lane resilience and honest receipts.** `fallbackEngine` reroutes around a dead key/binary/model and latches it; `loops preflight` proves each lane live before iteration 1 spends; `--prices` turns measured usage into a receipt with a labeled reconstructed baseline, never a silent $0. ([Engines](#engines-bring-any-model))
- **Curated grounding, and a ladder it may steer.** Declare `sources` beside the commit log; a cheap curator composes the brief and keeps only what helps; optionally it picks an engine rung from a declared ladder — fail-closed, inert by default, and A/B-able with one flag per layer (`--no-curate`, `--no-ladder`). ([Curated grounding](#curated-grounding-and-the-ladder))

Two things are deliberately out of scope. The heartbeat that fires a loop on a schedule belongs in cron, GitHub Actions, or a workflow engine, with a `loops` job inside. Acting in external tools is the agent's own job through its tools. `loops` is the body of the loop.

## Install

```bash
npm i @loops-adk/core      # Node >= 20
```

Write a loop in a `.loop.ts` file, then run it. `loops run` works from any repo that has the package installed:

```bash
loops validate your-feature.loop.ts   # offline pre-flight: prints the loop's shape, no model calls
loops run your-feature.loop.ts         # run it (live TUI; add --no-tui or --json for headless)
```

The full CLI, the flags-only mode (no file), and the offline demo are in [Quick start](#quick-start) below.

## Quick start

**Flags mode**, the standard `worker → until → review` loop, no code:

```bash
loops run \
  --prompt "Continue implementing the feature in TASK.md; report what changed." \
  --engine claude-cli \
  --until "Is the feature fully implemented with passing tests?" --threshold 0.85 \
  --review "Does it pass a strict review with no blockers?" \
  --max 20
```

**Definition-file mode**: full power and nesting. A `.loop.ts` file `export default`s a `Job`:

```bash
loops validate examples/confidence-gate.loop.ts      # offline pre-flight: load + print the shape, no model calls
loops describe examples/confidence-gate.loop.ts      # print the loop's shape (gate, body, nodes) without running
loops describe examples/confidence-gate.loop.ts --json # machine-readable shape for agents
loops run examples/confidence-gate.loop.ts           # live Ink TUI
loops run examples/confidence-gate.loop.ts --no-tui  # plain streamed logs
loops run examples/confidence-gate.loop.ts --json    # NDJSON event stream
```

> `loops run <file>` **imports and executes** that file's module, like `node <file>`. Only run definition files you trust.

**Authoring is agent-native.** Both commands work from any repo, including one that consumes `loops` as a submodule or dependency (the recipe's folder just needs an ES module scope, which such repos already have). `loops validate <file>` is the cheap, no-model pre-flight an agent runs before `loops run`: it loads the loop, reports a fix-oriented error if anything is wrong, and prints the loop's shape (its gate, body, and dag nodes), all without spending a single agent turn. `loops describe <file>` prints that same shape on its own, so an agent can see exactly what it just authored. The authoring guide an agent reads to compose a loop is [`skills/author-loop/SKILL.md`](skills/author-loop/SKILL.md).

The end-to-end agent workflow, from authoring through reading a supervised run's decisions back as structured records rather than a raw event stream:

```bash
loops validate feature.loop.ts --json                 # pre-flight: loads, no spend
loops describe feature.loop.ts --json                 # the shape, incl. each agent node's contract
loops run feature.loop.ts --no-tui --supervise        # run it, registered for observation
loops list                                            # find the runId
loops tail <runId>                                    # follow live events
loops records <runId> --kind revision --path ship/implementation --json  # the semantic decision stream, filtered
```

Two supervision skills go deeper: [`skills/supervise-loop-run/SKILL.md`](skills/supervise-loop-run/SKILL.md) (monitor a run) and [`skills/design-agent-team/SKILL.md`](skills/design-agent-team/SKILL.md) (compose a specialist team).

**Feature-development example**: [`examples/feature-dev.ts`](examples/feature-dev.ts)
wraps a reusable feature loop with Commander flags, so recipe inputs are normal
CLI arguments rather than environment setup.

```bash
npx tsx examples/feature-dev.ts --validate --feature checkout-redesign
npx tsx examples/feature-dev.ts --describe-json --feature checkout-redesign
npx tsx examples/feature-dev.ts \
  --feature checkout-redesign \
  --engine codex \
  --adversarial-model opus \
  --live-agents \
  --supervise \
  --no-tui
```

The example is offline by default. With `--live-agents`, implementation and the
ordinary reviewers use `--engine` / `--main-model`; the adversarial reviewer uses
the opposite engine family by default (`codex` main => `claude-cli` adversarial,
Claude-family main => `codex` adversarial). Override that lane with
`--adversarial-engine` and `--adversarial-model`.

**Recipe parameters and run defaults**: a recipe can declare its own CLI flags
with `defineParams`, and those values arrive on `ctx.params`.

```ts
import { defineJob, defineParams, fnJob } from '@loops-adk/core';

export const params = defineParams({
  oem: { type: 'string', env: 'OEM', required: true, help: 'OEM name' },
  device: { type: 'choice', choices: ['battery', 'inverter'], default: 'battery' },
  skip: { type: 'string[]', default: [] },
  repoRoot: { type: 'string', defaultFrom: 'gitRoot' },
});

export default defineJob(
  fnJob('show-params', async (ctx) => ({
    status: 'pass',
    summary: JSON.stringify(ctx.params),
  })),
);
```

`loops run onboard.loop.ts --help` lists those recipe flags beside the built-in
flags. When a param declares `env`, CLI values are written before the recipe is
imported, so env-shaped graph labels and fan-out read the same value as
`ctx.params`.

A recipe-adjacent `loops.config.ts`, `.js`, `.mjs`, `.yaml`, or `.yml` file can
hold project defaults for boilerplate run flags plus recipe-owned tunables:

```ts
import { defineConfig } from '@loops-adk/core';

export default defineConfig({
  run: { supervise: true, tui: false, record: 'auto' },
  recipe: { reviewerThreshold: 0.9 },
  profiles: {
    live: { run: { permissionMode: 'bypassPermissions', defaultModel: 'claude-sonnet-5' } },
  },
});
```

Use it with `loops run onboard.loop.ts --profile live --oem Sigenergy`.
Recipes read custom tunables from `ctx.config.recipe`. `loops init <dir>`
creates the small ESM, TypeScript, config, and `.loops/` ignore scaffold for a
new recipe island.

**Offline demo** (no network, no key; uses the mock engine):

```bash
npm run example:poll
```

## From source

> **Status: alpha**, the API is still settling — [CHANGELOG.md](CHANGELOG.md) records what each version added or broke. To work on `loops` or run it from a checkout:

```bash
git clone https://github.com/jonny981/loops.git
cd loops
npm install
node bin/loops.mjs --help        # or: npm link  →  loops --help
```

Requires **Node ≥ 20**. Running from a checkout needs no build step: the CLI runs the TypeScript source directly through [`tsx`](https://github.com/privatenumber/tsx).

## Why loops?

Agents rarely nail it in one shot. The reliable pattern is a **convergence loop**: do a bit of work, check whether you're _actually_ done, and if not, go again. Two things make or break it, and `loops` is built around both:

- **A fresh context every turn.** Long-running agents rot as their history balloons. `loops` runs each iteration with a clean slate and lets progress accumulate where it belongs: in the **workspace** (files, git commits), not in a chat transcript. The loop carries only thin bookkeeping.
- **Memory in git, not in the transcript.** Fresh context alone would mean amnesia. **Ledger** (below) writes the _why_ to git as the work happens and reads it back before the next turn, so a clean slate is never a blank one.
- **A real done-check.** "Ask the model if it's finished" is the classic trap: the model grades its own homework. `loops` makes the gate a first-class value and lets you combine a **deterministic** signal (the tests genuinely pass) with a **separate judge**, so "done" means _converged_, not _claims to be_.

Everything else (DAGs, nesting, engines, budgets, the TUI) hangs off those ideas.

## Core idea: everything is a `Job`

There is one universal unit of work, and two supporting types:

```ts
type Job = (ctx: JobContext) => Promise<Outcome>; // a unit of work, any size
type Condition = (ctx, last) => Promise<{ met; reason; confidence? }>; // a yes/no gate
interface Engine {
  run(req, onEvent, signal): Promise<AgentResult>;
} // where an agent turn runs
```

- **`loop()` returns a `Job`**, so a loop nests by passing one as another's `body` or `review`.
- **`dag()` returns a `Job` too**, so loops and DAGs nest **both ways**: a DAG node can be a loop, a loop body can be a DAG.

Nesting is the absence of a special case, not a feature.

### `loop(config)`

```ts
loop({
  name: 'build-feature',
  body, // the Job run each iteration (fresh context); pass a loop()/dag() to nest
  start, // gate before iterating; unmet ⇒ aborted
  until, // checked after each body; met ⇒ stop (then review)
  stopOn, // hard early-exit each iteration; met ⇒ aborted
  review, // runs when until is met; non-pass re-enters the loop (folds back as ctx.lastReview)
  max, // iteration cap; reached without passing ⇒ exhausted
  noProgress, // stall out after n consecutive iterations with no observable progress
  maxReviewRestarts, // cap the worker/reviewer standoff independently of max
  delayMs, // delay between iterations (polling); interruptible by abort
  retry, // { onError: 'continue' | 'fail', maxConsecutive?, backoffMs? }
  onIteration,
  onComplete, // hooks (onComplete runs once, whatever the outcome)
});
```

With no `until`, a `pass` body ends the loop. Terminal status is one of `pass · fail · exhausted · aborted · paused` (CLI exit codes `0 · 1 · 2 · 130 · 75`). `paused` is a resumable stop: a hit limit ([Rate limits, quotas, and budgets](#rate-limits-quotas-and-budgets-wait-or-resume)) or an unacknowledged [human gate](#human-gates-a-pause-only-a-person-lifts).

## What `loops` is (and isn't)

`loops` is a **fresh-context loop primitive**, not a durable workflow engine. The design bet is that **the workspace is the state**: progress _and its reasoning_ live in git (the Ledger), so each iteration can start clean and still know what came before. If the process dies mid-run, you re-run against the same workspace (the worktree holds the files, the scratch files hold the why, the log holds the milestones) and continue. You lose the bookkeeping, not the work.

It deliberately does **not** try to become a durable workflow engine. For long-lived replay, embed a `loops` job as a step inside [Temporal](https://temporal.io), [LangGraph](https://github.com/langchain-ai/langgraphjs), or [Mastra](https://mastra.ai). What it _does_ offer is the lightweight version that fits the workspace-is-state model: run records, state checkpoints, and checkpointed DAG resume for completed green nodes whose durable effects already live in the workspace.

| You want…                                          | Reach for…                          |
| -------------------------------------------------- | ----------------------------------- |
| Loop an agent to convergence with a real done-gate | **loops** (you're here)             |
| Durable, resumable, replayable workflows           | Temporal / LangGraph / Mastra       |
| One agent call with tool use                       | your provider's SDK directly        |

### How it compares, in depth

The two frameworks most often weighed against `loops` are [Mastra](https://mastra.ai) and [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview). Both are excellent at their layer: they **build and orchestrate agents**. `loops` sits differently: it **harnesses agents that already exist** (Claude Code, a rival vendor's CLI) and concentrates on the question both frameworks leave to a single LLM judge: how do you know the work is actually done?

| Dimension                | Mastra                                                                         | LangGraph                                                                    | `loops`                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Layer                    | full-stack TypeScript agent framework: agents, memory, server, Studio          | orchestration runtime: typed graphs over shared state                        | convergence-loop primitive over existing agent harnesses                                                                             |
| Unit of composition      | agent / workflow step (`createStep`)                                           | node over shared state channels                                              | `Job`: one async function. `loop()` and `dag()` both return one, so they nest both ways                                              |
| What executes a turn     | its own agent loop over 90+ model providers                                    | your functions calling models                                                | any `Engine`: Claude Code (CLI or SDK), a rival vendor's CLI, a raw API, an offline mock                                             |
| The done-check           | Goals (beta): one LLM judge, binary default scorer                             | evaluator-optimizer pattern: one structured-output judge, cap left to you    | deterministic signal + separate judge, scored dimensions (geometric mean), k-of-n quorum; a missing confidence fails closed          |
| Hard stops               | `maxRuns` (default 50)                                                         | bring your own                                                               | three independent stops: iteration cap, token budget, no-progress stall detection                                                    |
| State between iterations | conversation thread, optionally compressed by observer agents (database)       | checkpointed state channels (database)                                       | the workspace itself: files and git. Every iteration starts with a fresh context                                                     |
| Crash recovery           | durable agents (beta): workflow-wrapped loop with event replay                 | checkpointer with `sync` / `async` / `exit` durability modes                 | durable effects land in the workspace as they happen; `--checkpoint` restores finished DAG nodes                                     |
| Human in the loop        | typed suspend / resume                                                         | `interrupt()` / `Command(resume)`; the node re-runs from the top             | `humanGate`: exit 75, resume with `--ack`; the pause propagates to the root                                                          |
| Long-term memory         | four-layer memory with vector recall (database)                                | namespaced KV store with semantic search (database)                          | git: Ledger commits, decision-preserving consolidation, curated grounding. No service; survives a squash merge                       |
| Hardening                | input/output guardrails and processors                                         | middleware and hooks                                                         | `ratchet` (a metric may only improve), `writeScope` (declared write lanes), `sampled` (deterministic judge sampling); all fail closed |
| Cost accounting          | cost metrics derived from traces                                               | LangSmith tracing                                                            | cost receipts: never silently \$0, unpriced models named, the baseline explicitly labeled a reconstruction                           |
| Provider failure         | model router                                                                   | swap models per node                                                         | classified failure taxonomy, fallback chains with latched dead lanes, `loops preflight`                                              |
| Parallel fan-out         | `.parallel()` / `.foreach()`                                                   | `Send` API                                                                   | `dag()` / `tournament()`: isolated git worktrees, a judge lands the winner back                                                      |
| Where evals live         | beside the run: `runEvals` in CI, sampled scorers in production                | LangSmith                                                                    | inside the run: the eval **is** the loop's exit condition                                                                            |
| Services required        | storage backend, plus a server for the full story                              | a checkpointer (database-backed for real persistence)                        | Node ≥ 20 and git                                                                                                                    |

**Where the real differences are.** Most rows are parity on a different substrate: the frameworks persist state in a database, `loops` persists it in your repo. Three rows carry the design bet:

1. **The done-check.** Mastra's Goals and LangGraph's canonical evaluator-optimizer both gate their loop with a single LLM judge by default. `loops` treats that as the failure mode to design against: pair a deterministic signal with a separate judge, open the verdict on the weakest scored dimension, demand k-of-n agreement where it matters, and score a missing confidence as zero.
2. **Fresh context, durable workspace.** The frameworks accumulate a conversation thread and then manage its growth (trimming, summarising, observer agents). `loops` never lets the transcript become the state: each iteration starts clean and reads the why back from git.
3. **Engines are whole agents.** The frameworks call models and rebuild the tooling around them. A `loops` engine is a complete agent harness, tools and permissions included, swappable per fallback lane or ladder rung.

**Where they win.** Hosted observability UIs (Studio, LangSmith), deployment platforms, HTTP serving, RAG pipelines, voice, channel integrations. `loops` does not compete there: embed a `loops` job inside them, as above. Supervision here is deliberately local-first: JSONL run records, `loops list` / `status` / `tail` / `records`, and [helm](#helm-talk-to-your-loops).

Framework claims follow each project's own documentation (the Mastra core 1.4x line, the LangGraph 1.x line); check theirs for current state.

## Conditions

`start` / `until` / `stopOn` accept **one item or many**, freely mixing deterministic predicates and agent judges. Arrays are `all` by default (wrap in `any(...)` for or):

```ts
until: [
  commandSucceeds('npm', ['test']), // deterministic ground truth
  agentCheck({ question: 'Good enough to ship?', threshold: 0.9 }), // agent-validated intent
];
```

Prefer this mixed form over a lone judge. A model's self-reported confidence is a weak, poorly-calibrated signal. Treat it as a guard on _intent_, with a deterministic check as the _truth_. Two ways to harden the judge itself:

```ts
// k-of-n jury: consensus, not one number
quorum(2, judgeA, judgeB, judgeC);

// one judge, multiple dimensions: opens on the GEOMETRIC MEAN,
// so a single weak dimension drags the verdict down
agentCheck({
  question: 'Ready to ship?',
  threshold: 0.8,
  dimensions: ['intent match', 'evidence quality', 'outcome coherence'],
});
```

**Builders:** `predicate`, `bodyPassed`, `minConfidence`, `commandSucceeds` (a shell command exits 0), `all`, `any`, `not`, `quorum` (k-of-n), `agentCheck` (model judge), `always`, `never`, and `gateJob` (lift a condition into a `Job`, e.g. a reviewer).

Three **hardening gates** close the ways an agent can technically satisfy a gate while betraying it, at zero model cost: `ratchet` (a measured metric may only hold or improve, against a runtime-owned baseline written only in the improving direction — the loop can't loosen its own bar), `writeScope` (every changed file must match a declared glob — lane-keeping for nodes sharing a repo), and `sampled` (run an expensive judge on a deterministic sha256 bucket of iterations, so a `quorum` at `rate: 0.25` really runs every ~4th iteration, reproducibly). Recipes for each are in [docs/patterns.md](docs/patterns.md#hardening-gates--keep-the-loop-honest-without-spending-a-model-call).

### The gate briefs the next attempt

A failing gate is not just "no". The evidence-bearing conditions — `commandSucceeds`, `agentCheck`, and the combinators that wrap them — carry their verbatim diagnostic evidence on `ConditionResult.output` (a failing command's stdout/stderr, a judge's full findings), truncated and secret-scrubbed, and the loop hands the previous iteration's `until` verdict to the next body as `ctx.lastGate`. The point: the next fresh context reads **why** the gate failed instead of spending a turn re-running it to find out.

```ts
loop({
  name: 'build',
  body: agentJob({
    prompt: (c) =>
      c.lastGate && !c.lastGate.met
        ? `The gate failed:\n${c.lastGate.output ?? c.lastGate.reason}\n\nFix exactly that.`
        : 'Implement the feature in TASK.md.',
  }),
  until: commandSucceeds('npm', ['test']),
  max: 10,
});
```

`gateJob` lifts the same evidence across the Job boundary (it rides `Outcome.data`). The judge itself is tunable: `agentCheck` takes `cwd` (a tool-using judge that must read the artifact it rules on), `timeoutMs`, and `maxReasonChars` (the excerpt cap on a `confidenceTag` reason; the full findings always travel via `output`).

## No progress: the third hard stop

The gate detects success; nothing above detects a loop that is failing to converge. `max` bounds the attempt count and `budget` bounds the cost, but both fire only after the waste, and neither can tell slow-but-real convergence from the same failure five turns running. `noProgress` is that sensor: the loop ends `exhausted` once `n` consecutive iterations reach no state the run has not already seen.

```ts
loop({
  name: 'build',
  body: agentJob({ prompt: '…', ground: true }),
  until: commandSucceeds('npm', ['test']),
  max: 50, // generous runway for hard work…
  noProgress: 3, // …because the doomed case exits after 3 flat iterations
});
```

Progress means **novelty**, not change. An iteration counts as progress when any evidence channel reaches something new:

- **the workspace fingerprint** (HEAD, pending diff, untracked content) is a state this run has never visited, so an agent oscillating A→B→A gets no credit for the return trip;
- **the gate confidence** beats its previous best by `minConfidenceDelta` (default 0.02), a high-water mark, so judge jitter is not progress but slow steady improvement accumulates until it clears the bar;
- **a custom `signal`** returns a value not already seen, the escape hatch for progress the worktree cannot show (a queue length, a passing-test count): `noProgress: { window: 3, signal: (ctx) => queueDepth() }`;
- **(opt-in) the failing gate's output** is new: `noProgress: { window: 3, gate: true }` fingerprints the failing `until` gate's diagnostic `output`, so the same failure signature repeating is itself stall evidence. For deterministic gates whose output is stable across identical failures (a judge's prose varies between identical verdicts, so leave it off for agent gates); it requires an explicit `until`, since without one there is no gate verdict to fingerprint.

The default is conservative: one channel showing novelty keeps the loop alive, so real-but-slow work is never cut short. And the exit is a diagnosis, not just a stop: the outcome carries `Outcome.stall` (the flat iterations, the repeated gate reason, the per-channel evidence) and a `loop:stall` event fires for supervisors, so "stalled since iteration 5 on the same scope error" replaces "reached max iterations" and a fleet watcher can re-brief the loop instead of shrugging at it. This is also what makes a generous `max` safe to grant: the safety net and the runway stop being the same number.

Off by default, like `commit`: a polling loop legitimately makes no progress until the outside world changes. Flags mode: `--stall-after <n>`. Offline demo: `npm run example:stall`.

## Ledger: memory built on git

Fresh context kills _rot_; on its own it would cause _amnesia_. **Ledger** is the core that closes the gap: the loop writes its reasoning to git as it works and reads it back before the next turn. No parallel database, no vector store; git _is_ the index: nothing to build, embed, sync, or let go stale (the commit log can't drift out of sync with the code; it _is_ the code's history). (`Ledger` is the engine; the **commit log** is the durable memory it reads and writes; `.loops/ledger.md` and `.loops/prompt.md` are the live scratch files for work in flight.)

The three tiers below form a progression. The scratch files record what failed and what was tried. The gate turns a fix into a verified fact. The milestone commit distills it into a durable decision. Grounding lets the next turn read that decision instead of re-deriving it.

- **Scratch files: working memory and a handoff.** Two gitignored files carry a unit of work forward. `.loops/ledger.md` is **working memory** for the agent(s) doing the work now: the harness auto-captures each grounded turn (the reasoning + a summary of actions), so the why is recorded even when no single agent holds it all at the end, and fanned-out peers share it. `.loops/prompt.md` is the **handoff** the agent distils for whoever continues: intent, alternatives ruled out, constraints, what is left. Grounding injects both into the next context; the commit body is the handoff plus a compacted working log.

  ```ts
  appendPrompt(ctx.workspace, { heading: 'Why', body: 'tried a token refresh; the gate still failed on scope' });
  ```

  The handoff is a parseable contract, not a convention: a grounded turn closes its reply with the `HANDOFF_MARK` marker (`===HANDOFF===`), and `parseHandoff(text)` splits the reply into `{ work, handoff }` — the same split the auto-capture uses. An `agentJob`'s `outcome` mapper receives that split as its third argument, so decision-token parsing reads `parts.work` and a token restated inside the handoff's sections cannot false-score:

  ```ts
  agentJob({ prompt, role: 'reader', outcome: (text) => ({ status: confidenceFromText(text) >= 0.9 ? 'pass' : 'fail' }) });
  ```

  Use `lastDecisionLine(text, token, values)` and `confidenceFromText(text)` for
  closing-line contracts; both ignore tokens restated inside the handoff block.

- **Milestone commits: crystallise it.** A commit is a _milestone_, not an iteration. When a loop converges, `commitJob` composes one structured body, the handoff plus a compacted working log (the **way**), welded to the diff (the **what**), then clears both scratch files. Turn it on with `commit:`; iterations stay durable in the workspace + scratch files, so the log holds only converged, reasoned-over checkpoints. Welded to its diff, a commit body is a permanent record any later agent can look back to, as far back as it wants. Finer milestones? Compose finer loops/nodes.

  ```ts
  loop({ name: 'build', body, until, commit: { subject: 'feat: the feature' } });
  ```

- **Grounding: read it back.** A fresh turn reads the recent committed commit log (past milestones) and this run's live scratch files (working memory + handoff), prepended to its prompt, so it knows what was already tried. The reach is **branch-local**: adjacent branches are in-flight and may never land, and the merge is where work becomes shared truth. `RunOptions.ground` (CLI `--ground`) sets the default for every `agentJob` in a run; a job's own `ground` — including an explicit `false` — wins.

  ```ts
  agentJob({ label: 'work', prompt: 'Continue the task.', ground: true });
  ```

  Grounded prompts are bounded by `ground.promptChars` (default 48000 chars).
  The task prompt and handoff instruction are kept first, then the live handoff,
  working memory, and committed context within the remaining budget. The scratch
  files are rolling buffers on disk, and the CLI clears them on a fresh
  non-resume run. CLI-backed engines receive prompts over stdin, not argv, so
  large bounded prompts do not hit the OS argument limit.

- **Scaling the read: retrieval, then consolidation.** Recent-N grounding is the default, but on a long, noisy log the relevant commit falls out of the window. `ground: { retrieve: true }` has a cheap model select the relevant commits by subject instead. Use it for long-horizon work. For an indefinite process, `consolidateJob` folds the history into a **decision-preserving consolidated ledger**: a bounded record that keeps every accrued decision verbatim (a naive progress summary loses the specifics), committed as a commit body (the coarse tier, grounded like any milestone, never a side file). Retrieval finds the _relevant_ past commits; consolidation keeps _all the decisions_ in bounded space: different jobs, both in the git grain.

  ```ts
  agentJob({ label: 'work', prompt: 'Continue.', ground: { retrieve: true } });
  ```

- **Ship via PR: survive the squash.** The commit log is the memory, but a **squash merge** collapses a branch's milestone bodies into one commit whose body defaults to a list of subject lines, the reasoning lost from the base branch. `pullRequestJob` closes that: it pushes the branch and opens (or idempotently updates) a PR whose body is the same `consolidate` fold scoped to this branch, kept current as milestones land. `mergeJob` then squash-merges with that synthesis as the commit body, gated on CI (`auto: true` hands the wait to GitHub; `when: forgeChecks()` is a synchronous gate). The host is the injectable `Forge` interface (the `gh` CLI by default), so it runs offline against a `MockForge`.

  ```ts
  sequence('ship', pullRequestJob({ base: 'main' }), mergeJob({ base: 'main', auto: true }));
  ```

The Ledger has **two faces**: _cross-iteration_ (recover from your own failed attempts in a retry loop) and _cross-node_ (honour an upstream node's decision a downstream agent could not otherwise know). Both need headroom. On one-shot, single-node work memory is only a tax; the lift shows up only once one attempt is not enough. For where it helps and where it doesn't, [docs/concepts.md](docs/concepts.md) has the discussion and [bench/RESULTS.md](bench/RESULTS.md) has the memory-on-vs-off ablation (run `npm run bench:compare` to reproduce).

### Curated grounding and the ladder

Grounding's progression, from "prepend the recent ledger" to "a cheap agent composes the right context". Three layers, each **inert unless the recipe opts in**, each with a run-level A/B switch so the claim can carry a receipt:

```ts
agentJob({
  prompt: (c) => `Iteration ${c.iteration}: make progress on the task.`,
  ground: {
    sources: ['TASK.md', 'docs/adr/*.md'],          // 1. declared context beside the commit log
    curate: { engine: 'anthropic-api', model: 'claude-haiku-4-5' }, // 2. one cheap turn composes a brief + keeps only the sources that help
  },
  ladder: [                                          // 3. declared rungs the same verdict may pick from, cheapest first
    { hint: 'cheap default lane' },                  //    rung 0 = the job's own engine — the lane used whenever routing is off
    { engine: 'codex', model: 'gpt-5.2', hint: 'hard multi-file work' },
  ],
})
```

The curator's verdict is parsed leniently (prose and fences tolerated) and validated strictly; anything unreadable **fails closed to plain grounding and rung 0** — a curator that can't be read never steers the run. It only ever picks from the declared ladder, never a lane outside it, and every decision lands in the event stream (`loops tail` shows `curate: brief 412 chars, 2 source(s), rung 1 (codex)`).

The A/B contract is one flag per layer, so the same recipe benchmarks with and without:

```bash
loops run feature.loop.ts --prices prices.json                 # curated + routed
loops run feature.loop.ts --prices prices.json --no-ladder     # curated, static lane
loops run feature.loop.ts --prices prices.json --no-curate --no-ladder  # plain grounding
```

Treat the ladder as an experiment until your own numbers say otherwise: the curation layer is the one with evidence behind it (context quality moves outcomes); dynamic model-picking has to beat a static per-role assignment on $/resolve before it earns a place in your recipe. That is exactly what the flags plus [`--prices`](#cost-receipts---prices-and-the-reconstructed-baseline) and [`bench/yardstick`](bench/yardstick/README.md) are for.

## Engines: bring any model

The agent launch only ever touches the `Engine` interface, so the loop knows nothing about your model, provider, or framework.

| name            | backend                          | notes                                                       |
| --------------- | -------------------------------- | ----------------------------------------------------------- |
| `codex`         | `codex exec` subprocess (`execa`) | fresh process per call; read-only unless `bypassPermissions` |
| `claude-cli`    | `claude` subprocess (`execa`)     | fresh process per call; uses host Claude auth, no key        |
| `agent-sdk`     | `@anthropic-ai/claude-agent-sdk`  | fresh `query()` per call; host Claude auth                   |
| `anthropic-api` | `@anthropic-ai/sdk`               | token-level streaming; cheapest for judges; needs a key      |
| `mock`          | scripted, offline                | for tests and examples                                      |

Select per-run (`--engine`, `RunOptions.engine`) or per-job/condition (`engine:` takes a name **or** a ready-made `Engine`). Bring your own in ~10 lines:

```ts
import { run, type Engine } from '@loops-adk/core';

const myEngine: Engine = {
  name: 'my-provider',
  async run(req, onEvent, signal) {
    // call any provider/framework; stream tokens via onEvent({ type: 'text', delta })
    return { text, usage: { inputTokens, outputTokens }, model: req.model ?? 'x' };
  },
};

await run(job, { engine: 'my-provider', engines: { 'my-provider': myEngine } });
```

That's the whole contract: implement `run`, register a name. A managed/durable runner could be a drop-in engine too.

`EngineOptions.minToolIntervalMs` puts a floor between consecutive tool executions, for backends that throttle bursty tool use. Only `agent-sdk` honors it, because only the SDK mediates tool calls in-process (an awaited PreToolUse hook). The subprocess engines (`claude-cli`, `codex`) execute tools autonomously and report them after the fact, and `anthropic-api` drives no tool loop, so all three ignore it: there is no interception point to pace at outside the SDK.

### Dead lanes: fallback chains and preflight

Because `Engine` is one method, "try the next provider when this one is dead" is just another engine — no runner support needed. `fallbackEngine` reroutes on **lane-dead** failures only (a bad key, an empty balance, a missing binary, an unknown model — the things that will not heal within a run) and latches a dead lane so it isn't retried fifty iterations in a row. Rate limits, quotas, and the token budget stay owned by the [`onLimit` policy](#rate-limits-quotas-and-budgets-wait-or-resume) — a fallback that silently swallowed a quota would bypass the wait/checkpoint machinery. Opt in via `on: ['quota']` if you genuinely want a quota to hop providers instead of pausing.

```ts
import { run, fallbackEngine } from '@loops-adk/core';

await run(job, {
  engines: { worker: fallbackEngine(['claude-cli', 'codex'], {
    onFallback: ({ from, to, failure }) => console.error(`lane ${from} died (${failure}) → ${to}`),
  }) },
  engine: 'worker',
});
```

`loops preflight` is the online counterpart to the offline `loops validate`: one deliberately tiny live turn per engine (a few tokens), through the same interface the run will use, so a dead lane surfaces **before** iteration 1 spends anything — classified (`auth | billing | missing-cli | model-unavailable | …`), so "your key is dead" and "the CLI isn't installed" are distinct, actionable answers.

```bash
loops validate feature.loop.ts        # offline: the recipe loads (zero spend)
loops preflight -e claude-cli -e codex # online: the lanes work (a few tokens)
loops run feature.loop.ts --supervise
```

Both are on the public surface too (`preflight`, `preflightEngine`, `classifyEngineFailure`).

### Cost receipts: `--prices` and the reconstructed baseline

Pass a price table and the exit summary prices the run's **measured** token usage per model. Prices are yours to supply (a JSON file; the library hardcodes none — stale prices are worse than no prices), a model with usage but no price entry is named instead of silently counted as $0, and `--baseline-model` adds the counterfactual: what the *same token stream* would have cost at a ceiling model's rates — always labeled a reconstruction, because it is one, not a measured alternative run.

```bash
loops run feature.loop.ts \
  --prices prices.json \                # { "claude-haiku-4-5": { "inputPerMTokUsd": 1, "outputPerMTokUsd": 5 }, ... }
  --baseline-model claude-opus-4-8      # "these exact tokens on opus would have been $X"
```

The same fold is a pure function on the public surface (`costReport(stats, prices, baselineModel)` → `RunResult.cost`), so a bench script or a fleet supervisor prices runs the same way the CLI does.

## Agents: define a specialist once

Instead of a wall of inline prompt, define each agent as a reusable, job-specific **`AgentDef`**: the persona and methodologies live in editable **markdown files**, the structure and types live in TypeScript. The `.ts` is the strongly-typed wrapper around the `.md`:

```ts
import { defineAgent, defineSkill, fromFile, agentJob } from '@loops-adk/core';

const tdd = defineSkill({ name: 'tdd', instructions: fromFile(new URL('./skills/tdd.md', import.meta.url)) });

const storeEngineer = defineAgent({
  name: 'store-engineer',
  system: fromFile(new URL('./agents/store-engineer.md', import.meta.url)), // the persona, as markdown
  model: 'sonnet',
  tools: ['edit', 'bash'],
  tier: 'worker',
  capabilities: ['storage engine', 'id stability'],
  outputs: [{ name: 'patch' }, { name: 'test-report' }],
  requiresSkills: ['contract-first'],
  skills: [tdd],                                  // methodologies fold into the system
  usesSkills: ['small-diff'],
  humanGates: [{ name: 'prod-approval', when: 'deploying production changes' }],
  failureModes: [{ mode: 'tests-flaky', recovery: 'isolate the flake, retry once' }],
});

agentJob({ agent: storeEngineer, prompt: 'Build the store to its tests.', ground: true });
```

For a runnable contract plus feedback example, see
[`examples/contracted-agent.loop.ts`](examples/contracted-agent.loop.ts).

`agentJob` resolves the def into the engine request (`system` = persona + skills, plus `model`/`tools`); inline `system`/`model`/`tools` still override it. A **skill** is a methodology (how to work: TDD, writing-plans), not a worker. The extra contract fields are optional metadata for validation, `loops describe`, docs, and future discovery — except `humanGates`, whose entries are structurally `HumanGateConfig`s, so each declared gate drops straight into the graph as a runtime pause: `humanGate(def.humanGates[0])` (see [Human gates](#human-gates-a-pause-only-a-person-lifts)). None of it gives an agent dispatch authority. This is what turns a `dag` into a named **team** (`storeEngineer`, `apiEngineer`, `securityReviewer` as separate files) orchestrated by the DAG and gated by `quorum(...)`.

Every `agentJob` and `agentCheck` subprocess gets `LOOPS_LEAF=1` plus leaf
metadata (`LOOPS_LEAF_ID`, label, path, iteration, and run id when present), so
host hooks can skip headless leaves. Claude-family model ids are normalised for
the Claude CLI, including stripping long-context suffixes such as `[1m]`.
`agentJob({ role: 'reader' })` keeps grounding but omits the handoff instruction,
which is useful for leaves that must end with a decision token.

For a bounded expert consult, set `agentJob({ advisor: { engine, model } })`.
The worker asks with a `<consult_advisor>` block; loops runs the advisor turn,
records the question and reply, then resumes the worker. This is the visible,
capped escalation path for hard forks inside a leaf.

A Claude Code agent file loads directly: `defineAgentFromMarkdown(path, overrides?)` maps the `.md`'s frontmatter (`name`, `description`, `model`, `tools`) onto the def and takes the body as `system`. The result is always a leaf — the sub-agent spawn tools (`Task`, `Agent`) are dropped from its allowlist — and `overrides` spread last, so the caller wins:

```ts
import { defineAgentFromMarkdown } from '@loops-adk/core';

const reviewer = defineAgentFromMarkdown(new URL('./agents/reviewer.md', import.meta.url), { model: 'opus' });
```

## Environments: test the running thing

A gate is only as good as what it tests. `commandSucceeds('npm', ['test'])` checks files on disk; to check that the thing _works_ you need it running. The **Environment** axis is where code runs (local services or a per-branch cloud preview), so `until` can gate on the live preview, not just static files. It is the third provider axis:

| Axis          | Where it…       | Lives in              |
| ------------- | --------------- | --------------------- |
| `Engine`      | the agent thinks | model / provider      |
| `Workspace`   | the code lives   | worktree + branch     |
| `Environment` | the code runs    | local / cloud preview |

Like `Engine`, loops owns only the interface and the lifecycle binding; the adapter (sst, Vercel, Docker…) is yours and lives next to the deploy config it wraps; loops never depends on a deploy tool. The handle's `env` (e.g. `BASE_URL`) is injected into gate commands, so the done-check reaches the live preview.

```ts
import { run, loop, commandSucceeds, type Environment } from '@loops-adk/core';

const sstEnv: Environment = {
  name: 'sst',
  async up(ws) {
    const url = await deployStage(slug(ws.branch), ws.dir); // your deploy
    return { url, env: { BASE_URL: url }, down: () => removeStage(slug(ws.branch)) };
  },
};

const job = loop({ name: 'build', body, until: commandSucceeds('playwright', ['test']) });
await run(job, { environment: sstEnv }); // one env for the run…
// …or DagConfig.environment to give every worktree-team its own stage, named after its branch.
```

Environments are **optional**: a research pipeline that never deploys just leaves it unset, and the gates test files and commands without a `BASE_URL`.

**Built-in adapters** (opt-in subpaths, no added dependency; they shell out to the CLI on PATH):

- `@loops-adk/core/env/command`: `commandEnvironment`, the generic factory every IaC tool fits (deploy / read outputs / destroy). sst, terraform, pulumi, and cloudformation-via-aws-cli are all thin presets over it.
- `@loops-adk/core/env/sst`: `sstEnvironment`, a per-branch sst stage (`sst deploy --stage <branch>`).
- `@loops-adk/core/env/docker`: `dockerEnvironment`, a local stack via a per-branch Docker Compose project, with ephemeral-port discovery so parallel branches never collide.

SDK-bound adapters (e.g. the AWS SDK) add a real dependency, so they belong in your own package or loop definition, not the core.

### Pinning env vars: `withEnv`

An Environment brings a stack up and owns its lifecycle. When you only need to **pin** variables over part of a run — no `up`/`down`, no handle — wrap the subtree in `withEnv`:

```ts
import { withEnv } from '@loops-adk/core';

withEnv({ API_BASE: 'https://staging.example.dev' }, buildLoop);
```

Everything beneath the wrapper — gate commands, judge calls, and the subprocesses agent leaves spawn — sees the overlay, without mutating the global `process.env`. Precedence, least to most specific:

```
process.env < environment.env < withEnv overlay < per-call env
```

The per-call layer is `commandSucceeds(cmd, args, { env })` and `agentJob({ env })`. Nested `withEnv` wrappers merge inner-over-outer, and an overlay only adds or shadows values (it cannot unset an inherited var). Values pinned through any layer are scrubbed verbatim from captured gate output and judge replies before they reach event records, since a failing command often echoes its config and a pinned credential's shape is unknowable to pattern scrubbing.

## Composition: loops and DAGs

```ts
import { dag, sequence, parallel, loop, agentJob, gateJob, agentCheck } from '@loops-adk/core';

dag({
  name: 'ship',
  concurrency: 2,
  nodes: {
    research: agentJob({ label: 'research', prompt: '…' }),
    implement: { needs: ['research'], job: loop({ /* … a loop as a node */ }) },
    test: { needs: ['implement'], job: agentJob({ label: 'test', prompt: '…' }) },
    review: { needs: ['test'], job: gateJob('review', agentCheck({ /* … */ })) },
  },
});
```

`needs` = dependencies; a non-`pass` required dependency blocks its dependents; a failed `optional` producer neither fails the DAG nor blocks its dependents, which run and must tolerate its artifacts being absent; an unmet `when` skips a node (counts green); cycles are detected before any work runs. DAG fan-out defaults to 4 concurrent nodes. `sequence(name, ...jobs)` and `parallel(name, jobs, concurrency?)` are sugar over `dag`.

### `pipeline`: ordered stages

When the graph is a straight line, declare it as one: `pipeline(name, stages)` chains ordered named stages, pure sugar over `dag()` (stage *i* `needs` stage *i−1*; an explicit `needs` replaces that default, so fan-out and fan-in are still just edges):

```ts
import { pipeline, renderPipelineTable } from '@loops-adk/core';

const ship = pipeline('ship', [
  { name: 'build', job: buildLoop },
  { name: 'bench', job: benchJob, optional: true }, // a failure neither fails the pipeline nor blocks `docs`
  { name: 'docs', job: docsJob, when: docsChanged }, // unmet ⇒ skipped, counts green, the chain continues
  { name: 'release', job: releaseJob },
]);

console.log(renderPipelineTable(ship)); // the stages as a markdown table
```

All dag semantics apply unchanged — a pipeline's meta stays `kind: 'dag'`, so `describe`, the TUI, and run records read it like any other dag.

### Pin the shape in a test

The same introspection that powers `loops describe` works as a test assertion: `assertGraph(job, shape)` compares a **partial** expectation against the built graph and throws with the JSON path to the first mismatch, so a composer test fails with `nodes[bench].needs: expected […], got […]` instead of a dump of two meta trees:

```ts
import { assertGraph } from '@loops-adk/core';

it('wires the ship pipeline', () => {
  assertGraph(ship, {
    kind: 'dag',
    nodes: [
      { name: 'bench', needs: ['build'], optional: true },
      { name: 'release', needs: ['docs'] },
    ],
  });
});
```

Only asserted fields are compared, and extra actual nodes are allowed unless `exactNodes: true`.

### Feedback between nodes

Review feedback is a structured revision request. In a loop, a failing `review`
outcome is threaded into the next body turn as `ctx.lastReview`; with
`consumeFeedback: true`, `agentJob` appends it to the implementation prompt in a
standard block.

```ts
const implement = agentJob({
  label: 'implementation',
  prompt: brief,
  consumeFeedback: true,
});
```

For several reviewers, use `reviewPanel` to aggregate their verdicts into one
outcome. Every reviewer is a gate: the panel passes when all of them clear (or
`pass: N` of them, k-of-n), and each failing reviewer's concern is surfaced as a
blocking finding threaded into the next pass. An empty panel is a construction
error, not a vacuous pass.

```ts
const review = reviewPanel({
  // pass: 2,  // optional: k-of-n instead of all
  reviewers: [
    { name: 'security', review: agentCheck({ question: 'Is it safe?', context: reviewContext({ diff: true, ledger: true }) }) },
    { name: 'correctness', review: agentCheck({ question: 'Is it correct?' }) },
    { name: 'simplicity', review: agentCheck({ question: 'Is it simple?', context: reviewContext({ files: ['src/**'] }) }) },
  ],
});
```

In a DAG, a targeted `revisionRequest({ target, findings })` reruns the target
node and its dependents when `maxKickbacks` allows it. `kickback(to, reason)` is
the terse compatibility helper for the same routed feedback. Agents can opt into
a graph-position prompt block with `graphContext: true`.

**Worktree isolation: branches as teams.** A concurrent node can run in its own git worktree on a fork branch (`isolation: 'worktree'` on the DAG, or `isolate: true` per node), so parallel writers never collide on files or the index. On pass, its committed work lands back into the line with a `--no-ff` merge; a conflict fails the node (loops does not auto-resolve; that's a separate layer). Each team gets its own branch, its own scratch files, and (with `DagConfig.environment`) its own stage, all born and torn down together.

For **dynamic** dispatch (a loop that discovers each unit at runtime and routes it to its own isolated sub-loop), `isolated(job)` is the same boundary as a composable wrapper rather than a predeclared node (fork, run, land back on pass):

```ts
loop({ name: 'triage', until: queueEmpty, body: pickAndDispatch });
// where pickAndDispatch routes each ticket to isolated(convergeLoop) or isolated(sweep)
```

## Loop archetypes: Converge, Sweep, Tend

A loop is not one shape. Three recur, and they differ in what memory does and in what you can even measure: a harness built for one is blind to the others.

| | **Converge** | **Sweep** | **Tend** |
| --- | --- | --- | --- |
| shape | one hard target, retried | a known set, one fresh task each | an unbounded process picking the next unit |
| example | build to a high bar with tests | research each OEM | triage issues until none remain |
| iteration N vs N−1 | the **same** task | an **independent** task | a **discovered** task |
| terminates when | the gate passes | the worklist is empty | a dynamic condition (maybe never) |
| memory's job | don't re-walk dead ends | transfer the house style | remember what's done + decided, forever |
| `loops` shape | `loop({ until: gate, max })` | `loop`/`dag` over a worklist | `loop({ until: dynamic, max: ∞ })` |

They **nest**: GitHub triage is Tend ∘ Converge (pick the next ticket, classify it, dispatch a Converge loop to a test gate); OEM research is Sweep ∘ Converge (each item is itself a multi-step build that must converge). Because a `loop` and a `dag` are both `Job`s, dispatch is just a body that selects a sub-`Job`. Wrap it in `isolated()` when each needs its own worktree. The Ledger's three tiers (scratch files → milestone commits → consolidated ledger) map onto the three nesting levels.

There is no `converge()` / `sweep()` / `tend()` in the API. They are patterns, not primitives. Copy-paste recipes for each (and the nested dispatch) are in [docs/patterns.md](docs/patterns.md); the full treatment is in [docs/concepts.md](docs/concepts.md).

## Budget, records, resume

Four `RunOptions` with matching CLI flags. The API defaults are off. The CLI
auto-writes a thin JSONL record under `.loops/records/<runId>.jsonl`; pass
`--record <path>` to choose a full-fidelity record path, or `--no-record` to
disable it.

| Option       | CLI flag             | Effect                                                                                |
| ------------ | -------------------- | ------------------------------------------------------------------------------------- |
| `budget`     | `--budget <n>`       | Cap total tokens for the run. Engine calls refuse once the cap is hit.                |
| `recordTo`   | `--record <path>`    | Append every structured event as JSONL: a readable, queryable run record. Use `'auto'` to name a thin record from the run id. |
| `checkpoint` | `--checkpoint <p>`   | Snapshot shared `ctx.state` and completed green DAG nodes at loop/dag/job boundaries. |
| `resumeFrom` | `--resume <path>`    | Restore checkpoint state and skip restored green DAG nodes once, then continue warm.  |

```ts
await run(job, { budget: 2_000_000, recordTo: '.loops/run.jsonl', checkpoint: '.loops/state.json' });
// later, after a crash or a deliberate stop:
await run(job, { resumeFrom: '.loops/state.json', checkpoint: '.loops/state.json' });
```

`budget` is the cost guard for a loop that fires a worker plus several judges per iteration: `max` bounds the call _count_, `budget` bounds their _cost_ (`{ limit, headroom, soft }` for a soft warn-don't-refuse mode).

In the CLI, `--resume <path>` also checkpoints back to `<path>` when
`--checkpoint` is omitted. A resumed run emits a startup restore event such as
`restored 3/3 nodes from .loops/state.json` or a skip reason when the workspace
fingerprint changed.

### Rate limits, quotas, and budgets: wait or resume

When a run hits a provider **rate limit**, an account **usage allowance**, or its own **token budget**, the `onLimit` policy decides what happens. The default, `auto`, **waits** when the reset is known and within a cap, otherwise **checkpoints and exits** with a ready-to-paste resume command.

| Option      | CLI flag                | Default | Effect                                                                                              |
| ----------- | ----------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `onLimit`   | `--on-limit <policy>`   | `auto`  | `auto` waits a known reset ≤ `maxWaitMs`, else pauses · `wait` always waits a known reset · `exit-resume` never waits · `fail` is the old fatal behaviour |
| `maxWaitMs` | `--max-wait <dur>`      | `300000` (5m) | Ceiling on a single interruptible limit-wait under `auto`/`wait`. |

A wait is **interruptible** (Ctrl-C unwinds it). When the policy gives up (the reset is unknown, the wait exceeds `maxWaitMs`, or the policy is `exit-resume`, and always for a `budget`, which never refreshes mid-run), the run ends with the terminal status **`paused`** (exit code **75**, `EX_TEMPFAIL`, distinct from `fail`'s `1`) so a wrapper/cron can tell "paused, resumable" from "failed". With `--checkpoint` set, the resume command is printed ready to paste; without one, the guidance says to re-run with `--checkpoint` to make a pause resumable.

The error taxonomy backs this: an engine classifies a throttle into a `RATE_LIMIT` or `QUOTA` `LoopError` carrying the reset hint (`retryAfterMs` / `resetAt`) it could read. `RATE_LIMIT` is retryable; `QUOTA` is retryable only when a reset is known; `BUDGET` never is.

## Human gates: a pause only a person lifts

Some steps must not proceed on any model's say-so — deploying to production, spending real money. `humanGate(config)` is a `Job` that holds the run at a named gate until a person acknowledges it. Unacknowledged, it emits a `human:gate` event and returns `paused`; loops, dags, and tournaments propagate `paused` straight to the root (a deliberate halt, not a failure — it outranks a coexisting failure and stops further scheduling, and a tournament never lands a winner past an unacknowledged gate), so the run exits **75** with the resume command printed, `--ack <name>` appended.

```ts
import { defineJob, sequence, humanGate } from '@loops-adk/core';

export default defineJob(
  sequence(
    'deploy',
    buildLoop,
    humanGate({ name: 'prod-approval', prompt: 'Review the staging deploy, then approve.' }),
    deployJob,
  ),
);
```

```bash
loops run deploy.loop.ts --checkpoint .loops/state.json
# … exits 75:
#   Paused at human gate "prod-approval". Resume with:
#     loops run deploy.loop.ts --resume .loops/state.json --checkpoint .loops/state.json --ack prod-approval
```

The acknowledgement lives in `ctx.state` under `humanGateKey(name)`, seeded by CLI `--ack <name>` (repeatable), a `--state` JSON seed, or an earlier job writing the key, and a pause's checkpoint carries it across the process boundary. With `--checkpoint`, completed green DAG nodes are restored from checkpoint on resume; non-DAG jobs rerun as ordinary jobs. A custom `ack` function (e.g. a marker file exists) replaces the state lookup and owns its own durability.

An `AgentDef`'s `humanGates` entries are structurally `HumanGateConfig`s, so the gate an agent declares (`humanGates: [{ name: 'prod-approval', … }]`) drops into the graph unchanged: `humanGate(def.humanGates[0])`. `pausedHumanGate(outcome)` reads the gate name back out of any nested paused outcome — it is how the CLI knows which `--ack` to print.

## Output: TUI, plain, JSON

- **Ink TUI** (default on a TTY): a live loop/dag tree, a per-iteration detail panel you can browse while the run continues, and a stats footer. Navigate with `↑/↓` (nodes), `←/→` (iterations), `f`/`space` (follow-live), `q`/`Esc`/`Ctrl-C` (abort).
- **`--no-tui`**: streamed line logs, one concise report per completed iteration, e.g. `↳ iter 2: body=fail · until=not met · review=fail (needs X) · 1.2k/0.3k tok`.
- **`--json`**: NDJSON event stream on stdout.

Every mode ends with a summary: result, per-loop iterations, review tallies, token usage by model, and any errors.

## Supervise a running loop

Run with `--supervise` and the loop registers itself under `~/.loops/runs/`, writing its live state there as it goes. Another process reads it with no daemon and no socket, because the filesystem is the channel (the same bet the rest of the library makes).

```bash
loops run build.loop.ts --supervise   # in one terminal
loops list                             # in another: every supervised run, with state and iteration
loops status <runId>                   # its shape plus where it is now: iteration, last gate verdict, tokens
loops tail <runId>                     # stream its events live
```

Each run keeps the raw diagnostic stream in `events.jsonl` and the stable, versioned semantic stream in `semantic.jsonl`. The semantic schema covers execution, gate verdicts, review decisions, lifecycle transitions, evidence, benchmark outcomes, refusals, capability gaps, handoffs, triggers, cost, and preflight results. Use `loops records <runId>` to inspect validated records without knowing the registry path; add `--kind gate-verdict`, `--kind revision` (both revision kinds), `--path ship/implementation`, `--since <time>`, `--last <n>`, or `--json` for a filtered machine-readable stream. The [semantic record contract](docs/semantic-records.md) documents every kind, the shipped JSON Schema, and the 0.7.0 archive adapter. `list` marks a run dead if its process is gone.

`loops status <runId>` prints, when something is holding the run, a **blocker** line, and `--recent [n]` appends the last *n* formatted events (default 10). The blocker is a heuristic read of the event tail naming the most plausible reason it is not moving — a failing gate, a limit pause, a human gate awaiting `--ack`, or an error with no progress since. The same rollup is one call on the public surface: `readRunProgress(runId, { recent })` returns a `RunProgress` (stage, iteration, last gate verdict, usage, blocker, recent events) — the one-read "where is it and what is it waiting on" a fleet supervisor polls.

The read and validation surfaces are public (`listRuns`, `readRunStatus`, `readRunProgress`, `readSemanticRecords`, `parseSemanticRunRecord`, `runEventsPath`, `runSemanticRecordsPath`), so an agent supervising a fleet reads the same files and contract as the CLI. Out-of-process control (pause, abort, and kickback from outside) is the next step.

## Helm: talk to your loops

`loops helm` is the conversational harness over everything above: you type plain English, a **driver model** turns it into one of nine strictly-validated JSON intents (answer, author, validate, run, status, records, ack, stop_run, done), and deterministic code executes them — authoring recipes, running the offline pre-flight, dispatching supervised background runs, reading their rollups and decision streams, lifting human gates you have approved. The driver never gets a shell; the only thing the bridge executes is the loops CLI, against paths contained in the workspace. Dispatch is a pause-point (the turn ends at a `run`, so a driver can't poll itself into a loop-burn), the step budget is stated in-context every turn, and an invalid reply gets exactly one repair prompt.

```bash
loops helm                                          # REPL over this workspace
loops helm "start fix.loop.ts in the background"    # one-shot
npm run example:helm                                # offline demo: the built-in oracle drives it, no key
```

The driver is any `Engine` — so the scripted mock drives the whole harness offline in tests, and a **driver eval** (`evalDrivers`) measures which real models can drive the contract: ten cases scored deterministically on four separate dimensions (produced JSON at all / valid intent / right intent / really executed), with a built-in zero-key oracle as the 1.0 control ceiling. The full guide — the contract, safety, embedding via `HelmSession`, and the eval — is [docs/helm.md](docs/helm.md).

## A whole engineering team, defined as files

The primitives compose into an **engineering team**: several loops that build a multi-component service, hold it coherent across components, and converge only when each piece clears a bar one agent can't impose on itself, a report-only **review battery** of distinct lenses, including a different model.

```ts
// Five report-only lenses, each a markdown persona that closes with `<confidence>N%</confidence>`.
// The adversarial lens runs on a DIFFERENT model (codex / GPT-5): any reviewer, any model.
const battery = (name) =>
  reviewPanel(name, [
    ['adversarial', { engine: 'codex' }], // genuinely different priors
    ['security',    { model: 'opus' }],
    ['correctness', { model: 'sonnet' }],
    ['conformance', { model: 'opus' }],
    ['simplicity',  { model: 'haiku' }],
  ]);

const engineer = (name) =>
  loop({
    name,
    body: agentJob({ agent: engineerFor(name), prompt: brief(name), ground: true }),
    until: commandSucceeds('node', [`test-${name}.mjs`]), // deterministic truth
    review: battery(name), // unanimous; a failing review hands its findings to the next iteration
    commit: true,
    max: 8,
  });

export default dag({
  name: 'build-service',
  nodes: {
    store:     engineer('store'),
    api:       { needs: ['store'],                job: engineer('api') },
    serialize: { needs: ['store'], isolate: true, job: engineer('serialize') }, // parallel worktree
    client:    { needs: ['api', 'serialize'],     job: engineer('client') },
  },
  isolation: 'worktree',
});
```

The `dag` is the manager (toposort + dispatch). Each node is a Converge loop: the engineer builds to its `test` (`until`), then the **review battery** runs in the `review` slot: five report-only lenses with near-disjoint blind spots, each judging the actual source against the recorded contracts and closing with a `<confidence>N%</confidence>`. Because a reviewer is just an `AgentDef` and `agentCheck` takes an `engine` and `model`, **any reviewer runs on any model**: the adversarial lens on codex (GPT-5) for a true second-model signal, the rest spread across Claude. A failing review is not a dead end: its findings thread into the next iteration as `lastReview`, so the engineer fixes concrete concerns: the build → review → fix-up loop, with no human in it. `isolate` runs engineers in parallel worktrees that land back on pass; `ground: true` carries the contracts only `store` decides (stable ids, the `SSv1|` wire tag) to the engineers and reviewers downstream.

A single autonomous agent grades its own homework. This team **structurally cannot**: "done" means past an independent, multi-lens, multi-model review battery it never applies to itself. The whole team (engineers and reviewers) is a folder of markdown personas plus the wiring above, runnable in [`examples/build-service.loop.ts`](examples/build-service.loop.ts).

## Roadmap

- [x] **Ledger**, git-memory core: the scratch files (working memory + handoff), grounding, milestone commits
- [x] Worktree isolation (branches-as-teams) with `--no-ff` land-back
- [x] Environment axis: provider interface + offline mock
- [x] Publish to npm (`@loops-adk/core`, built `dist` + types, CI release)
- [x] Supervision: a file-based run registry with `loops list` / `status` / `tail`
- [ ] Out-of-process control: `pause` / `abort` / `kickback` a running loop from outside
- [ ] Optional `wip:` autosave tier (per-iteration recovery, squashed on convergence)
- [x] No-progress / stall detection (`noProgress`): the third hard stop, alongside `max` and `budget`
- [ ] `cost per accepted change` as a first-class reported metric
- [ ] Calibration helpers for agent judges
- [ ] More engine adapters (OpenAI, local models)
- [ ] Scrollable per-iteration transcript in the TUI

## Develop

```bash
npm test          # vitest: offline, deterministic via the mock engine
npm run typecheck # tsc --noEmit
```

Contributions welcome. Open an issue to discuss anything substantial first. Keep the core focused: resist adding node types or configuration that don't earn their place.

## License

[MIT](./LICENSE)
