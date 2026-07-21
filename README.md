<p align="center">
  <img src="assets/logo.png" alt="loops" width="320">
</p>

<p align="center">
  <strong>A node can be a loop. A loop can be a node.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@loops-adk/core"><img src="https://img.shields.io/npm/v/@loops-adk/core" alt="npm"></a>
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="status: alpha">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%3E%3D20-3c873a" alt="node &gt;=20">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license: MIT">
</p>

`loops` orchestrates AI agents through real engineering work: pick up an issue, research it, write a plan a person can veto, build until the tests really pass, rework until the reviewers are satisfied, open the PR — then pick up the next issue. You write that discipline once, as code — a DAG of steps with loops nested inside — and it runs unattended, for an afternoon or a whole backlog. Any model can sit in any seat: a cheap one researches, a strong one builds, a different vendor reviews the work.

You can't make an LLM deterministic, and there is rarely one right answer in software. But the process of building it can be exact: which steps run and in what order, what each must pass, who reviews the work, when a person must step in. `loops` makes the process code — deterministic, repeatable, enforced — and leaves the creativity to the agent inside each step.

The process is what keeps a long run honest. Every step ends at a gate: tests that must pass, judges on other models, juries that must agree, people who approve the risky parts. A failed step gets the evidence and tries again with a clean context; a run can pause, crash, or hit a rate limit and pick up where it left off. Nothing moves forward on the model's say-so.

Agent memory is git itself. Each step starts fresh and reads the decisions so far from the commit log; when work lands, the reasoning is written back into the commit. No vector store, no database, no extra infrastructure — nothing to sync or go stale.

**Execution is cheap. Convergence is expensive.** — [*Convergence Count*](https://x.com/Jonny9811/status/2024472805543137347) (February 2026), the essay `loops` grew from.

```bash
npm i @loops-adk/core   # Node >= 20
```

## A day's work, as one file

Loops and graphs are not mutually exclusive. Real work isn't a straight line — some steps run once, some iterate until a bar is met — so a node in the graph can be a whole loop, and a loop's body can be a whole graph, at any depth. That combination is the simplest way to model how people actually work, and it's older than it looks: the [structured program theorem](https://en.wikipedia.org/wiki/Structured_program_theorem) (Böhm & Jacopini, 1966) showed that any computable control flow can be built from sequence, selection, and iteration alone. The graph carries the first two. The loop carries the third.

```ts
import {
  loop, dag, agentJob, agentCheck, commandSucceeds, predicate,
  humanGate, reviewPanel, pullRequestJob,
} from '@loops-adk/core';

// Build until lint and tests pass, then face the reviewers.
// A rejection re-runs the loop with their findings in the prompt.
const build = loop({
  name: 'build',
  max: 10,
  body: agentJob({
    prompt: 'Implement the next increment from PLAN.md. Small steps, with tests.',
    ground: true,          // read the plan, notes, and commit log first
    consumeFeedback: true, // review findings land here
  }),
  until: [commandSucceeds('npm', ['run', 'lint']), commandSucceeds('npm', ['test'])],
  review: reviewPanel({
    label: 'review',
    reviewers: [
      { name: 'adversarial', review: agentCheck({ question: 'What breaks?', engine: 'codex' }) }, // a different vendor
      { name: 'security', review: agentCheck({ question: 'Is it safe?', model: 'opus' }) },
      { name: 'completeness', review: agentCheck({ question: 'Is every acceptance criterion met?', model: 'sonnet' }) },
    ],
  }),
  commit: true,
});

// One issue, worked end to end.
const issue = dag({
  name: 'issue',
  nodes: {
    pickup:   agentJob({ label: 'pickup', prompt: 'Pick the next ready issue; branch; write ISSUE.md with acceptance criteria and a complexity call.' }),
    research: { needs: ['pickup'], job: agentJob({ label: 'research', prompt: 'Explore the code this touches; write NOTES.md.', ground: true }) },
    plan:     { needs: ['research'], job: agentJob({ label: 'plan', prompt: 'Write PLAN.md: increments, tests, risks.', ground: true }) },

    approval: {
      needs: ['plan'],
      when: highComplexity, // simple plans skip straight through
      job: humanGate({ name: 'plan-approval', prompt: 'Read PLAN.md, then approve.' }),
    },

    build:  { needs: ['approval'], job: build },
    docs:   { needs: ['build'], job: agentJob({ label: 'docs', prompt: 'Update docs and changelog.', ground: true }) },
    ship:   { needs: ['docs'], job: pullRequestJob({ base: 'main' }) },
    notify: { needs: ['ship'], optional: true, job: agentJob({ label: 'notify', prompt: 'Post a one-line PR summary to the team channel.' }) },
  },
});

// Keep going until the backlog is empty.
export default loop({ name: 'engineer', body: issue, until: predicate(backlogEmpty, 'backlog is empty'), max: 20 });
```

A high-complexity plan stops the run until a person reads it and resumes with `--ack plan-approval`. Posting to Slack is the agent's own job through its tools — the pipeline just decides when. Full file, including the `highComplexity` and `backlogEmpty` conditions: [`examples/engineer.loop.ts`](examples/engineer.loop.ts).

## The unit

Every step above is built from the same unit: do the work, check it, repeat until the check passes.

```ts
import { loop, agentJob, commandSucceeds, agentCheck } from '@loops-adk/core';

export default loop({
  name: 'build-feature',
  max: 20,
  body: agentJob({
    prompt: (c) => `Iteration ${c.iteration}: make concrete progress on TASK.md.`,
    ground: true, // read the commit log and notes before working
  }),
  until: [
    commandSucceeds('npm', ['test']),                                    // the truth
    agentCheck({ question: 'Does it match TASK.md?', threshold: 0.85 }), // the intent
  ],
  commit: { subject: 'feat: TASK.md' }, // one commit when it's done, reasoning included
});
```

Three rules hold everywhere:

- **"Done" is checked, not claimed.** The tests must pass, and a separate judge reviews the result. The model never grades its own work.
- **Every attempt starts fresh.** Progress lives in files and commits, not a growing chat history.
- **Git is the memory.** Decisions are written into commit messages and read back on the next attempt.

## Iterate, depend, judge

Strip the library to its verbs and three remain. In the theorem, selection and iteration both run on predicates the machine evaluates for free. In agent work, the predicate — is it done, is it safe, is it what was asked — is itself the contested question, so `loops` replaces the predicate with a gate. Judgment isn't a fourth structure; it's the predicate made honest. That triple is how the library models a working engineer:

- **Iterate** — drafts, retries, rework. A loop with a bar to clear.
- **Depend** — research before the plan, approval before the build. An edge in the graph.
- **Judge** — tests, juries, a person's veto. The gate that decides pass or go again.

The theorem also draws the line between `loops` and graph frameworks that allow cycles. A back-edge over shared state is a flowchart jump — `goto`, the thing structured programming retired. Here the graph is always acyclic, and iteration lives in one named construct with its own gate, caps, and stall detection. **Their cycles are `goto`; `loop()` is `while`.** That is not a claim about power — back-edges compute everything `while` does, just as `goto` did. The win was always reasoning, not capability (Dijkstra's argument in *Go To Statement Considered Harmful*, 1968), and it's the same win here: because the graph never jumps, its shape is knowable before a token is spent — `loops validate` and `assertGraph` exist because of that. Turing complete where it must be, decidable where it can be ([docs/theory.md](docs/theory.md)).

The fourth verb — **preemption**, a person dropping the plan mid-flight when the world changes — ships in its first slice as **steering**: a graph built on a `livePlan` can be rewritten while it runs (add, remove, rewire, cancel, reprioritise), with every edit batch validated before it applies, running work preempted through its own signal, and the whole history recorded. The Tend pattern (a loop whose body picks its next job at runtime, [docs/concepts.md](docs/concepts.md)) remains the shape for discovered worklists; steering is how the plan itself changes under you. The design and what remains of it are [docs/momentum.md](docs/momentum.md).

## Building blocks

**Check more than one thing.** An array means all of them must pass:

```ts
until: [
  commandSucceeds('npm', ['test']),                 // the truth
  agentCheck({ question: 'Ready to ship?', threshold: 0.85 }), // the intent
]
```

**Ask a jury, not a judge.**

```ts
quorum(2, // any 2 of 3 must agree
  agentCheck({ question: 'Is it correct?', model: 'opus' }),
  agentCheck({ question: 'Would this pass code review?', model: 'sonnet' }),
  agentCheck({ question: 'What breaks?', engine: 'codex' }),
)
```

**Show the failure to the next attempt.** A failed check hands over its evidence — test output, a judge's findings — so the next attempt fixes instead of rediscovering:

```ts
prompt: (c) => c.lastGate?.met === false
  ? `The gate failed:\n${c.lastGate.output}\n\nFix exactly that.`
  : 'Implement the feature in TASK.md.',
```

**Pause for a person.**

```ts
humanGate({ name: 'prod-approval', prompt: 'Review the staging deploy, then approve.' })
// the run stops (exit 75) until: loops run … --resume … --ack prod-approval
```

**Send work back.** A reviewer in a dag can return work to an earlier step; that step and everything after it run again:

```ts
revisionRequest({ target: 'implement', findings })
```

**Work in parallel without collisions.** Each writer gets its own git branch, merged back on pass:

```ts
dag({ name: 'team', isolation: 'worktree', nodes: { server, web, integrate } })
tournament({ name: 'best-of-3', n: 3, candidate, judge }) // try 3 approaches, keep the winner
```

**Steer a running graph.** Make the graph a `livePlan` and it becomes data you can edit while it runs — add discovered work, cancel a doomed branch, rewire the rest — validated per batch (the live toposort), applied at safepoints, recorded as `dag:edit` events. From another terminal, against a `--supervise` run:

```ts
const plan = livePlan({ name: 'sprint', nodes: { survey }, templates: { fix } })
dag({ name: 'work', plan }) // completes when a barrier settles with no new steer
```

```bash
loops steer  <runId> '[{"op":"add","name":"fix-9","template":"fix","params":{"issue":9}},
                      {"op":"cancel","name":"refactor"}]'
loops control <runId> pause   # finish the current turn, pause resumable (exit 75)
loops status  <runId>         # momentum: alive — 5 crystallized (2.4/h), 2 steers
```

A node that already passed cannot be edited — its work is a commit, its acceptance a gate verdict; the past is immutable. A `cancel` with `graceMs` preempts cooperatively: the node's `ctx.windDown` fires, a loop finishes its current iteration and yields, and the hard abort lands only at the deadline. In-graph steering is budgeted (`maxSteers`, default 100) so a self-modifying graph provably terminates; steers from the control channel are exempt — outside force is how an indefinite process stays alive. The design is [docs/momentum.md](docs/momentum.md); the offline demo is `npm run example:steer`.

**Remember between attempts.**

```ts
agentJob({ prompt, ground: true })  // read the notes and commit log before working
commit: { subject: 'feat: search' } // on success, write the why into the commit body
```

**Ground steps in the company knowledge base, alongside the git log.** Two memories feed each step: a small agent curates the exact business context from the knowledge base, and git already carries the implementation history — the decisions, the constraints, the why:

```ts
// A cheap agent pulls just the relevant business context…
context: agentJob({
  label: 'context',
  prompt: 'Query the company knowledge base (`qmd query …`) for everything relevant to ISSUE.md. Write a short brief to BRIEF.md.',
  model: 'haiku',
}),

// …and later steps ground on both: the curated brief and the commit history.
implement: {
  needs: ['context'],
  job: agentJob({
    prompt: 'Implement the next increment from PLAN.md.',
    ground: {
      sources: ['BRIEF.md', 'ISSUE.md'],                              // business context, declared
      curate: { engine: 'anthropic-api', model: 'claude-haiku-4-5' }, // one cheap turn keeps only what helps
    },
  }),
},
```

**Stop runaway loops.**

```ts
loop({ max: 50, noProgress: 3 })       // cap attempts; stop after 3 attempts that change nothing
await run(job, { budget: 2_000_000 })  // cap tokens for the whole run
```

**Test the running thing.** An `Environment` brings up a local stack or a preview deploy, and its variables reach the checks:

```ts
await run(job, { environment: dockerStack }) // gates now see BASE_URL of a live stack
```

## Engines

Any model can fill any role — a worker on one model, its reviewer on another.

| name            | backend                          | notes                                             |
| --------------- | -------------------------------- | ------------------------------------------------- |
| `claude-cli`    | `claude` subprocess              | uses host Claude auth, no key                     |
| `agent-sdk`     | `@anthropic-ai/claude-agent-sdk` | fresh `query()` per call                          |
| `anthropic-api` | `@anthropic-ai/sdk`              | cheapest for judges; needs a key                  |
| `codex`         | `codex exec` subprocess          | a different vendor behind the same interface      |
| `mock`          | scripted, offline                | for tests and examples                            |

Bring your own by implementing one method:

```ts
const myEngine: Engine = {
  name: 'my-provider',
  async run(req, onEvent, signal) {
    return { text, usage: { inputTokens, outputTokens }, model: req.model ?? 'x' };
  },
};
```

`fallbackEngine(['claude-cli', 'codex'])` moves to the next engine when one dies. `loops preflight` checks every engine with one tiny turn before the run spends anything.

## CLI

```bash
loops run feature.loop.ts               # run it (live TUI; --no-tui / --json)
loops validate feature.loop.ts          # load + print the shape; no model calls
loops describe feature.loop.ts --json   # machine-readable shape
```

Watch long runs from another terminal — no daemon, no socket, just files:

```bash
loops run build.loop.ts --supervise
loops list                            # every supervised run, with state
loops status <runId>                  # where it is and what's blocking it
loops tail <runId>                    # stream events live
loops records <runId> --kind revision # the decision stream, filtered
```

`loops helm` is a conversational front end: plain English in, validated commands out ([docs/helm.md](docs/helm.md)).

> `loops run <file>` imports and executes that file's module, like `node <file>`. Only run definition files you trust.

## Scope

`loops` is the flow, nothing more. Scheduling belongs in cron or CI; durable replay belongs in Temporal, LangGraph, or Mastra — embed a loops job inside them ([comparison](docs/comparison.md)). Acting in the outside world — Slack, GitHub, calendars — is the agent's job through its own tools; the loop decides when.

## Examples

Every example in [`examples/`](examples/) is a runnable definition file:

- [`simple-poll.loop.ts`](examples/simple-poll.loop.ts) — the smallest loop; offline (`npm run example:poll`)
- [`confidence-gate.loop.ts`](examples/confidence-gate.loop.ts) — a command check and a judge together
- [`engineer.loop.ts`](examples/engineer.loop.ts) — a day's work: issue → research → plan → approval → build → review → docs → PR, repeated
- [`dag-pipeline.loop.ts`](examples/dag-pipeline.loop.ts) — a flow with a loop inside and a jury at the end
- [`converge-review.loop.ts`](examples/converge-review.loop.ts) — a review rejection re-running the loop; offline
- [`feedback.loop.ts`](examples/feedback.loop.ts) — a reviewer sending work back to an earlier stage; offline
- [`feedback-pipeline.loop.ts`](examples/feedback-pipeline.loop.ts) — the same kickback in a full pipeline, decisions read back with `loops records`; offline
- [`build-service.loop.ts`](examples/build-service.loop.ts) — four engineer loops in one flow, five reviewers, two vendors
- [`ship-pr.loop.ts`](examples/ship-pr.loop.ts) — push → PR → gated squash-merge that keeps the reasoning
- [`stall-demo.loop.ts`](examples/stall-demo.loop.ts) — stopping a loop that's going nowhere (`npm run example:stall`)
- [`contracted-agent.loop.ts`](examples/contracted-agent.loop.ts) — a typed agent persona with a feedback contract
- [`params.loop.ts`](examples/params.loop.ts) — a recipe with its own CLI flags via `defineParams`
- [`feature-dev.ts`](examples/feature-dev.ts) — a reusable flow wrapped in a Commander CLI
- [`helm-offline.ts`](examples/helm-offline.ts) — the conversational front end, fully offline (`npm run example:helm`)
- [`engine-smoke.loop.ts`](examples/engine-smoke.loop.ts) — the one live-engine smoke test

## Docs

- [docs/concepts.md](docs/concepts.md) — the memory model and the three loop shapes (Converge, Sweep, Tend)
- [docs/patterns.md](docs/patterns.md) — copy-paste recipes: feedback, PR shipping, guard rails
- [docs/comparison.md](docs/comparison.md) — vs. Mastra and LangGraph
- [docs/theory.md](docs/theory.md) — the theorem, Turing completeness, and why the graph stays decidable
- [docs/helm.md](docs/helm.md) — the conversational front end
- [docs/momentum.md](docs/momentum.md) — the design for preemption: past/frontier/future, momentum, steering, safepoints
- [docs/semantic-records.md](docs/semantic-records.md) — the decision-stream contract behind `loops records`
- [skills/author-loop/SKILL.md](skills/author-loop/SKILL.md) — the guide an agent reads to write a loop

## Roadmap

- **Preemption, the rest of it** — shipped: `livePlan` steering, cooperative wind-down (`cancel` + `graceMs`), the in-graph steer budget, and out-of-process control (`loops steer` / `loops control pause|abort`), per [docs/momentum.md](docs/momentum.md). Still to come from that design: park-and-consolidate for preempted work, and kickback injection from outside.
- `convergence count` (turns from intent to outcome) and `cost per accepted change` as first-class reported metrics, joining the `momentum` read in `loops status`
- Calibration helpers for agent judges
- More engine adapters (OpenAI, local models)

## Develop

```bash
git clone https://github.com/jonny981/loops.git && cd loops && npm install
npm test               # offline, deterministic
npm run typecheck
node bin/loops.mjs --help
```

No build step from a checkout — the CLI runs the TypeScript source via [`tsx`](https://github.com/privatenumber/tsx). Status: alpha; [CHANGELOG.md](CHANGELOG.md) records what each version added or broke.

Contributions welcome. Open an issue to discuss anything substantial first.

## License

[MIT](./LICENSE)
