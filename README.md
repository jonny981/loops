# loops

Run a prompt/agent in a **loop with a fresh context every iteration**, with
start/stop conditions, agent-validated convergence, review-restart, max
iterations, message streaming, an Ink TUI, and an exit summary.

One nestable primitive, borrowing the Jenkins instinct — **everything is a job**:

- a **`Job`** is the universal runnable unit (`(ctx) => Promise<Outcome>`). Any
  size: a single agent turn, or a whole nested loop.
- **`loop()`** returns a `Job`, so loops nest by passing one as another's `body`
  or `review`.
- **`dag()`** (stages) returns a `Job` too, so loops and DAGs nest _both ways_.
- **`Condition`** is the gate type (a Jenkins `when`); `agentCheck()` is a
  Condition decided by a small validator model.
- **`Engine`** is the pluggable, drop-in backend (a Jenkins agent/node) — the
  agent launch is completely agnostic of harness, model, framework, or provider.

It is a self-contained npm island (not part of the pnpm workspace), like
`tools/oem-reverse-engineer`.

## What this is (and isn't)

This is a **fresh-context coding-loop primitive**, not a durable workflow engine.
The design assumption is that the **workspace is the state**: each iteration runs
with a clean context and progress accumulates on disk (files, git commits, a
`NOTES.md`), not in loop memory. The loop carries only thin bookkeeping
(iteration count, `ctx.state`, the last review). So if the process dies mid-run
you re-run the loop against the same repo and continue from where the files are —
you lose the bookkeeping, not the work.

What it deliberately does **not** do: durable mid-run replay (re-running a
half-finished job graph and skipping the steps that already completed). That is
an _orchestration_ concern; if you need it, reach for Mastra, LangGraph, or
Temporal. What it **does** offer is the thin version that fits the
workspace-is-state model: an optional JSONL **run record**, a **checkpoint** of
the shared `ctx.state` scratchpad at each boundary, and **resume** that restores
that scratchpad so a re-run continues warm rather than cold; plus a token
**budget** that caps spend (see [Budget, records, resume](#budget-records-and-resume)).
These stay small on purpose — the primitive is still one you can read in an
afternoon.

A second honesty note on convergence: an `agentCheck` is a model's
_self-reported_ confidence, which is a weak, poorly-calibrated signal on its own.
Treat it as a guard on intent, not ground truth. For anything that matters, gate
`until` on a **deterministic** check too (tests pass via `commandSucceeds`) and,
for high-stakes gates, use `quorum(...)` to require several independent judges
rather than trusting one number.

## Install

```bash
cd tools/loops
npm install
```

## Quick start

Flags mode — the standard worker → until → review loop:

```bash
# loop a worker until a small model is 85% sure it's done, restarting on a failed review
loops run \
  --prompt "Continue implementing the feature in TASK.md; report what changed." \
  --engine agent-sdk \
  --until "Is the feature fully implemented with passing tests?" --threshold 0.85 \
  --validator-model claude-haiku-4-5-20251001 \
  --review "Does it pass a strict review with no blockers?" \
  --max 20
```

Definition-file mode — full power and nesting (note: `loops run <file>` **imports
and executes** that file's module code, like `node <file>` — only run definition
files you trust):

```bash
loops run examples/confidence-gate.loop.ts          # Ink TUI
loops run examples/confidence-gate.loop.ts --no-tui  # plain line logs
loops run examples/confidence-gate.loop.ts --json    # NDJSON event stream
```

Offline demo (no network/engine):

```bash
npm run example:poll
```

## The primitive

```ts
import {
  defineJob,
  loop,
  agentJob,
  agentCheck,
  commandSucceeds,
  gateJob,
  parallel,
} from 'loops';

export default defineJob(
  loop({
    name: 'build-feature',
    max: 20,

    // runs each iteration with a FRESH context
    body: agentJob({
      label: 'worker',
      engine: 'agent-sdk',
      prompt: (ctx) => `Iteration ${ctx.iteration}: make concrete progress.`,
    }),

    // stop only when the tests ACTUALLY pass (ground truth) AND a small model
    // agrees the work matches intent. An array `until` is `all`, so both hold.
    // Never gate on the judge alone — its confidence is a self-report.
    until: [
      commandSucceeds('npm', ['test']),
      agentCheck({
        engine: 'anthropic-api',
        model: 'claude-haiku-4-5-20251001',
        question: 'Does the feature match what was asked (not just compile)?',
        threshold: 0.85,
      }),
    ],

    // when `until` is met, run a review; if it does NOT pass, the loop runs again.
    // here the review is two reviewers in PARALLEL (a dag) — loops within loops.
    review: parallel('reviewers', {
      security: gateJob(
        'security',
        agentCheck({ question: 'No security issues?', threshold: 0.9 }),
      ),
      quality: gateJob(
        'quality',
        agentCheck({ question: 'Meets the quality bar?', threshold: 0.85 }),
      ),
    }),
  }),
);
```

> The `agentCheck` calls above use the `anthropic-api` engine, which needs
> `ANTHROPIC_API_KEY`. To run keyless via host Claude auth, set their
> `engine: 'claude-cli'` (or `'agent-sdk'`) instead.

### `loop(config)`

| field                        | meaning                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body`                       | the job run each iteration (a `Job` — pass a `loop()`/`dag()` to nest)                                                                                                |
| `start`                      | gate before iterating; unmet ⇒ `aborted`                                                                                                                              |
| `until`                      | checked after each body run; met ⇒ stop (then `review`)                                                                                                               |
| `stopOn`                     | hard early-exit checked each iteration; met ⇒ `aborted`                                                                                                               |
| `max`                        | iteration cap; reached without passing ⇒ `exhausted`                                                                                                                  |
| `review`                     | runs when `until` is met; non-`pass` re-enters the loop (its outcome is exposed to the next iteration as `ctx.lastReview`)                                            |
| `maxReviewRestarts`          | cap on consecutive failed reviews before `exhausted` — bounds the worker/reviewer standoff independently of `max`; set this whenever `review` is used without a `max` |
| `delayMs`                    | delay between iterations (polling); interruptible by abort                                                                                                            |
| `retry`                      | `{ onError: 'continue' \| 'fail', maxConsecutive?, backoffMs? }`                                                                                                      |
| `onIteration` / `onComplete` | hooks (`onComplete` ≈ Jenkins `post { always }`)                                                                                                                      |

With no `until`, a `pass` body ends the loop.

### Conditions — one or many, deterministic or agent

`start` / `until` / `stopOn` accept **one item or many**, freely mixing a bare
predicate and an agent check. Arrays default to `all` (wrap in `any(...)` for or):

```ts
until: [
  commandSucceeds('npm', ['test']), // deterministic ground truth
  agentCheck({ question: 'Good enough to ship?', threshold: 0.9 }), // agent-validated intent
];
```

Prefer this mixed form over a lone `agentCheck`: the deterministic check is the
truth, the judge guards intent. For a high-stakes gate, wrap several judges in
`quorum(k, ...)` so consensus, not one self-reported number, opens the gate.

For a single judge that still resists a one-number self-report, give `agentCheck`
a `dimensions` list. The model scores each dimension 0..1 and the gate opens on
their **geometric mean**, so one weak dimension drags the verdict down:

```ts
until: agentCheck({
  question: 'Is this ready to ship?',
  threshold: 0.8,
  dimensions: ['intent match', 'evidence quality', 'outcome coherence'],
});
```

Builders: `predicate`, `bodyPassed`, `minConfidence`, `commandSucceeds`
(deterministic: a shell command exits 0), `all`, `any`, `not`, `quorum`
(k-of-n consensus), `always`, `never`, `agentCheck`, and `gateJob` (lift a
Condition into a `Job`, e.g. a reviewer).

### Stages / DAG

```ts
import { dag, sequence, parallel } from 'loops';

dag({
  name: 'ship',
  nodes: {
    research: agentJob({ label: 'research', prompt: '…' }),
    implement: {
      needs: ['research'],
      job: loop({
        /* … */
      }),
    }, // a loop as a node
    test: {
      needs: ['implement'],
      job: agentJob({ label: 'test', prompt: '…' }),
    },
    review: {
      needs: ['test'],
      when: () => true,
      job: gateJob(
        'review',
        agentCheck({
          /* … */
        }),
      ),
    },
  },
  concurrency: 2,
});
```

`needs` = dependencies; `optional` nodes never block/fail the DAG; an unmet
`when` skips a node (counts green). Cycles are detected before any work runs.
`sequence(name, ...jobs)` and `parallel(name, jobs, concurrency?)` are sugar.

## Engines (drop-in)

The agent launch only ever touches the `Engine` interface. Built-ins:

| name            | backend                          | notes                                                       |
| --------------- | -------------------------------- | ----------------------------------------------------------- |
| `agent-sdk`     | `@anthropic-ai/claude-agent-sdk` | fresh `query()` per call; uses host Claude auth             |
| `claude-cli`    | `claude` subprocess (`execa`)    | fresh process per call                                      |
| `anthropic-api` | `@anthropic-ai/sdk`              | token-level streaming; cheapest for validators; needs a key |
| `mock`          | scripted, offline                | for tests/examples                                          |

> Prefer the `ANTHROPIC_API_KEY` env var over `--api-key` for the `anthropic-api`
> engine — a flag value is recorded in your shell history and visible in the
> process table.

Select per-run (`--engine`, `RunOptions.engine`) or per-job/condition
(`engine:` accepts a name **or** a ready-made `Engine` instance). Add your own:

```ts
import { run, type Engine } from 'loops';

const myEngine: Engine = {
  name: 'my-provider',
  async run(req, onEvent, signal) {
    // call any provider/framework; stream via onEvent({ type: 'text', delta })
    return {
      text,
      usage: { inputTokens, outputTokens },
      model: req.model ?? 'x',
    };
  },
};

await run(job, { engine: 'my-provider', engines: { 'my-provider': myEngine } });
```

That is the whole contract — implement `run`, register a name. No coupling to a
framework; a managed/durable runner could later be a drop-in engine too.

## Output

- **Ink TUI** (default on a TTY): live loop/dag tree, a per-iteration detail panel, and a stats footer; `q`/Esc/Ctrl-C aborts. Abort is cooperative — it cancels via `AbortController`/`cancelSignal`, so a clean stop depends on the engine honouring it promptly (the CLI engine escalates to SIGKILL after 5s; a second Ctrl-C force-exits).
- **`--no-tui`**: streamed line logs. After each iteration of a loop completes, a one-line report is printed, e.g. `↳ iter 2: body=fail · until=not met · review=fail (needs X) · 1.2k/0.3k tok`.
- **`--json`**: NDJSON event stream on stdout.

Every mode prints an exit summary (result, per-loop iterations, review tallies,
token usage by model, errors). Exit codes: `pass=0`, `fail=1`, `exhausted=2`,
`aborted=130`.

### TUI navigation

The TUI retains the full per-iteration history of every loop, so you can browse
the result of each iteration while the run continues. The detail panel shows the
selected iteration's body status + summary, the `until`/`stopOn`/`review`
verdicts, token usage and duration, and the last few transcript lines.

| Key                    | Action                                                      |
| ---------------------- | ----------------------------------------------------------- |
| `↑` / `↓` or `k` / `j` | Move the selection across loop nodes (tree order)           |
| `←` / `→` or `h` / `l` | Step to the previous / next iteration of the selected loop  |
| `f` or `space`         | Toggle follow-live (auto-track the newest loop + iteration) |
| `q` / `Esc` / `Ctrl-C` | Abort the run                                               |

The footer shows `● LIVE` while following and `⏸ BROWSE` once you navigate away;
any navigation key turns following off, and `f`/`space` turns it back on.

## Budget, records, and resume

Four opt-in `RunOptions` (and matching CLI flags). All default off, so the core
path is unchanged.

| Option       | CLI flag           | Effect                                                                                       |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| `budget`     | `--budget <n>`     | Cap total tokens (input + output) for the run. Engine calls refuse once the cap is hit.      |
| `recordTo`   | `--record <path>`  | Append every structured event as JSONL — a readable run record (token-delta noise excluded). |
| `checkpoint` | `--checkpoint <p>` | Snapshot the shared `ctx.state` at each loop/dag/job boundary (latest-wins).                 |
| `resumeFrom` | `--resume <path>`  | Restore the `ctx.state` a prior `--checkpoint` wrote, so a re-run continues warm.            |

```ts
await run(job, {
  budget: 2_000_000, // or { limit, headroom?, soft? }
  recordTo: '.loops/run.jsonl',
  checkpoint: '.loops/state.json',
});
// later, after a crash or a deliberate stop:
await run(job, { resumeFrom: '.loops/state.json' });
```

`budget` is the cost guard for a loop that fires a worker plus several judges per
iteration: `max` bounds the call _count_, `budget` bounds their _cost_. A bare
number is the token limit; pass `{ limit, headroom, soft }` to stop with room to
spare (`headroom`) or to warn-and-continue instead of refusing (`soft`). The exit
summary reports spend against the cap.

Checkpoint/resume is deliberately thin and honours the workspace-is-state model:
it persists the loop's shared scratchpad, not a replayable execution graph. Your
body records its own progress in `ctx.state` and reads it back on resume; the
real work (files, git) is already on disk. This is not durable mid-graph replay —
for that, embed the loop as a step inside a durable runner (Mastra/Temporal).

## Develop

```bash
npm test          # vitest (offline, mock engine — covers loop/dag/condition paths)
npm run typecheck # tsc --noEmit
```
