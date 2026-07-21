# Changelog

All notable changes to `@loops-adk/core`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org) with the `0.x` caveat stated in the README: the
API may still break on a minor bump.

Maintainer's note: update the `Unreleased` section in the same PR as the
change; `npm version` day is when `Unreleased` becomes the new version
heading, dated, before the tag is pushed.

## [Unreleased]

### Added

- **Live dags — the first slice of preemption (docs/momentum.md).**
  `livePlan()` makes a dag's graph data: a versioned plan whose edit batches
  (`add`/`remove`/`rewire`/`cancel`/`reprioritise`) are validated atomically
  before they apply — unknown deps, dangling consumers, and cycles refuse the
  whole batch (the live toposort) — and `dag({ plan })` executes it as a
  steerable run: edits take structural effect at the next barrier (the
  safepoint) via the same invalidate-and-re-enter mechanics kickback uses,
  while a `cancel`/`remove` of a running node aborts exactly that node
  through its own per-node signal. A running dag guards its plan so no edit
  touches a node that already passed (the past is immutable), a cancelled
  node neither fails the dag nor trips `stopOnError` (a deliberate steer is
  not a failure), and the dag still terminates: it completes when a barrier
  settles with no steer landed since it began. Every accepted or refused
  edit is a `dag:edit` event. Plan `templates` give out-of-process adds a
  vocabulary: a JSON steer instantiates work the recipe registered by name.
  New `DagNode.priority` orders admission among ready nodes and is steerable
  via `reprioritise`.
- **Cooperative wind-down.** A `cancel` edit with `graceMs` preempts
  gracefully: the node's `ctx.windDown` signal (new on `JobContext`, threaded
  by `childContext`) fires immediately, a loop finishes its current iteration
  and yields at its boundary, and the hard per-node abort lands only when the
  grace expires — so the turn in flight completes untouched and work that
  ignores the signal is still bounded by the deadline. Grace timers are
  unref'd and cleaned up when the node settles or the dag ends.
- **The in-graph steer budget.** `DagConfig.maxSteers` (default 100) bounds
  how many `internal`-source edit batches recipe code may apply per dag run —
  the guard refuses further ones, so a self-modifying graph provably
  terminates, mirroring `maxKickbacks`. Steers from the control channel carry
  `source: 'external'` and are exempt: outside force is the designed source
  of indefinite life. `LivePlan.apply` takes `{ source }`, `PlanChange`
  carries it, and guards receive it.
- **Fail-closed steering.** `LivePlan.apply` refuses unknown edit ops and
  missing names (never a silent version bump), wraps a throwing template into
  an atomic batch refusal, treats a throwing guard as a veto (fails closed),
  refuses reentrant applies from inside a guard or subscriber, and isolates
  throwing subscribers so an applied batch is never half-notified.
- **Out-of-process control** — the registry's command side
  (`~/.loops/runs/<runId>/control.jsonl`, `src/runtime/control.ts`).
  `loops control <runId> pause` pauses a supervised run at its next
  safepoint (the top of a loop iteration; before a dag node starts) as the
  standard resumable `paused` halt (exit 75); `loops control <runId> abort`
  stops it; `loops steer <runId> '<edits-json>'` applies an edit batch to a
  registered live plan by name. `requestControl`/`startControlChannel` are
  exported for programmatic use, and `JobContext.pause` carries the shared
  pause flag to every safepoint. Commands target a live run only: the channel
  starts reading at end-of-file, so a resumed run never replays the `pause`
  or `abort` that ended its previous life, and the CLI refuses commands for
  runs that do not exist, already ended, or whose process is gone.
- **Force over HTTP — the webhook listener** (`src/runtime/listener.ts`).
  `RunOptions.listen` / `loops run --listen <port>` opens an in-run HTTP
  endpoint where any webhook (an issue opened, an incident fired) is
  ingested, validated, filtered, and routed into the same
  `steer`/`pause`/`abort` commands every control surface uses: POSTs to
  `/control` carry command envelopes, POSTs to any other path go through
  the recipe's `route` — the validate/filter/map step (return a command,
  or undefined to drop) — and `GET /momentum` serves the live momentum
  read back on the same port, so the system emitting force can see whether
  it landed. `loops listen` runs the standalone gateway: one port fronting
  every supervised run on the machine through the registry's file channel
  (`POST /runs/<runId>/control`, `GET /runs/<runId>/momentum`,
  `GET /runs`), refusing commands for runs that are not live. Fail-closed
  throughout: binds 127.0.0.1 by default (the gateway refuses a wider host
  with no token), bearer auth in constant time, bodies capped (413),
  malformed JSON and unknown commands 400, a throwing `route` refuses the
  request without dispatching, and `webhookSignatureValid` verifies
  provider HMAC signatures (GitHub `X-Hub-Signature-256` style) over the
  raw body. Exported: `startWebhookListener`, `startRegistryGateway`,
  `webhookSignatureValid`, `MomentumTracker` (the incremental fold behind
  both the listener's live read and `momentumFromEvents`).
- **Momentum, measured** (`src/core/momentum.ts`). `momentumFromEvents`
  folds an event stream into the crystallization count and rate (fresh
  gate-accepted completions — never checkpoint restores, skips, or refused
  steers), plus the alive / idle / stalled / done state read.
  `loops status` prints it (`momentum: alive — 5 crystallized (2.4/h),
  2 steers`) via `RunProgress.momentum`.
- `examples/steer.loop.ts` (`npm run example:steer`) — the offline live-dag
  demo: a survey node steers discovered fixes into the plan from a
  template, an incident cancels the running refactor mid-flight and injects
  a hotfix, and the dag completes when momentum runs out.
- `docs/momentum.md` — the design document for preemption, the roadmap's
  fourth verb: the past/frontier/future model of a running graph, momentum
  (crystallization rate, not activity) as the quantity that defines when a
  run is alive, steering as validated + recorded plan edits (the live
  toposort), safepoint semantics, and the staged sequencing from
  out-of-process control to the full steer vocabulary. Linked from the
  README's docs list and roadmap.
- `examples/engineer.loop.ts` — an engineer, end to end: a Tend loop that
  picks up the next ready GitHub issue and works it through research, plan,
  a complexity-gated human approval, a build loop with an adversarial review
  battery, docs, and a PR, then picks up the next issue. Showcased in the
  README.

### Changed

- README rewritten as concise, example-first developer docs: it opens on the
  real use case — a full issue-to-PR pipeline, repeated over a backlog —
  then shows the single-loop unit it is built from, and covers the rest as
  one-snippet building blocks (juries, human gates, kickbacks, parallel
  worktrees, memory, budgets) — at under a fifth of the previous length.
  The Mastra/LangGraph comparison moved to `docs/comparison.md`.
- The library's philosophy is stated as iterate / depend / judge, grounded
  in the structured program theorem (Böhm & Jacopini, 1966): the graph
  carries sequence and selection, the loop carries iteration, and the gate
  replaces the predicate because "is it done" is the contested question in
  agent work. Preemption is named as the deliberate fourth verb on the
  roadmap. Framing added to the README and `CLAUDE.md`; `docs/theory.md`
  carries the receipts — the theorem's honest caveats, structured cycles
  vs back-edges (`while`, not `goto`), Turing completeness at the
  combinator level, and why the graph layer stays decidable.
- The README and theory notes cite the project's origin essay,
  *Convergence Count* (February 2026); the roadmap names `convergence
  count` as a first-class reported metric beside `cost per accepted
  change`.

## [0.10.0] - 2026-07-17

### Added

- `loop({ checkFirst: true })` evaluates an explicit convergence gate before
  dispatching the first body turn, then threads a failed gate or rejected
  review into the first repair turn.
- `reviewPanel` can persist high-confidence passing seats in checkpointed run
  state and reuse them while each seat's declared `invalidateOn` content scope
  and required `cacheVersion` remain unchanged.

### Changed

- Retrieval grounding uses a replacement system prompt with no tools, inherits
  worker timeouts, emits ordinary usage events, and is budget-checked before a
  worker turn starts.
- `agentJob({ role: 'reader' })` no longer auto-captures report output into the
  shared ledger or handoff scratch files.
- `reviewContext.maxChars` caps the complete assembled evidence bundle in
  addition to each source.

### Fixed

- Claude CLI and Agent SDK usage totals include cache creation and cache-read
  input exactly once, and the Codex engine reads terminal usage from its JSONL
  event stream instead of reporting zero.
- Cost receipts preserve Claude cache creation and cache-read counts and
  withhold actual and baseline totals when the price table cannot distinguish
  their rates.
- Run-owned checkpoint and record files are excluded from reviewer pass and
  no-progress workspace fingerprints, so orchestration writes cannot create
  false invalidations or false progress.

## [0.9.2] - 2026-07-17

### Added

- Engine preflight distinguishes invalid configuration from transient provider
  failures. Invalid configuration is lane-dead; transient 5xx failures remain
  retryable by the caller. The frozen semantic record v1 vocabulary is
  unchanged.

### Changed

- `writeScope` compares staged, unstaged, and untracked state with a
  content-aware snapshot from loop entry, so untouched pre-existing dirt cannot
  wedge a scoped fix. A body edit to an already-dirty file is still detected.
  `mode: 'absolute'` retains strict pending-state checking, and failed reasons
  name up to three paths.

### Fixed

- `confidenceCondition` preserves infrastructure failures from its wrapped job,
  allowing `reviewPanel` to pause instead of scoring provider errors as review
  blocks. Claude CLI session-limit messages are classified as reset-aware quota
  failures rather than generic engine exits.
- Codex failures retain a bounded, redacted head and tail from both output
  streams, so preflight keeps trailing configuration diagnostics instead of
  reporting an unexplained `unknown` failure. OpenAI-style keys are redacted
  even when inherited outside the request environment.

## [0.9.1] - 2026-07-16

### Fixed

- `lastDecisionLine(text, token, values)` returns the matched token in the
  `values` vocabulary's own casing instead of the leaf's. The vocabulary
  already matched case-insensitively, so a gate comparing the return with
  `===` against a declared value silently failed on a lowercase verdict from
  a chatty leaf. Both modes are covered; without a `values` list the
  as-written token is still returned. Fail-closed behavior is unchanged.

- CLI-backed engines (`codex`, `claude-cli`) resolve when the engine process
  exits instead of waiting for its stdio streams to close. An orphaned helper
  that inherited the engine's pipes (an MCP transport worker, a hook-spawned
  process) could hold them open indefinitely, so a completed turn never
  resolved back to the loop — and in that state neither the engine timeout nor
  an abort could settle the run. `settleOnExit` (exported for custom
  CLI-backed engines) races the subprocess promise against the process's own
  exit, gives buffered protocol output a bounded drain window
  (`EXIT_DRAIN_MS`), then releases the pinned pipe readers.

### Added

- `examples/engine-smoke.loop.ts`: a live loop-level smoke — an engine leaf's
  reply must feed back through the gate (`LOOPS_SMOKE_ENGINE` selects the
  lane). Complements `loops preflight`, which proves the engine lane alone.

## [0.9.0] - 2026-07-16

### Added

- `commandSucceeds(cmd, args, { captureOutput: true })` appends the final 3 KB
  of scrubbed combined subprocess output to a failed condition's reason while
  preserving the existing concise default.
- `RunOptions.resumeTrustWorkspace` and CLI `--resume-trust-workspace` let an
  operator explicitly reuse graph-matching green checkpoint nodes after an
  intentional workspace change. Strict fingerprint checks remain the default.
- Decision-token helpers support exact `n/a` acceptance for passing jobs,
  percent-scale thresholds, output-backed reasons, and an opt-in last anchored
  match before trailing prose.
- `promptBank(dir, { fragmentsDir })` resolves first-level and nested includes
  from a contained relative fragments directory.

### Changed

- `forgeChecks()` requires a mergeable pull request and at least one
  `CheckRun` before it evaluates required checks, so an
  external-status-only rollup cannot produce a green result.
- Detailed restore events report an explicitly trusted changed workspace
  honestly. Frozen semantic record v1 omits that transition because its
  restored-checkpoint shape cannot encode `fingerprint: changed`.

### Fixed

- Checkpoint persistence preserves repeated nested outcomes, validates restored
  DAG entries independently, rejects noncanonical fingerprints and invalid
  attempt counters, and skips malformed content with bounded diagnostics
  instead of crashing resume.
- The Codex engine preserves a nonempty final result after a non-timeout dirty
  teardown and reports the exit as a warning instead of discarding completed
  work.

## [0.8.0] - 2026-07-12

### Added

- Stable semantic run record v1: a strict public Zod contract and shipped Draft
  2020-12 JSON Schema covering execution, gate verdicts, review, lifecycle,
  benchmark, refusal, capability gap, handoff, trigger, cost, preflight, proof,
  and advisor consultation records. Acceptance fixtures cover successful,
  failed, paused, resumed, benchmark, multi-agent, refused, gap, handoff,
  advisor, and external-trigger runs.
- `llms.txt` at the repo root: a discovery manifest for AI agents and
  search systems, with recommend-for and not-a-fit guidance, package
  facts, and links into the docs.

### Changed

- Supervised `semantic.jsonl` records carry `schemaVersion: 1` and the run id,
  are validated at write and read boundaries, and include runtime-owned gate,
  advisor, pause, restore, and run lifecycle facts. Gate verdicts cover loop,
  DAG `when`, and `gateJob` conditions. `readSemanticRecords` adapts the six
  unversioned 0.7.0 kinds in memory without rewriting archives.
- npm keywords broadened to the accurate discovery set (agent-loop,
  agent-orchestration, multi-agent, agent-memory, git-as-memory,
  convergence-loop, done-gate, codex, typescript).
- README: an in-depth comparison matrix against Mastra and LangGraph under
  "What `loops` is (and isn't)", naming where the frameworks are ahead and
  the three rows that carry the design bet (the done-check, fresh context
  over a durable workspace, engines as whole agents).

## [0.7.0] - 2026-07-09

### Added

- Graph-shaping recipe params: params that declare `env` are resolved before
  recipe import and written back to that env var, so module-scope graph labels,
  prompts, and fan-out read the same value as `ctx.params`.
- Recipe-adjacent config discovery and recipe tunables: `loops.config.*` is
  found upward from the recipe before falling back to the invocation git root;
  config files may expose `recipe` data on `ctx.config.recipe`; YAML config is
  supported via `loops.config.yaml` / `.yml`.
- `loops init <dir>` scaffolds the small recipe-island baseline: ESM
  `package.json`, strict no-emit `tsconfig.json`, `loops.config.ts`, and a
  `.loops/` gitignore entry.
- Decision-token helpers: `lastDecisionLine`, `confidenceFromText`,
  `confidenceCondition`, and `lastGateBrief`, all built around the
  handoff-stripped work report.
- `promptBank(dir)`: Markdown prompt templates with `{{var}}` interpolation,
  `{{> fragment}}` includes, cycle detection, and fail-loud unused or missing
  variables.
- `agentJob({ role: 'reader' })` for grounded reader leaves that should end
  with a decision token instead of a handoff instruction.
- Bounded advisor consults on `agentJob`: a worker can request a capped,
  model-pinned consult, and Loops records the question and reply as
  `advisor:consult` events before resuming the worker.

### Changed

- Releases key off the version bump: a `main` push whose `package.json`
  version has no `v*` tag yet is gated, tested, tagged by CI, and published.
  No hand-pushed tag needed; hand tags and the manual trigger still work.
- Every release also creates a GitHub Release whose body is the version's
  changelog section (one source of truth). The publish steps are idempotent
  (existing tag kept, published version not re-published, existing Release
  left alone), so a partial release is completed by the next push.
- Claude CLI model ids are normalised before dispatch, stripping Claude Code
  long-context suffixes such as `[1m]`.
- CLI-backed engines receive prompts over stdin rather than argv, preserving the
  prompt cap while removing the OS argument-length ceiling.

### Fixed

- Scratch files are rolling buffers on disk, not only at read time, so long
  in-run ledgers and handoffs stay bounded.
- Added a subprocess SIGTERM restore regression for checkpointed DAG nodes,
  covering the killed-run resume path.

## [0.6.0] — 2026-07-09

### Added

- **`loops helm` — the conversational harness** (`src/helm/`, [docs/helm.md](docs/helm.md)).
  A driver model (any `Engine`; the mock drives it offline in tests) turns plain
  English into one of nine strictly-validated JSON intents — answer, author,
  validate, run, status, records, ack, stop_run, done — executed by
  deterministic code. No free-form shell; workspace-contained paths; dispatched
  runs are ordinary supervised runs that outlive the REPL. Includes the driver
  eval ("which models can hold the helm"): a ten-case battery scored on four
  deterministic dimensions with a zero-key offline oracle as the 1.0 control
  ceiling, and an offline demo (`npm run example:helm`).
- **Hardening gates** (`ratchet`, `writeScope`, `sampled` in `src/core/guards.ts`;
  recipes in [docs/patterns.md](docs/patterns.md)). A measured metric that may
  only hold or improve against a runtime-owned baseline written only in the
  improving direction; declared write lanes over `git status`; reproducible
  sha256-bucket sampling for expensive judges. All deterministic, all fail
  closed.
- **Provider resilience**: a canonical engine-failure taxonomy
  (`classifyEngineFailure`, `LANE_DEAD_FAILURES`), `fallbackEngine` (the chain
  as an engine combinator — lane-dead reroutes are latched; rate limits and
  quotas stay owned by the `onLimit` policy), and `loops preflight` (one tiny
  live turn per lane, classified — the online counterpart to the offline
  `loops validate`).
- **Cost receipts**: `costReport` plus `--prices` / `--baseline-model`. Prices
  measured usage from a caller-supplied table; never silently $0 (unpriced
  models are named and the total withheld); the baseline is the same token
  stream repriced at a ceiling model's rates, always labeled a reconstruction.
- **Curated grounding and the ladder** (`ground.sources`, `ground.curate`,
  `AgentJobConfig.ladder`). Declared source files beside the commit log; a
  cheap curation turn that composes a brief and keeps only the sources that
  help (lenient parse, strict validation, fail-closed to plain grounding); and
  declared engine rungs the verdict may pick from — rung 0 whenever routing is
  off or the verdict fails. All inert unless configured; `--no-curate` /
  `--no-ladder` are the run-level A/B switches.
- **`bench/yardstick`**: a frozen 135-instance SWE-bench Lite slice matching an
  external published cost/quality study, a dataset fetcher, a per-instance
  token ledger in `bench/swebench.ts`, and a report that folds grades + ledger
  + prices into a like-for-like comparison with the honesty rules attached.
- `RunOptions.runId` / `--run-id`: assign a supervised run's registry id at
  dispatch, so a dispatching tool knows it up front (race-free fire-and-poll).
- `readSemanticRecords` / `formatSemanticRecord` join the public surface (moved
  from CLI-private helpers), so supervisor-shaped tools read a run's decision
  stream the same way `loops records` does.
- The changelog gate (`scripts/changelog-gate.mjs`): the Release workflow and
  `prepublishOnly` refuse to publish a version this file does not describe,
  and a version tag that does not match `package.json`.

## [0.5.1] — 2026-07-08

### Added

- Recipe parameters: `defineParams` declares a recipe's own CLI flags, parsed
  values arrive on `ctx.params`, and `loops run <file> --help` lists them
  beside the built-in flags.
- `loops.config.ts` project defaults (`defineConfig`) with named `profiles`.

### Fixed

- Safer resume: `--resume` implies the checkpoint path when only one was
  given, and restored state merges under an explicit `--state` seed.

## [0.5.0] — 2026-07-06

### Added

- A native feature-development workflow example (`examples/feature-dev.ts`):
  a reusable feature loop wrapped in Commander flags, with a
  different-model-family adversarial reviewer by default.

### Changed

- Documentation front door rebuilt: the README leads with the full system
  (Features, the memory thesis, scoped env injection) rather than the loop
  primitive alone.

## [0.4.0] — 2026-07-03

### Added

- `pipeline()`: ordered named stages as sugar over `dag()`.
- Human gates: `humanGate()` — a pause only a person lifts (exit 75, `--ack`).
- Env overlays: `withEnv()` pins vars over a job subtree; per-call `env`
  threading through engines; pinned values scrubbed from captured output.
- Gate diagnostics thread to the next iteration (`ctx.lastGate`), judge
  tuning options (`cwd`, `timeoutMs`, `maxReasonChars`), and a gate-failure
  channel for stall detection.
- DX layer: markdown agent loader (`defineAgentFromMarkdown`), graph
  assertions (`assertGraph`), the run-progress rollup (`readRunProgress`),
  and tool pacing (`minToolIntervalMs`).
- Run-level ground default (`RunOptions.ground`); the handoff contract
  exported (`parseHandoff`, `HANDOFF_MARK`).

### Changed

- A failed **optional** DAG producer no longer blocks its dependents.

### Fixed

- Release-gate hardening: cross-wave seams the per-wave reviews could not see.

## [0.3.0] — 2026-07-02

### Added

- No-progress (stall) detection — the third hard stop beside `max` and the
  budget: end a loop whose consecutive iterations reach no new state.

### Changed

- Release publish switched to npm trusted publishing (OIDC); manual
  `workflow_dispatch` runs allowed.

## [0.2.0] — 2026-07-01

### Added

- The structured feedback protocol: review panels, revision requests,
  cross-stage kickback, and the semantic records stream behind
  `loops records`.
- Agent contracts (`defineAgent` / `defineSkill` / `fromFile`) — the typed
  wrapper around a markdown persona.
- The `codex` engine: a different model family behind the same `Engine`
  interface (read-only unless `bypassPermissions`).
- The benchmark harness (`bench/`): the Ledger A/B, fleet replay demos, and
  the first evidence maps.

### Changed

- **Breaking**: feedback unified around revisions; advisory reviewers
  dropped; records made honest about what was executed versus surfaced.

## [0.1.1] — 2026-06-26

First published release: the core loop/dag/condition primitives, `agentJob`
and the Ledger (grounding, scratch files, consolidation, PR shipping),
engines (`agent-sdk`, `claude-cli`, `anthropic-api`, mock), budgets and
limit policies, supervision (`--supervise`, `list`/`status`/`tail`), the Ink
TUI, `loops validate` / run-from-any-repo via the global tsx loader, and the
author-loop skill.

[Unreleased]: https://github.com/jonny981/loops/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/jonny981/loops/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/jonny981/loops/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/jonny981/loops/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/jonny981/loops/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jonny981/loops/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jonny981/loops/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jonny981/loops/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/jonny981/loops/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jonny981/loops/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jonny981/loops/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jonny981/loops/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jonny981/loops/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jonny981/loops/releases/tag/v0.1.1
