# loops

**Run an AI agent in a loop until the work is _actually_ done — then prove it.**

`loops` is a tiny, nestable job primitive for driving agents in **convergence loops**. Each iteration runs with a **fresh context**; the loop stops only when a gate _you_ define says it's done — a deterministic check (the tests really pass), a model judge with a confidence threshold, a k-of-n jury, or any mix. Compose loops and DAGs both ways, run them against any model backend behind a one-method `Engine`, and watch it all in a live terminal UI.

A fresh context every turn would cause amnesia — a clean-slate iteration re-walking a dead end an earlier one already ruled out — so the core is **Ledger**: the loop writes its reasoning to git as it works and grounds the next turn on that log. No vector database, no embeddings, no index to sync or let go stale — **git is the memory.** And where most "agent memory" is built to recall a _conversation_, the Ledger is built to keep your _decisions_ consistent across long work. Fresh context kills rot; the Ledger kills amnesia.

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
    ground: true, // read the commit log + this run's scratch files before working
  }),
  until: [
    commandSucceeds('npm', ['test']), // ground truth
    agentCheck({ question: 'Does it match TASK.md?', threshold: 0.85 }), // intent
  ],
  commit: { subject: 'feat: TASK.md' }, // one milestone commit when it converges
});
```

---

## Why loops?

Agents rarely nail it in one shot. The reliable pattern is a **convergence loop**: do a bit of work, check whether you're _actually_ done, and if not, go again. Two things make or break it, and `loops` is built around both:

- **A fresh context every turn.** Long-running agents rot as their history balloons. `loops` runs each iteration with a clean slate and lets progress accumulate where it belongs — in the **workspace** (files, git commits), not in a chat transcript. The loop carries only thin bookkeeping.
- **Memory in git, not in the transcript.** Fresh context alone would mean amnesia. **Ledger** (below) writes the _why_ to git as the work happens and reads it back before the next turn, so a clean slate is never a blank one.
- **A real done-check.** "Ask the model if it's finished" is the classic trap: the model grades its own homework. `loops` makes the gate a first-class value and lets you combine a **deterministic** signal (the tests genuinely pass) with a **separate judge**, so "done" means _converged_, not _claims to be_.

Everything else — DAGs, nesting, engines, budgets, the TUI — hangs off those ideas. The whole thing is small enough to read in an afternoon.

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

With no `until`, a `pass` body ends the loop. Terminal status is one of `pass · fail · exhausted · aborted · paused` (CLI exit codes `0 · 1 · 2 · 130 · 75`). `paused` is a limit-driven, resumable stop — see [Rate limits, quotas, and budgets](#rate-limits-quotas-and-budgets--wait-or-resume).

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

## Ledger — memory built on git

Fresh context kills _rot_; on its own it would cause _amnesia_. **Ledger** is the core that closes the gap: the loop writes its reasoning to git as it works and reads it back before the next turn. No parallel database, no vector store — git _is_ the index: nothing to build, embed, sync, or let go stale (the commit log can't drift out of sync with the code — it _is_ the code's history). (`Ledger` is the engine; the **commit log** is the durable memory it reads and writes; `.loops/ledger.md` and `.loops/prompt.md` are the live scratch files for work in flight.)

- **Scratch files — working memory and a handoff.** Two gitignored files carry a unit of work forward. `.loops/ledger.md` is **working memory** for the agent(s) doing the work now: the harness auto-captures each grounded turn (the reasoning + a summary of actions), so the why is recorded even when no single agent holds it all at the end, and fanned-out peers share it. `.loops/prompt.md` is the **handoff** the agent distils for whoever continues: intent, alternatives ruled out, constraints, what is left. Grounding injects both into the next context; the commit body is the handoff plus a compacted working log.

  ```ts
  appendPrompt(ctx.workspace, { heading: 'Why', body: 'tried a token refresh; the gate still failed on scope' });
  ```

- **Milestone commits — crystallise it.** A commit is a _milestone_, not an iteration. When a loop converges, `commitJob` composes one structured body — the handoff plus a compacted working log (the **way**) — welded to the diff (the **what**), then clears both scratch files. Turn it on with `commit:`; iterations stay durable in the workspace + scratch files, so the log holds only converged, reasoned-over checkpoints. Welded to its diff, a commit body is a permanent record any later agent can look back to, as far back as it wants. Finer milestones? Compose finer loops/nodes.

  ```ts
  loop({ name: 'build', body, until, commit: { subject: 'feat: the feature' } });
  ```

- **Grounding — read it back.** A fresh turn reads the recent committed commit log (past milestones) and this run's live scratch files (working memory + handoff), prepended to its prompt, so it knows what was already tried. The reach is **branch-local**: adjacent branches are in-flight and may never land, and the merge is where work becomes shared truth.

  ```ts
  agentJob({ label: 'work', prompt: 'Continue the task.', ground: true });
  ```

- **Scaling the read — retrieval, then consolidation.** Recent-N grounding is the default, but on a long, noisy log the relevant commit falls out of the window. `ground: { retrieve: true }` has a cheap model select the relevant commits by subject instead — use it for long-horizon work. For an indefinite process, `consolidateJob` folds the history into a **decision-preserving consolidated ledger** — a bounded record that keeps every accrued decision verbatim (a naive progress summary loses the specifics), committed as a commit body (the coarse tier, grounded like any milestone, never a side file). Retrieval finds the _relevant_ past commits; consolidation keeps _all the decisions_ in bounded space — different jobs, both in the git grain.

  ```ts
  agentJob({ label: 'work', prompt: 'Continue.', ground: { retrieve: true } });
  ```

The Ledger has **two faces**: _cross-iteration_ (recover from your own failed attempts in a retry loop) and _cross-node_ (honour an upstream node's decision a downstream agent could not otherwise know). Both need headroom — on one-shot, single-node work memory is only a tax. See [docs/concepts.md](docs/concepts.md) for where it helps and the measured evidence in [bench/RESULTS.md](bench/RESULTS.md).

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

## Agents — define a specialist once

Instead of a wall of inline prompt, define each agent as a reusable, job-specific **`AgentDef`** — the persona and methodologies live in editable **markdown files**, the structure and types live in TypeScript. The `.ts` is the strongly-typed wrapper around the `.md`:

```ts
import { defineAgent, defineSkill, fromFile, agentJob } from 'loops';

const tdd = defineSkill({ name: 'tdd', instructions: fromFile(new URL('./skills/tdd.md', import.meta.url)) });

const storeEngineer = defineAgent({
  name: 'store-engineer',
  system: fromFile(new URL('./agents/store-engineer.md', import.meta.url)), // the persona, as markdown
  model: 'sonnet',
  tools: ['edit', 'bash'],
  capabilities: ['storage engine', 'id stability'],
  skills: [tdd],                                  // methodologies fold into the system
  failureModes: [{ mode: 'tests-flaky', recovery: 'isolate the flake, retry once' }],
});

agentJob({ agent: storeEngineer, prompt: 'Build the store to its tests.', ground: true });
```

`agentJob` resolves the def into the engine request (`system` = persona + skills, plus `model`/`tools`); inline `system`/`model`/`tools` still override it. A **skill** is a methodology (how to work — TDD, writing-plans), not a worker. This is what turns a `dag` into a named **team** — `storeEngineer`, `apiEngineer`, `securityReviewer` as small files — orchestrated by the DAG and gated by `quorum(...)`.

## Environments — test the running thing

A gate is only as honest as what it tests. `commandSucceeds('npm', ['test'])` checks files on disk; to check that the thing _works_ you need it running. The **Environment** axis is where code runs — local services or a per-branch cloud preview — so `until` can gate on the live preview, not just static files. It is the third provider axis:

| Axis          | Where it…       | Lives in              |
| ------------- | --------------- | --------------------- |
| `Engine`      | the agent thinks | model / provider      |
| `Workspace`   | the code lives   | worktree + branch     |
| `Environment` | the code runs    | local / cloud preview |

Like `Engine`, loops owns only the interface and the lifecycle binding; the adapter (sst, Vercel, Docker…) is yours and lives next to the deploy config it wraps — loops never depends on a deploy tool. The handle's `env` (e.g. `BASE_URL`) is injected into gate commands, so the done-check reaches the live preview.

```ts
import { run, loop, commandSucceeds, type Environment } from 'loops';

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

Environments are **optional** — a research pipeline that never deploys just leaves it unset, and the gates test files and commands without a `BASE_URL`.

**Built-in adapters** (opt-in subpaths, no added dependency — they shell out to the CLI on PATH):

- `loops/env/command` — `commandEnvironment`, the generic factory every IaC tool fits (deploy / read outputs / destroy). sst, terraform, pulumi, and cloudformation-via-aws-cli are all thin presets over it.
- `loops/env/sst` — `sstEnvironment`, a per-branch sst stage (`sst deploy --stage <branch>`).
- `loops/env/docker` — `dockerEnvironment`, a local stack via a per-branch Docker Compose project, with ephemeral-port discovery so parallel branches never collide.

SDK-bound adapters (e.g. the AWS SDK) add a real dependency, so they belong in your own package or loop definition, not the core.

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

**Worktree isolation — branches as teams.** A concurrent node can run in its own git worktree on a fork branch (`isolation: 'worktree'` on the DAG, or `isolate: true` per node), so parallel writers never collide on files or the index. On pass, its committed work lands back into the line with a `--no-ff` merge; a conflict fails the node honestly (loops does not auto-resolve — that's a separate layer). Each team gets its own branch, its own scratch files, and — with `DagConfig.environment` — its own stage, all born and torn down together.

For **dynamic** dispatch (a loop that discovers each unit at runtime and routes it to its own isolated sub-loop), `isolated(job)` is the same boundary as a composable wrapper rather than a predeclared node — fork, run, land back on pass:

```ts
loop({ name: 'triage', until: queueEmpty, body: pickAndDispatch });
// where pickAndDispatch routes each ticket to isolated(convergeLoop) or isolated(sweep)
```

## Loop archetypes — Converge, Sweep, Tend

A loop is not one shape. Three recur, and they differ in what memory does and in what you can even measure — a harness built for one is blind to the others.

| | **Converge** | **Sweep** | **Tend** |
| --- | --- | --- | --- |
| shape | one hard target, retried | a known set, one fresh task each | an unbounded process picking the next unit |
| example | build to a high bar with tests | research each OEM | triage issues until none remain |
| iteration N vs N−1 | the **same** task | an **independent** task | a **discovered** task |
| terminates when | the gate passes | the worklist is empty | a dynamic condition (maybe never) |
| memory's job | don't re-walk dead ends | transfer the house style | remember what's done + decided, forever |
| `loops` shape | `loop({ until: gate, max })` | `loop`/`dag` over a worklist | `loop({ until: dynamic, max: ∞ })` |

They **nest**: GitHub triage is Tend ∘ Converge (pick the next ticket, classify it, dispatch a Converge loop to a test gate); OEM research is Sweep ∘ Converge (each item is itself a multi-step build that must converge). Because a `loop` and a `dag` are both `Job`s, dispatch is just a body that selects a sub-`Job` — wrap it in `isolated()` when each needs its own worktree. The Ledger's three tiers (scratch files → milestone commits → consolidated ledger) map onto the three nesting levels.

There is no `converge()` / `sweep()` / `tend()` in the API — they are patterns, not primitives. Copy-paste recipes for each (and the nested dispatch) are in [docs/patterns.md](docs/patterns.md); the full treatment is in [docs/concepts.md](docs/concepts.md).

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

### Rate limits, quotas, and budgets — wait or resume

When a run hits a provider **rate limit**, an account **usage allowance**, or its own **token budget**, the `onLimit` policy decides what happens. The default, `auto`, **waits** when the reset is known and within a cap, otherwise **checkpoints and exits** with a ready-to-paste resume command.

| Option      | CLI flag                | Default | Effect                                                                                              |
| ----------- | ----------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `onLimit`   | `--on-limit <policy>`   | `auto`  | `auto` waits a known reset ≤ `maxWaitMs`, else pauses · `wait` always waits a known reset · `exit-resume` never waits · `fail` is the old fatal behaviour |
| `maxWaitMs` | `--max-wait <dur>`      | `300000` (5m) | Ceiling on a single interruptible limit-wait under `auto`/`wait`. |

A wait is **interruptible** (Ctrl-C unwinds it). When the policy gives up — the reset is unknown, the wait exceeds `maxWaitMs`, or the policy is `exit-resume` (and always for a `budget`, which never refreshes mid-run) — the run ends with the terminal status **`paused`** (exit code **75**, `EX_TEMPFAIL`, distinct from `fail`'s `1`) so a wrapper/cron can tell "paused, resumable" from "failed". With `--checkpoint` set, the resume command is printed ready to paste; without one, the guidance says to re-run with `--checkpoint` to make a pause resumable.

The error taxonomy backs this: an engine classifies a throttle into a `RATE_LIMIT` or `QUOTA` `LoopError` carrying the reset hint (`retryAfterMs` / `resetAt`) it could read. `RATE_LIMIT` is retryable; `QUOTA` is retryable only when a reset is known; `BUDGET` never is.

## Output — TUI, plain, JSON

- **Ink TUI** (default on a TTY): a live loop/dag tree, a per-iteration detail panel you can browse while the run continues, and a stats footer. Navigate with `↑/↓` (nodes), `←/→` (iterations), `f`/`space` (follow-live), `q`/`Esc`/`Ctrl-C` (abort).
- **`--no-tui`**: streamed line logs, one concise report per completed iteration, e.g. `↳ iter 2: body=fail · until=not met · review=fail (needs X) · 1.2k/0.3k tok`.
- **`--json`**: NDJSON event stream on stdout.

Every mode ends with a summary: result, per-loop iterations, review tallies, token usage by model, and any errors.

## What `loops` is (and isn't)

`loops` is a **fresh-context loop primitive**, not a durable workflow engine. The design bet is that **the workspace is the state**: progress _and its reasoning_ live in git (the Ledger), so each iteration can start clean and still know what came before. If the process dies mid-run, you re-run against the same workspace — the worktree holds the files, the scratch files hold the why, the log holds the milestones — and continue. You lose the bookkeeping, not the work.

It deliberately does **not** do durable mid-run replay (re-running a half-finished graph and skipping completed steps) — that's an orchestration concern; for it, embed a `loops` job as a step inside [Temporal](https://temporal.io), [LangGraph](https://github.com/langchain-ai/langgraphjs), or [Mastra](https://mastra.ai). What it _does_ offer (run records, a thin state checkpoint, a token budget) is the lightweight version that fits the workspace-is-state model.

| You want…                                          | Reach for…                          |
| -------------------------------------------------- | ----------------------------------- |
| Loop an agent to convergence with a real done-gate | **loops** (you're here)             |
| Durable, resumable, replayable workflows           | Temporal / LangGraph / Mastra       |
| One agent call with tool use                       | your provider's SDK directly        |

## Roadmap

- [x] **Ledger** — git-memory core: the scratch files (working memory + handoff), grounding, milestone commits
- [x] Worktree isolation (branches-as-teams) with `--no-ff` land-back
- [x] Environment axis — provider interface + offline mock
- [ ] Publish to npm (with a built `dist` + `exports`)
- [ ] Optional `wip:` autosave tier (per-iteration recovery, squashed on convergence)
- [ ] Calibration helpers for agent judges
- [ ] More engine adapters (OpenAI, local models)
- [ ] Scrollable per-iteration transcript in the TUI

## Develop

```bash
npm test          # vitest — offline, deterministic via the mock engine
npm run typecheck # tsc --noEmit
```

Contributions welcome — open an issue to discuss anything substantial first. Keep the core small; that smallness is the point.

## License

[MIT](./LICENSE)
