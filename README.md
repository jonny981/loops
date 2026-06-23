# loops

**Run an AI agent in a loop until the work is _actually_ done — then prove it.**

`loops` is a tiny, nestable job primitive for driving agents in **convergence loops**. Each iteration runs with a **fresh context**; the loop stops only when a gate _you_ define says it's done — a deterministic check (the tests really pass), a model judge with a confidence threshold, a k-of-n jury, or any mix. Compose loops and DAGs both ways, run them against any model backend behind a one-method `Engine`, and watch it all in a live terminal UI.

![status: alpha](https://img.shields.io/badge/status-alpha-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![node >=20](https://img.shields.io/badge/node-%3E%3D20-3c873a)
![license MIT](https://img.shields.io/badge/license-MIT-blue)

```ts
import { loop, agentJob, commandSucceeds, agentCheck } from 'loops';

// Keep working until the tests pass AND a judge agrees it matches intent.
export default loop({
  name: 'build-feature',
  max: 20,
  body: agentJob({
    prompt: (c) => `Iteration ${c.iteration}: make concrete progress on TASK.md.`,
  }),
  until: [
    commandSucceeds('npm', ['test']), // ground truth
    agentCheck({ question: 'Does it match TASK.md?', threshold: 0.85 }), // intent
  ],
});
```

---

## Why loops?

Agents rarely nail it in one shot. The reliable pattern is a **convergence loop**: do a bit of work, check whether you're _actually_ done, and if not, go again. Two things make or break it, and `loops` is built around both:

- **A fresh context every turn.** Long-running agents rot as their history balloons. `loops` runs each iteration with a clean slate and lets progress accumulate where it belongs — in the **workspace** (files, git commits), not in a chat transcript. The loop carries only thin bookkeeping.
- **A real done-check.** "Ask the model if it's finished" is the classic trap: the model grades its own homework. `loops` makes the gate a first-class value and lets you combine a **deterministic** signal (the tests genuinely pass) with a **separate judge**, so "done" means _converged_, not _claims to be_.

Everything else — DAGs, nesting, engines, budgets, the TUI — hangs off that one idea. The whole thing is small enough to read in an afternoon.

## Install

> **Status: alpha.** The API is still settling and `loops` is not yet on npm. Use it from git for now; an npm release is planned.

```bash
git clone https://github.com/jonny981/loops.git
cd loops
npm install
node bin/loops.mjs --help        # or: npm link  →  loops --help
```

Requires **Node ≥ 20**. No build step: the CLI runs the TypeScript directly through [`tsx`](https://github.com/privatenumber/tsx).

## Quick start

**Flags mode** — the standard `worker → until → review` loop, no code:

```bash
loops run \
  --prompt "Continue implementing the feature in TASK.md; report what changed." \
  --engine claude-cli \
  --until "Is the feature fully implemented with passing tests?" --threshold 0.85 \
  --review "Does it pass a strict review with no blockers?" \
  --max 20
```

**Definition-file mode** — full power and nesting. A `.loop.ts` file `export default`s a `Job`:

```bash
loops run examples/confidence-gate.loop.ts          # live Ink TUI
loops run examples/confidence-gate.loop.ts --no-tui  # plain streamed logs
loops run examples/confidence-gate.loop.ts --json    # NDJSON event stream
```

> `loops run <file>` **imports and executes** that file's module, like `node <file>` — only run definition files you trust.

**Offline demo** (no network, no key — uses the mock engine):

```bash
npm run example:poll
```

## Core idea — everything is a `Job`

There is one universal unit of work, and two supporting types:

```ts
type Job = (ctx: JobContext) => Promise<Outcome>; // a unit of work, any size
type Condition = (ctx, last) => Promise<{ met; reason; confidence? }>; // a yes/no gate
interface Engine {
  run(req, onEvent, signal): Promise<AgentResult>;
} // where an agent turn runs
```

- **`loop()` returns a `Job`** — so a loop nests by passing one as another's `body` or `review`.
- **`dag()` returns a `Job` too** — so loops and DAGs nest **both ways**: a DAG node can be a loop, a loop body can be a DAG.

Nesting is the absence of a special case, not a feature.

### `loop(config)`

```ts
loop({
  name: 'build-feature',
  body, // the Job run each iteration (fresh context) — pass a loop()/dag() to nest
  start, // gate before iterating; unmet ⇒ aborted
  until, // checked after each body; met ⇒ stop (then review)
  stopOn, // hard early-exit each iteration; met ⇒ aborted
  review, // runs when until is met; non-pass re-enters the loop (folds back as ctx.lastReview)
  max, // iteration cap; reached without passing ⇒ exhausted
  maxReviewRestarts, // cap the worker/reviewer standoff independently of max
  delayMs, // delay between iterations (polling); interruptible by abort
  retry, // { onError: 'continue' | 'fail', maxConsecutive?, backoffMs? }
  onIteration,
  onComplete, // hooks (onComplete runs once, whatever the outcome)
});
```

With no `until`, a `pass` body ends the loop. Terminal status is one of `pass · fail · exhausted · aborted` (CLI exit codes `0 · 1 · 2 · 130`).

## Conditions — honest convergence

`start` / `until` / `stopOn` accept **one item or many**, freely mixing deterministic predicates and agent judges. Arrays are `all` by default (wrap in `any(...)` for or):

```ts
until: [
  commandSucceeds('npm', ['test']), // deterministic ground truth
  agentCheck({ question: 'Good enough to ship?', threshold: 0.9 }), // agent-validated intent
];
```

Prefer this mixed form over a lone judge. A model's self-reported confidence is a weak, poorly-calibrated signal — treat it as a guard on _intent_, with a deterministic check as the _truth_. Two ways to harden the judge itself:

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

**Builders:** `predicate`, `bodyPassed`, `minConfidence`, `commandSucceeds` (a shell command exits 0), `all`, `any`, `not`, `quorum` (k-of-n), `agentCheck` (small-model judge), `always`, `never`, and `gateJob` (lift a condition into a `Job`, e.g. a reviewer).

## Engines — bring any model

The agent launch only ever touches the `Engine` interface, so the loop knows nothing about your model, provider, or framework.

| name            | backend                          | notes                                                       |
| --------------- | -------------------------------- | ----------------------------------------------------------- |
| `claude-cli`    | `claude` subprocess (`execa`)    | fresh process per call; uses host Claude auth, no key       |
| `agent-sdk`     | `@anthropic-ai/claude-agent-sdk` | fresh `query()` per call; host Claude auth                  |
| `anthropic-api` | `@anthropic-ai/sdk`              | token-level streaming; cheapest for judges; needs a key     |
| `mock`          | scripted, offline                | for tests and examples                                      |

Select per-run (`--engine`, `RunOptions.engine`) or per-job/condition (`engine:` takes a name **or** a ready-made `Engine`). Bring your own in ~10 lines:

```ts
import { run, type Engine } from 'loops';

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

## Composition — loops and DAGs

```ts
import { dag, sequence, parallel, loop, agentJob, gateJob, agentCheck } from 'loops';

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

`needs` = dependencies; a non-`pass` required dependency blocks its dependents; `optional` nodes never block or fail the DAG; an unmet `when` skips a node (counts green); cycles are detected before any work runs. `sequence(name, ...jobs)` and `parallel(name, jobs, concurrency?)` are sugar over `dag`.

## Budget, records, resume

Four opt-in `RunOptions` (with matching CLI flags). All default off.

| Option       | CLI flag             | Effect                                                                                |
| ------------ | -------------------- | ------------------------------------------------------------------------------------- |
| `budget`     | `--budget <n>`       | Cap total tokens for the run. Engine calls refuse once the cap is hit.                |
| `recordTo`   | `--record <path>`    | Append every structured event as JSONL — a readable, queryable run record.            |
| `checkpoint` | `--checkpoint <p>`   | Snapshot the shared `ctx.state` at each loop/dag/job boundary (latest-wins).          |
| `resumeFrom` | `--resume <path>`    | Restore the `ctx.state` a prior `--checkpoint` wrote, so a re-run continues warm.     |

```ts
await run(job, { budget: 2_000_000, recordTo: '.loops/run.jsonl', checkpoint: '.loops/state.json' });
// later, after a crash or a deliberate stop:
await run(job, { resumeFrom: '.loops/state.json' });
```

`budget` is the cost guard for a loop that fires a worker plus several judges per iteration: `max` bounds the call _count_, `budget` bounds their _cost_ (`{ limit, headroom, soft }` for a soft warn-don't-refuse mode).

## Output — TUI, plain, JSON

- **Ink TUI** (default on a TTY): a live loop/dag tree, a per-iteration detail panel you can browse while the run continues, and a stats footer. Navigate with `↑/↓` (nodes), `←/→` (iterations), `f`/`space` (follow-live), `q`/`Esc`/`Ctrl-C` (abort).
- **`--no-tui`**: streamed line logs, one concise report per completed iteration, e.g. `↳ iter 2: body=fail · until=not met · review=fail (needs X) · 1.2k/0.3k tok`.
- **`--json`**: NDJSON event stream on stdout.

Every mode ends with a summary: result, per-loop iterations, review tallies, token usage by model, and any errors.

## What `loops` is (and isn't)

`loops` is a **fresh-context loop primitive**, not a durable workflow engine. The design bet is that **the workspace is the state**: progress lives on disk (files, git), so each iteration can start clean. If the process dies mid-run, you re-run against the same workspace and continue — you lose the bookkeeping, not the work.

It deliberately does **not** do durable mid-run replay (re-running a half-finished graph and skipping completed steps) — that's an orchestration concern; for it, embed a `loops` job as a step inside [Temporal](https://temporal.io), [LangGraph](https://github.com/langchain-ai/langgraphjs), or [Mastra](https://mastra.ai). What it _does_ offer (run records, a thin state checkpoint, a token budget) is the lightweight version that fits the workspace-is-state model.

| You want…                                          | Reach for…                          |
| -------------------------------------------------- | ----------------------------------- |
| Loop an agent to convergence with a real done-gate | **loops** (you're here)             |
| Durable, resumable, replayable workflows           | Temporal / LangGraph / Mastra       |
| One agent call with tool use                       | your provider's SDK directly        |

## Roadmap

- [ ] Publish to npm (with a built `dist` + `exports`)
- [ ] Richer per-iteration ledger + scrollable transcript in the TUI
- [ ] Calibration helpers for agent judges
- [ ] More engine adapters (OpenAI, local models)

## Develop

```bash
npm test          # vitest — offline, deterministic via the mock engine
npm run typecheck # tsc --noEmit
```

Contributions welcome — open an issue to discuss anything substantial first. Keep the core small; that smallness is the point.

## License

[MIT](./LICENSE)
