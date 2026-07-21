# loops — agent guide

`loops` is a nestable job primitive for driving AI agents in **convergence loops**: do a bit of work with a fresh context, check whether the work is *actually* done against a gate you define, and if not, go again. The user-facing tour is `README.md`; this file is the operating guide for an agent working *on* the library.

`AGENTS.md` is a symlink to this file.

## Mental model

There is one universal unit of work and two supporting types:

- `Job = (ctx) => Promise<Outcome>` — a unit of work of any size.
- `Condition = (ctx, last) => Promise<{ met, reason, confidence? }>` — a yes/no gate.
- `Engine` — a one-method interface (`run(req, onEvent, signal)`) where an agent turn actually executes.

`loop()` returns a `Job`. `dag()` returns a `Job`. So loops and DAGs nest both ways: a DAG node can be a loop, a loop body can be a DAG. **Nesting is the absence of a special case, not a feature.** Preserve that property in any change; do not add a node type that only works in one position. `pipeline()` is sugar over `dag()`, not a new node type.

The philosophy in three verbs: **iterate, depend, judge** — the structured program theorem's sequence/selection/iteration (Böhm & Jacopini, 1966) applied to agent work, with the gate standing in for selection because "is it done" is the contested question. Loops iterate, graph edges depend, gates judge; **preemption** (rewriting a running graph mid-flight) is the deliberate fourth verb on the roadmap, approximated by Tend-style dispatch until then. The README leads with this framing; keep new docs and API language aligned to it.

The failure policy rides the `Outcome` status. In a dag, a failed **required** producer blocks its dependents; a failed **optional** producer neither fails the dag nor blocks its dependents (consumers must tolerate its artifacts being absent); an unmet `when` skips the node, which counts green. `paused` is a halt, not a failure: a paused body or node (an unacknowledged `humanGate`, a hit limit) stops the enclosing loop/dag immediately and propagates to the root, so the run exits 75 with resume guidance; the acknowledgement lives in `ctx.state` (seeded by CLI `--ack <name>` or a `state` seed). With `--checkpoint`, completed green DAG nodes are restored from checkpoint on resume; non-DAG jobs rerun as ordinary jobs. The workspace remains the state, so restored nodes must have already made their durable effects visible there.

Two design tenets that must survive every edit:

1. **A real done-check.** "Ask the model if it is done" lets the model grade its own homework. A gate combines a deterministic signal (`commandSucceeds`, the tests really pass) with a separate judge (`agentCheck`). Hardening lives in `quorum` (k-of-n jury) and the judge's `dimensions` (opens on the geometric mean, so one weak dimension drags the verdict down). `toVerdict` treats a missing confidence as `0` (fail-closed). Never reintroduce a "yes ⇒ 1.0" default.
2. **The workspace is the state.** Progress accumulates on disk (files, git), so each iteration starts clean. The loop carries only thin bookkeeping. This is why the library deliberately does not do durable mid-run replay; that is an orchestration concern (embed a loops job inside Temporal/LangGraph/Mastra if you need it).

## Source map

```
src/api.ts            public surface — the package's only export ("." → ./src/api.ts)
src/index.ts          CLI entry (run via tsx)
src/cli.tsx           commander CLI: flags mode + `run <file>` definition mode, --ack /
                      --ground / resume guidance, validate/describe, the supervision
                      reads (list / status --recent / tail / records), and `helm`
                      (the conversational harness; see docs/helm.md)
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
                      optional producer neither fails the dag nor blocks dependents;
                      with a `plan` (LivePlan) the dag is live/steerable — epoch
                      scheduler, per-node abort, safepoint edit application, and a
                      guard keeping crystallized (passed) nodes immutable
  plan.ts             LivePlan/livePlan: the versioned, steerable graph behind a live
                      dag (docs/momentum.md) — atomic edit batches (add/remove/rewire/
                      cancel/reprioritise) validated per batch (the live toposort),
                      templates for out-of-process adds, guards + subscribers
  momentum.ts         momentumFromEvents: crystallization (gated completions), steers,
                      stalls → the alive/idle/stalled/done read behind `loops status`
  pipeline.ts         pipeline(name, stages): ordered named stages as sugar over dag(),
                      plus renderPipelineTable (stages as a markdown table)
  condition.ts        commandSucceeds, agentCheck (dimensions, confidenceTag, cwd,
                      timeoutMs, maxReasonChars), quorum, all/any/not, predicate,
                      forgeChecks, toVerdict, gateJob (output rides Outcome.data)
  guards.ts           the hardening gates: ratchet (runtime-owned monotone baseline,
                      written only in the improving direction), writeScope (declared
                      write lanes over git status), sampled (deterministic sha256
                      bucket for expensive judges); all fail closed
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
  curate.ts           curated grounding: declared sources (contained, globbed,
                      capped), the curation turn (brief + kept sources + ladder
                      rung; lenient parse, strict validate, fail-closed to plain
                      grounding and rung 0), all inert unless configured;
                      --no-curate/--no-ladder are the run-level A/B switches
  merge.ts            mergeSynthesis: an agent resolves the conflict + writes a unified way
  forge.ts            Forge interface (PR host): GhForge (gh CLI) + MockForge, arg-builders
  pr.ts               pushJob / pullRequestJob / mergeJob — keep the squash body a
                      consolidation of the branch so the Ledger survives a squash merge
  isolated.ts         isolated(job): per-dispatch worktree fork + land-back (dynamic Tend)
  tournament.ts       tournament(): N candidates in isolated worktrees, judge, land the winner
  env-overlay.ts      withEnv(overlay, job) + mergeEnv — env pinning for a job subtree
                      (process.env < environment.env < overlay < per-call env)
  budget.ts           Budget + assertBudget (non-retryable BUDGET LoopError)
  cost.ts             costReport: price measured usage from a caller-supplied
                      table (never silently $0; unpriced models named) + the
                      reconstructed baseline (same tokens at a ceiling model's
                      rates, labeled a reconstruction)
  limits.ts           RATE_LIMIT/QUOTA classification + the reset-hint math behind onLimit
  redact.ts           redactSecrets (shape patterns) + redactEnvValues (pinned values)
  stats.ts            event-stream fold for the TUI footer and exit summary
  text.ts             oneLine/truncate helpers
  context.ts          childContext: thread JobContext fields in exactly one place
  errors.ts           LoopError + terminal status taxonomy
src/engines/
  engine.ts           Engine interface + EngineOptions (permissionMode,
                      minToolIntervalMs) + toolPacer
  settle.ts           settleOnExit: bound a CLI engine's await to process exit,
                      not stream close — an orphaned helper holding the
                      inherited stdio pipes must not pin a completed turn
  claude-cli.ts       `claude` subprocess via execa; exported buildClaudeArgs()
  agent-sdk.ts        @anthropic-ai/claude-agent-sdk; the only engine honoring
                      minToolIntervalMs (it mediates tool calls in-process)
  anthropic-api.ts    @anthropic-ai/sdk (token streaming; cheapest for judges)
  codex.ts            `codex exec` subprocess — a different model behind the
                      same interface; read-only unless bypassPermissions
  message-map.ts      shared stream-json → EngineStreamEvent mapping (SDK + claude CLI)
  failure.ts          EngineFailureKind taxonomy + classifyEngineFailure; the
                      LANE_DEAD_FAILURES split (won't heal in-run → fallback's
                      trigger) vs limits (onLimit policy owns those)
  fallback.ts         fallbackEngine: the chain as an engine combinator — lane-dead
                      reroute, latched; never swallows RATE_LIMIT/QUOTA by default
  preflight.ts        one tiny live turn per lane, classified — the online
                      counterpart to the offline `loops validate`
  mock.ts             scripted, offline — for tests/examples
  registry.ts         name → Engine resolution (lazy factories)
src/runtime/
  runner.ts           the run() driver: RunOptions (ground, budget, checkpoint/resume,
                      supervise, onLimit) → RunResult; owns the root context
  persist.ts          makeRecorder (JSONL), makeCheckpointer/loadCheckpoint
  supervisor.ts       the file registry (~/.loops/runs): startSupervisor writes;
                      listRuns/readRunStatus/readRunProgress/formatEvent read
  control.ts          the registry's command side (control.jsonl): requestControl
                      writes from another process; startControlChannel polls in the
                      run — pause (safepoint, exit 75), abort, steer (LivePlan edits)
  listener.ts         force over HTTP: startWebhookListener (in-run — webhooks
                      ingested, bearer/HMAC validated, filtered + routed by the
                      recipe's `route` into control commands; GET /momentum reads
                      back) + startRegistryGateway (`loops listen`, one port
                      fronting every supervised run) + webhookSignatureValid
  semantic.ts         semanticRecordsFromEvent + makeSemanticRecorder — the decision
                      stream (dispatch/completion/surfacing/revision) behind `records`
  semantic-schema.ts  strict semantic record v1 Zod contract, JSON Schema source,
                      canonical kind vocabulary, and the 0.7.0 in-memory adapter
  hub.ts, signals.ts  event fan-out + abort plumbing
src/helm/
  intent.ts           the driver contract: 9 intents (zod), lenient wrapper parser
                      (fences, balanced-brace scan, control-char repair), strict
                      validator; HelmParseError vs HelmIntentError stay distinct
                      because the eval scores them separately
  system.ts           the byte-stable contract prompt (budget-in-context,
                      dispatch-is-a-pause-point, authoring cheatsheet)
  bridge.ts           executes intents: validate/author/run/ack spawn the bin
                      (fresh process; durable fire-and-poll dispatch via --run-id);
                      status/records read the registry in-process; paths contained
                      to the workspace, no free-form shell
  session.ts          the helm turn loop over any Engine: transcript fold into a
                      fresh-context prompt, one repair reprompt, turn ends at a
                      dispatch; transcript JSONL under ~/.loops/helm/<sessionId>
  oracle.ts           the offline stub driver (deterministic keyword policy) — the
                      eval's 1.0 control ceiling and the tests' offline helm
  score.ts, eval.ts   the driver eval: 10-case battery, 4 deterministic dims
                      (json/schema/action/executed), JSONL attempt ledger
  cli.ts              `loops helm` REPL/one-shot (lazy-imported by cli.tsx)
src/env/
  environment.ts      the Environment interface (up/down, EnvHandle) — where the code runs
  command.ts          commandEnvironment: the generic deploy/outputs/destroy CLI factory
  sst.ts, docker.ts   thin presets over commandEnvironment (per-branch stage / compose project)
  mock.ts             scripted, offline environment — for tests/examples
src/tui/              Ink TUI (App.tsx, model.ts, theme.ts)
bin/loops.mjs         the bin shim (see "Running" below)
examples/*.loop.ts    runnable definition files (mock engine = offline;
                      engine-smoke.loop.ts is the one live-engine smoke)
tests/                vitest
```

## Develop

No build step to develop: [`tsx`](https://github.com/privatenumber/tsx) runs the TypeScript source directly from a checkout (tests, typecheck, examples, and the bin all execute `src/` with no compile). The **published** package is built — `npm run build` (tsup) compiles `src/` to `dist/` (ESM + `.d.ts`), and its `exports`/`main`/`types` point at `./dist`. So `src/api.ts` is the entry point you edit; `dist/api.js` is what an installed consumer imports.

```bash
npm test          # vitest — offline + deterministic via the mock engine
npm run typecheck # tsc --noEmit
npm run example:poll   # offline demo, no key
npm run docs:dev  # the docs site (VitePress) with a freshly generated API reference
node bin/loops.mjs --help
```

The public docs site lives in `site/`: hand-authored guides in `site/guide/`,
and an API reference generated by TypeDoc from `src/api.ts` into `site/api/`
(gitignored — `npm run docs:api` regenerates it; `docs:build` always does).
TypeDoc runs with zero warnings because `src/api.ts` re-exports every type a
public signature references — keep it that way when adding exports. The
`Docs` workflow (`.github/workflows/docs.yml`) builds and deploys the site to
GitHub Pages on every `main` push.

Requires Node >= 20. Published to npm as [`@loops-adk/core`](https://www.npmjs.com/package/@loops-adk/core) — public, `0.x` alpha, so the API can still break on a minor bump. Every notable change lands in `CHANGELOG.md` (Keep a Changelog format) **in the same PR as the change** — an `Unreleased` entry, under Added/Changed/Fixed/Removed. This is a gate, not a convention: the `Release` workflow and `prepublishOnly` run `scripts/changelog-gate.mjs`, which refuses to publish a version the changelog does not describe (or a tag that does not match `package.json`). Releases go through CI, keyed to the version bump rather than a hand-pushed tag: retitle `Unreleased` to the new version with the date, `npm version <patch|minor|major>`, then `git push` — the `Release` workflow (`.github/workflows/release.yml`) sees a `main` push whose `package.json` version has no `v*` tag yet, runs the changelog gate + typecheck + tests, **creates and pushes the tag itself**, runs `npm publish --provenance --access public`, and creates the GitHub Release with the version's changelog section as its body (`scripts/changelog-section.mjs` — one source of truth, no hand-written release notes). Each publish step is idempotent, so a partially-completed release is finished by the next push. A push that does not bump the version is a no-op for the workflow. Pushing a `v*` tag by hand still works, as does the manual trigger (workflow_dispatch publishes whatever version `main` carries) — for re-running a failed publish. The tagger and publisher are one workflow on purpose: tags pushed with the default `GITHUB_TOKEN` do not trigger other workflows (GitHub's anti-recursion rule), so a two-workflow cascade would fail silently. Publish auth is npm **trusted publishing** (OIDC): the package's npmjs.com settings name this repo + workflow as a trusted publisher, so there is no token secret, and the workflow must not write any auth config (a token line in `.npmrc` shadows OIDC; that is why setup-node has no `registry-url`). A hand publish with `npm publish` from a logged-in machine still works (`prepack` builds, `prepublishOnly` typechecks — run the tests yourself, they are not in that gate) but carries no provenance attestation; the CI path does.

## Running .loop.ts files (the tsx loading model)

`loops run <file>` imports and executes a definition file's default-exported `Job`. `bin/loops.mjs` registers tsx's ESM loader **globally** before handing off to the CLI, so a `.loop.ts` is transformed **wherever it lives** — under this package's tree or in a consumer repo that has `loops` installed. `loops validate <file>` is the offline pre-flight: it loads and constructs the loop (catching syntax, import, transform, and bad-export errors) without running it, and reports a fix-oriented error so an authoring agent self-corrects before spending a turn.

One requirement survives: the recipe's folder must be an ES module scope (a `package.json` with `{"type":"module"}`) so this library's ESM-only dependencies (execa → unicorn-magic) resolve as ESM. Repos that consume `loops` as a submodule or dependency already have this. A load that fails with an ES-module error is missing that scope, and `loadJob`'s error says so.

The authoring guide an agent reads to compose a loop is `skills/author-loop/SKILL.md`. The run-from-anywhere contract is covered by `tests/run-anywhere.spec.ts` (it spawns the bin against a consumer-shaped out-of-tree recipe).

## Consumption

Consumable two ways: as a published npm package (`npm i @loops-adk/core`, importing the built `dist` via the `.` export) or as a **git submodule** (source import via `tsx`, no build). Either way a parent recipe imports the public surface (`@loops-adk/core`, which is `src/api.ts`) and registers its own engines/conditions; it never reaches into `src/core` internals. Keep `src/api.ts` the single entry point.

## Conventions

- Keep the core focused. Resist adding configuration or node types that are not pulling their weight.
- Match the surrounding style. Conditions are pure where they can be; side effects live in engines and the runner.
- Evergreen language in all docs and comments (no "currently", "now", "recently"); use versions or explicit references where timing matters.
- Tests run offline against the mock engine. A change to convergence logic needs a deterministic test, not a live model call.
