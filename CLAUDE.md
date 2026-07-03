# loops — agent guide

`loops` is a small, nestable job primitive for driving AI agents in **convergence loops**: do a bit of work with a fresh context, check whether the work is *actually* done against a gate you define, and if not, go again. The user-facing tour is `README.md`; this file is the operating guide for an agent working *on* the library.

`AGENTS.md` is a symlink to this file.

## Mental model (the one idea everything hangs off)

There is one universal unit of work and two supporting types:

- `Job = (ctx) => Promise<Outcome>` — a unit of work of any size.
- `Condition = (ctx, last) => Promise<{ met, reason, confidence? }>` — a yes/no gate.
- `Engine` — a one-method interface (`run(req, onEvent, signal)`) where an agent turn actually executes.

`loop()` returns a `Job`. `dag()` returns a `Job`. So loops and DAGs nest both ways: a DAG node can be a loop, a loop body can be a DAG. **Nesting is the absence of a special case, not a feature.** Preserve that property in any change; do not add a node type that only works in one position. `pipeline()` is sugar over `dag()`, not a new node type.

The failure policy rides the `Outcome` status. In a dag, a failed **required** producer blocks its dependents; a failed **optional** producer neither fails the dag nor blocks its dependents (consumers must tolerate its artifacts being absent); an unmet `when` skips the node, which counts green. `paused` is a halt, not a failure: a paused body or node (an unacknowledged `humanGate`, a hit limit) stops the enclosing loop/dag immediately and propagates to the root, so the run exits 75 with resume guidance; the acknowledgement lives in `ctx.state` (seeded by CLI `--ack <name>` or a `state` seed), and resume re-executes the whole job from the top — the workspace is the state, so the seeded ack makes the gate pass on the second run.

Two design tenets that must survive every edit:

1. **Honest convergence.** "Ask the model if it is done" is the trap the library exists to avoid. A gate combines a deterministic signal (`commandSucceeds` — the tests really pass) with a separate judge (`agentCheck`). Hardening lives in `quorum` (k-of-n jury) and the judge's `dimensions` (opens on the geometric mean, so one weak dimension drags the verdict down). `toVerdict` treats a missing confidence as `0` (fail-closed). Never reintroduce a "yes ⇒ 1.0" default.
2. **The workspace is the state.** Progress accumulates on disk (files, git), so each iteration starts clean. The loop carries only thin bookkeeping. This is why the library deliberately does not do durable mid-run replay; that is an orchestration concern (embed a loops job inside Temporal/LangGraph/Mastra if you need it).

## Source map

```
src/api.ts            public surface — the package's only export ("." → ./src/api.ts)
src/index.ts          CLI entry (run via tsx)
src/cli.tsx           commander CLI: flags mode + `run <file>` definition mode, --ack /
                      --ground / resume guidance, validate/describe, and the
                      supervision reads (list / status --recent / tail / records)
src/config.ts         flags mode → the standard worker → until → review loop (zod-validated)
src/reporters.ts      --no-tui (plain) and --json (NDJSON) reporters + the exit summary
src/core/
  types.ts            shared types: Job/Outcome/Condition (ConditionResult.output is the
                      evidence channel), JobContext (lastGate, envOverlay, groundDefault),
                      LoopConfig/DagConfig, the LoopEvent union
  job.ts              job builders: agentJob (env, ground, leaf, the outcome mapper's
                      `parts`), fnJob, commitJob; parseHandoff/HANDOFF_MARK (the
                      handoff contract)
  loop.ts             loop(): start → body → until → review, with retry/delay/caps;
                      threads lastGate, samples noProgress, propagates paused
  dag.ts              dag()/sequence()/parallel(): toposort, needs/optional/when,
                      bounded cross-stage kickback (re-run a dirty subgraph); a failed
                      optional producer neither fails the dag nor blocks dependents
  pipeline.ts         pipeline(name, stages): ordered named stages as sugar over dag(),
                      plus renderPipelineTable (stages as a markdown table)
  condition.ts        commandSucceeds, agentCheck (dimensions, confidenceTag, cwd,
                      timeoutMs, maxReasonChars), quorum, all/any/not, predicate,
                      forgeChecks, toVerdict, gateJob (output rides Outcome.data)
  progress.ts         no-progress (stall) detection — the ProgressTracker novelty
                      rule behind LoopConfig.noProgress, the third hard stop (opt-in
                      `gate` channel fingerprints the failing gate's output)
  human.ts            humanGate()/humanGateKey/pausedHumanGate — the pause only a person
                      lifts (paused, exit 75; ack via ctx.state, seeded by CLI --ack)
  agent.ts            AgentDef/defineAgent/defineSkill/fromFile — the typed contract
                      around a markdown persona (humanGates, failureModes, tiers)
  agent-md.ts         defineAgentFromMarkdown: load a Claude Code agent .md into an
                      AgentDef (scoped frontmatter grammar; Task/Agent dropped; leaf)
  feedback.ts         reviewPanel/reviewContext, revisionRequest/kickback,
                      feedbackBlock/graphPositionBlock — the structured review channel
  describe.ts         JobMeta side tables: jobMeta/renderPlan/describeConditions
                      (powers `loops validate`/`describe`)
  assert-graph.ts     assertGraph(job, shape): jobMeta introspection as test assertions
  git.ts              the git substrate: thin execa wrappers (commit, log, worktrees,
                      merge, workspaceFingerprint)
  draft.ts            the scratch files: ledger.md (working memory) + prompt.md (handoff)
  ground.ts           the read side: groundingText/retrieveLedger (branch-local commit log)
  consolidate.ts      consolidate/consolidateJob/compactLedger/composeCommitBody —
                      decision-preserving folds of the log
  merge.ts            mergeSynthesis: an agent resolves the conflict + writes a unified way
  forge.ts            Forge seam (PR host): GhForge (gh CLI) + MockForge, arg-builders
  pr.ts               pushJob / pullRequestJob / mergeJob — keep the squash body a
                      consolidation of the branch so the Ledger survives a squash merge
  isolated.ts         isolated(job): per-dispatch worktree fork + land-back (dynamic Tend)
  tournament.ts       tournament(): N candidates in isolated worktrees, judge, land the winner
  env-overlay.ts      withEnv(overlay, job) + mergeEnv — env pinning for a job subtree
                      (process.env < environment.env < overlay < per-call env)
  budget.ts           Budget + assertBudget (non-retryable BUDGET LoopError)
  limits.ts           RATE_LIMIT/QUOTA classification + the reset-hint math behind onLimit
  redact.ts           redactSecrets (shape patterns) + redactEnvValues (pinned values)
  stats.ts            event-stream fold for the TUI footer and exit summary
  text.ts             oneLine/truncate helpers
  context.ts          childContext: thread JobContext fields in exactly one place
  errors.ts           LoopError + terminal status taxonomy
src/engines/
  engine.ts           Engine interface + EngineOptions (permissionMode,
                      minToolIntervalMs) + toolPacer
  claude-cli.ts       `claude` subprocess via execa; exported buildClaudeArgs()
  agent-sdk.ts        @anthropic-ai/claude-agent-sdk; the only engine honoring
                      minToolIntervalMs (it mediates tool calls in-process)
  anthropic-api.ts    @anthropic-ai/sdk (token streaming; cheapest for judges)
  codex.ts            `codex exec` subprocess — a genuinely different model behind the
                      same seam; read-only unless bypassPermissions
  message-map.ts      shared stream-json → EngineStreamEvent mapping (SDK + claude CLI)
  mock.ts             scripted, offline — for tests/examples
  registry.ts         name → Engine resolution (lazy factories)
src/runtime/
  runner.ts           the run() driver: RunOptions (ground, budget, checkpoint/resume,
                      supervise, onLimit) → RunResult; owns the root context
  persist.ts          makeRecorder (JSONL), makeCheckpointer/loadCheckpoint
  supervisor.ts       the file registry (~/.loops/runs): startSupervisor writes;
                      listRuns/readRunStatus/readRunProgress/formatEvent read
  semantic.ts         semanticRecordsFromEvent + makeSemanticRecorder — the decision
                      stream (dispatch/completion/surfacing/revision) behind `records`
  hub.ts, signals.ts  event fan-out + abort plumbing
src/env/
  environment.ts      the Environment seam (up/down, EnvHandle) — where the code runs
  command.ts          commandEnvironment: the generic deploy/outputs/destroy CLI factory
  sst.ts, docker.ts   thin presets over commandEnvironment (per-branch stage / compose project)
  mock.ts             scripted, offline environment — for tests/examples
src/tui/              Ink TUI (App.tsx, model.ts, theme.ts)
bin/loops.mjs         the bin shim (see "Running" below)
examples/*.loop.ts    runnable definition files (mock engine = offline)
tests/                vitest
```

## Develop

No build step to develop: [`tsx`](https://github.com/privatenumber/tsx) runs the TypeScript source directly from a checkout (tests, typecheck, examples, and the bin all execute `src/` with no compile). The **published** package is built — `npm run build` (tsup) compiles `src/` to `dist/` (ESM + `.d.ts`), and its `exports`/`main`/`types` point at `./dist`. So `src/api.ts` is the seam you edit; `dist/api.js` is what an installed consumer imports.

```bash
npm test          # vitest — offline + deterministic via the mock engine
npm run typecheck # tsc --noEmit
npm run example:poll   # offline demo, no key
node bin/loops.mjs --help
```

Requires Node >= 20. Published to npm as [`@loops-adk/core`](https://www.npmjs.com/package/@loops-adk/core) — public, `0.x` alpha, so the API can still break on a minor bump. Releases go through CI: `npm version <patch|minor|major>` (bumps `package.json` + tags), then `git push --follow-tags` fires the `Release` workflow (`.github/workflows/release.yml`), which runs the typecheck + tests and `npm publish --provenance --access public` on the `v*` tag; the workflow can also be run by hand (workflow_dispatch) to publish whatever version `main` carries — for re-running a failed publish, or when tags cannot be pushed. Publish auth is npm **trusted publishing** (OIDC): the package's npmjs.com settings name this repo + workflow as a trusted publisher, so there is no token secret, and the workflow must not write any auth config (a token line in `.npmrc` shadows OIDC; that is why setup-node has no `registry-url`). A hand publish with `npm publish` from a logged-in machine still works (`prepack` builds, `prepublishOnly` typechecks — run the tests yourself, they are not in that gate) but carries no provenance attestation; the CI path does.

## Running .loop.ts files (the tsx loading model)

`loops run <file>` imports and executes a definition file's default-exported `Job`. `bin/loops.mjs` registers tsx's ESM loader **globally** before handing off to the CLI, so a `.loop.ts` is transformed **wherever it lives** — under this package's tree or in a consumer repo that has `loops` installed. `loops validate <file>` is the offline pre-flight: it loads and constructs the loop (catching syntax, import, transform, and bad-export errors) without running it, and reports a fix-oriented error so an authoring agent self-corrects before spending a turn.

One requirement survives: the recipe's folder must be an ES module scope (a `package.json` with `{"type":"module"}`) so this library's ESM-only dependencies (execa → unicorn-magic) resolve as ESM. Repos that consume `loops` as a submodule or dependency already have this. A load that fails with an ES-module error is missing that scope, and `loadJob`'s error says so.

The authoring guide an agent reads to compose a loop is `skills/author-loop/SKILL.md`. The run-from-anywhere contract is covered by `tests/run-anywhere.spec.ts` (it spawns the bin against a consumer-shaped out-of-tree recipe).

## Consumption

Consumable two ways: as a published npm package (`npm i @loops-adk/core`, importing the built `dist` via the `.` export) or as a **git submodule** (source import via `tsx`, no build). Either way a parent recipe imports the public surface (`@loops-adk/core`, which is `src/api.ts`) and registers its own engines/conditions; it never reaches into `src/core` internals. Keep `src/api.ts` the single seam.

## Conventions

- Keep the core small; that smallness is the point. Resist adding configuration or node types that are not pulling their weight.
- Match the surrounding style. Conditions are pure where they can be; side effects live in engines and the runner.
- Evergreen language in all docs and comments (no "currently", "now", "recently"); use versions or explicit references where timing matters.
- Tests run offline against the mock engine. A change to convergence logic needs a deterministic test, not a live model call.
