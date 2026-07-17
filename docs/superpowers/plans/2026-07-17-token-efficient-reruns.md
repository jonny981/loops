# Token-Efficient Reruns Implementation Plan

> **For agentic execution:** Work test-first, keep every change reversible, and do not commit before 18:00 Europe/London on 2026-07-17.

**Goal:** Remove the avoidable model calls and repeated review work observed in the Growatt and Go-e OEM pipeline runs without weakening deterministic gates or the final review battery.

**Architecture:** Loops will make its hidden retrieval turn bounded, visible, and budgeted; add opt-in pass reuse to `reviewPanel` with content fingerprints over each reviewer's declared evidence scope; and let repair loops check their gates before dispatching a writer. Reader reports remain available as outcomes and review feedback but stop entering shared scratch memory. The OEM recipe opts into these primitives, disables history retrieval for independent reviewers, and emits compact findings-first audit reports.

**Tech stack:** TypeScript, Vitest, git plumbing, `@loops-adk/core`, pnpm.

---

## Task 1: Bound and account for hidden grounding work

**Files:**
- Modify: `src/engines/engine.ts`
- Modify: `src/engines/claude-cli.ts`
- Modify: `src/engines/agent-sdk.ts`
- Modify: `src/engines/message-map.ts`
- Modify: `src/engines/codex.ts`
- Modify: `src/core/ground.ts`
- Modify: `src/core/job.ts`
- Test: `tests/ground-retrieve.spec.ts`
- Test: `tests/claude-cli-args.spec.ts`
- Test: `tests/message-map.spec.ts`
- Test: `tests/codex-args.spec.ts`

- [x] Write failing tests proving retrieval exposes usage, disables tools, inherits timeouts, and exhausts the budget before the worker runs.
- [x] Write failing adapter tests proving Claude cache tokens and Codex JSON usage are counted exactly once.
- [x] Add the minimum request-level `tools` availability control and route selector events through the ordinary usage stream.
- [x] Recheck the budget after grounding and immediately before each worker dispatch.
- [x] Normalize provider usage into the existing `Usage` totals without changing the frozen semantic schema.
- [x] Verify: `npx vitest run tests/ground-retrieve.spec.ts tests/claude-cli-args.spec.ts tests/message-map.spec.ts tests/codex-args.spec.ts`.

## Task 2: Reuse only still-valid reviewer passes

**Files:**
- Modify: `src/core/git.ts`
- Modify: `src/core/feedback.ts`
- Modify: `src/api.ts` only if a new public type export is required
- Test: `tests/no-progress.spec.ts`
- Test: `tests/feedback.spec.ts`

- [x] Write failing fingerprint tests proving out-of-scope edits and commits do not invalidate a scoped hash, while in-scope tracked and untracked changes do.
- [x] Write failing panel tests proving a high-confidence pass is reused across a pause/resume, an invalidated scope reruns, and malformed or low-confidence entries fail closed.
- [x] Add `reviewPanel` opt-in pass persistence with an explicit minimum confidence and per-reviewer `invalidateOn` paths.
- [x] Require a stable panel label and unique reviewer names when persistence is enabled.
- [x] Store only compact passing verdicts in namespaced `ctx.state`; use existing checkpoint persistence unchanged.
- [x] Compute before/after fingerprints and never cache a reviewer whose evidence changed during review.
- [x] Verify: `npx vitest run tests/no-progress.spec.ts tests/feedback.spec.ts`.

## Task 3: Avoid speculative fixers and memory amplification

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/loop.ts`
- Modify: `src/core/describe.ts`
- Modify: `src/core/job.ts`
- Modify: `src/core/feedback.ts`
- Modify: `src/core/text.ts`
- Test: `tests/loop.spec.ts`
- Test: `tests/agent.spec.ts`
- Test: `tests/feedback.spec.ts`

- [x] Write failing loop tests for a green iteration-zero gate, a red precheck feeding `lastGate` to the first body, and a rejected precheck review feeding `lastReview` to the first body.
- [x] Implement `loop({ checkFirst: true })` by reusing the existing convergence/review path; reject it when `until` is absent.
- [x] Extend the reader test to prove its report does not enter ledger or handoff scratch.
- [x] Guard auto-capture for `role: 'reader'` while preserving events, outcomes, and feedback.
- [x] Add a literal total cap to assembled `reviewContext`, preserving its existing evidence priority.
- [x] Verify: `npx vitest run tests/loop.spec.ts tests/agent.spec.ts tests/feedback.spec.ts`.

## Task 4: Wire the OEM recipe to the new behavior

**Files in the Go-e worktree:**
- Modify: `tools/oem-integration-loop/oem-integrate.pipeline.ts`
- Modify: `tools/oem-integration-loop/lib/gates.ts`
- Modify: `tools/oem-integration-loop/lib/types.ts`
- Modify: `tools/oem-integration-loop/lib/env.ts`
- Modify: `tools/oem-integration-loop/config.yaml`
- Modify: `tools/oem-integration-loop/prompts/pattern-audit.md`
- Modify: `.claude/agents/oem-pattern-auditor.md`
- Modify: reviewer prompt/agent files only where needed for findings-first output
- Modify: `tools/oem-integration-loop/scripts/smoke.ts`
- Modify: `tools/oem-integration-loop/CLAUDE.md`

- [x] Add smoke assertions for check-first repair loops, persisted conformance reviewers, disabled reviewer grounding, and timeout grace forwarding.
- [x] Enable `checkFirst` on conformance and Ship Gate repair loops.
- [x] Enable scoped pass persistence for panel members while keeping each stage's first panel run fresh.
- [x] Disable grounding for independent readers and pass the existing timeout grace through the leaf factory.
- [x] Replace per-pattern pass prose with compact pass and n/a coverage lists; retain full file, consequence, and minimum-fix detail for violations.
- [x] Keep `tests-first` as one job because its unit, contract, integration, and conditional canonical surfaces share fixtures and ownership decisions.
- [x] Anchor connector Jest selectors below the package test root so an OEM slug in a worktree name cannot broaden the gate.
- [x] Verify against a local build of Loops, then run `pnpm typecheck` and `pnpm smoke` in `tools/oem-integration-loop`.

## Task 5: Documentation, changelog, and full verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `.Codex/progress.md`

- [x] Document the opt-in review cache invalidation contract and check-first semantics without claiming unsafe confidence-only reuse.
- [x] Add an `Unreleased` changelog entry for every public or behavioral change.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run build` and the changelog gate.
- [x] Review both worktree diffs independently for correctness, scope, and token-saving impact.
- [x] Leave changes uncommitted until the repository's 18:00 Europe/London commit window opens.
