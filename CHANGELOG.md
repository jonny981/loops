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

[Unreleased]: https://github.com/jonny981/loops/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/jonny981/loops/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jonny981/loops/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jonny981/loops/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jonny981/loops/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jonny981/loops/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jonny981/loops/releases/tag/v0.1.1
