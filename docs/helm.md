# Helm — talk to your loops

The helm is the conversational front door to `loops`. You type plain English;
a driver model turns it into a small set of structured actions (write a recipe,
check it, start it, watch it); the harness executes those actions in real code
and shows the driver what actually happened. You never have to remember the CLI
flags, and the driver never gets to hand-wave — every action it takes is a JSON
"intent" the harness validates before anything runs.

```bash
loops helm                                   # interactive REPL in this repo
loops helm "start fix.loop.ts in the background"   # one-shot
loops helm --engine codex --model gpt-5.2    # any engine can be the driver
```

A session looks like this:

```text
you › keep working on TASK.md until the tests pass, then stop
  → author file=task.loop.ts
  · authored task.loop.ts; it loads
  → run file=task.loop.ts
  · dispatched task-9f0a12 (task.loop.ts); it runs in the background — poll with status
helm › Dispatched task-9f0a12. Ask me how it's going anytime.

you › how's it going?
  → status runId=task-9f0a12
  · task-9f0a12: running, at task / implement, iteration 3
helm › Iteration 3, the test gate isn't met yet. I'll keep an eye on it.
```

## The idea in one paragraph

Chat interfaces fail in two opposite ways: either the model narrates ("I will
now run the tests…") without anything actually happening, or it gets full shell
access and you hope for the best. The helm walks the narrow path between them:
the model can only emit one of **nine intents**, each one is checked against a
strict schema, and the harness — plain TypeScript, no model — is the only thing
that touches your machine. The model decides *what* to do; deterministic code
decides *whether it's allowed* and *does it*.

## The nine intents

| Intent | What the harness does |
|---|---|
| `answer` | Nothing — just replies. A question must never spin up a run. |
| `author` | Writes a `*.loop.ts` recipe into the workspace, then validates it immediately. |
| `validate` | Loads a recipe and prints its shape. No model calls, no spend. |
| `run` | Starts a **supervised background run** and returns its run id. |
| `status` | Reads one run's live rollup (or lists all runs). |
| `records` | Reads a run's decision stream (dispatches, completions, revisions). |
| `ack` | Lifts a named human gate and resumes a paused run. |
| `stop_run` | Sends SIGTERM to a running dispatch. |
| `done` | Says the objective is met and ends the turn. |

Three details carry most of the safety:

- **Paths are contained.** `author`/`validate`/`run` only accept relative paths
  inside the workspace, and `author` refuses to overwrite a file it didn't
  write itself in this session.
- **No free-form shell.** The only thing the bridge ever executes is the
  `loops` CLI. If the driver wants something else to happen, it has to put it
  in a recipe — where your gates judge it.
- **Human gates stay human.** `ack` only works on runs this session started,
  and the contract tells the driver to ack only after you have explicitly
  approved in the conversation.

## Dispatch is a pause-point

When the driver starts a run, the run goes to the **background** as an ordinary
supervised run (the same kind `loops run --supervise` starts — `loops list`
sees it, and it keeps going even if you close the REPL). The helm's turn ends
right there, on purpose: models given an "is it done yet?" tool will poll it in
a tight loop and burn your budget. So the turn ends at the dispatch, and the
driver checks on the run only when you ask. This mirrors how the run itself
works — fresh context, state on disk, observe when needed.

Two more disciplines are baked into every turn, both learned from evaluating
cheap models as drivers:

- **The budget is visible.** Every step, the prompt says `step 3 of 8 this
  turn; runs dispatched: 1`. Models without a visible budget either give up
  early or never stop.
- **Invalid replies get one repair.** If the driver's reply isn't a valid
  intent, the harness quotes the exact error back and asks for a correction —
  once. A second bad reply ends the turn honestly instead of looping.

## Which models can drive this? The eval answers it

`src/helm/eval.ts` ships a small benchmark — ten single-turn cases balanced
across the contract (trivia that must NOT dispatch, authoring, pre-flight,
dispatch, the observation reads, gate-lifting, aborting, wrapping up). Scoring
is fully deterministic, no LLM-as-judge, four separate dimensions per attempt:

| Dimension | Weight | Question |
|---|---|---|
| `jsonValid` | 0.15 | Did the reply contain a JSON object at all? |
| `schemaValid` | 0.25 | Was it a valid intent? |
| `actionCorrect` | 0.40 | Was it the *right* intent? |
| `executedOk` | 0.20 | Did the bridge really perform it? (execute-cases only) |

The dimensions are kept separate because they fail differently: a chatty model
that wraps JSON in prose fails the first, a model that invents actions fails
the second, a model that dispatches a run to answer trivia fails the third.

There is also a built-in **offline oracle** — a deterministic keyword policy
that drives the contract perfectly with zero keys and zero network. It must
score 1.0; if it doesn't, the harness itself is broken, not a model. That makes
it both the eval's control ceiling and the offline driver the test suite uses.

```ts
import { evalDrivers, oracleEngine, prepareEvalWorkspace, renderEvalReport } from '@loops-adk/core';

prepareEvalWorkspace('/tmp/eval-ws');
const report = await evalDrivers(
  [
    { name: 'oracle', engine: oracleEngine() },          // the 1.0 control
    { name: 'claude-cli', engine: 'claude-cli' },             // a real driver
    { name: 'codex', engine: 'codex', model: 'gpt-5.2' },     // another vendor
  ],
  { cwd: '/tmp/eval-ws' },
);
console.log(renderEvalReport(report));
```

Every attempt is appended to a JSONL ledger (default
`<cwd>/.loops/helm-eval.jsonl`), so results accumulate across invocations.

## Embedding the helm

The REPL is one thin consumer. The session is a small API you can embed in
anything that can render an event stream:

```ts
import { HelmBridge, HelmSession } from '@loops-adk/core';

const session = new HelmSession({
  bridge: new HelmBridge({ cwd: process.cwd() }),
  engine: 'claude-cli',            // any Engine — mock in tests
});
for await (const event of session.send('validate fix.loop.ts')) {
  // { kind: 'say' | 'intent' | 'observation' | 'invalid' | 'usage' | 'turn-end', ... }
}
```

The driver runs through the same one-method `Engine` interface as loop bodies
and judges, so anything that can be an engine can be a driver — including the
scripted mock, which is how the whole harness is tested offline.

## Where things live

| Path | What |
|---|---|
| `~/.loops/helm/<sessionId>/transcript.jsonl` | The session transcript (append-only). |
| `~/.loops/runs/<runId>/` | Each dispatched run's registry entry — status, events, records, and `spawn.log`. |
| `<cwd>/.loops/helm-eval.jsonl` | The driver eval's attempt ledger. |

`LOOPS_HOME` relocates `~/.loops` (the tests use this to isolate themselves).

## Design notes

Four decisions carry the design, each one answering a documented failure mode
of putting a language model at the wheel of a harness:

- **Lenient wrapper, strict content.** Cheap models wrap JSON in prose and
  fences; inventing actions is a different failure than bad formatting. The
  parser tolerates the first, the validator hard-fails the second, and the
  eval scores them separately.
- **The budget is visible in-context.** A driver that cannot see its budget
  either quits early or never stops; stating `step 3 of 8` every turn makes
  termination behaviour a property of the model, not an accident of the
  harness.
- **Dispatch is a pause-point.** A driver handed an "is it done yet?" tool
  will poll it in a tight loop; ending the turn at a dispatch removes the
  loop-burn by construction.
- **The durable state is what loops already has.** No side database: the
  registry of supervised runs on the filesystem, git as memory, and gates as
  the arbiter of done. The helm is a thin conversational front on those
  primitives, which is why every dispatched run is an ordinary `loops run
  --supervise` that any other tool can observe.
