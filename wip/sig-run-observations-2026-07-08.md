# Loops observations — Amps OEM pipeline (SigEnergy run)

The actionable "what to build next" digest from driving the Amps OEM integration pipeline through the SigEnergy run (running detail: `field-notes-amps-oem-pipeline.md`; the 0.5.0 batch: `sig-post-impl-improvements.md`). Resolved entries stay in place under the maintenance convention below. Pruning baseline: 2026-07-10 against 0.7.0.

## How this file is maintained

Findings accrue in dated **batches**, newest batch first among the open items. Every entry header leads with a **status** tag:

- `[OPEN]` / `[BUG]` / `[DESIGN GAP]` — pending; a library change is still wanted.
- `[VERIFY]` — needs a live check before it becomes a firm ask.
- `[CONTEXT]` — background, no action on its own.
- `[VERIFIED]` / `[DONE]` — completed; **kept in place as reference, never deleted.**

When a new batch is added on top, the prior batches stay exactly where they are. A finding that gets addressed flips its tag to `[VERIFIED]`/`[DONE]` (and, if it shipped in a release, is also recorded in the Shipped register) — it is **not** removed, because the old findings and their reasoning are useful reference. So the file only grows; status tags and batch headers are what tell you what's new versus already handled.

## Shipped register (do not re-request)

- **0.5.0** — `reviewPanel({concurrency})` + `actionableScopes`/per-reviewer `scope`: PROVEN in production on the SigEnergy run.
- **0.5.1** — `defineParams` + `ctx.params`; `loops.config.ts` + profiles; thin auto-records; `--resume` re-checkpoint + restore diagnostics; `ground.promptChars` cap; scratch reset; symlink hardening.
- **0.6.0** — runtime `LOOPS_LEAF`/`LOOPS_LEAF_ID`/`LOOPS_LEAF_LABEL` markers; hardening gates (`ratchet`, `writeScope`, `sampled`); provider resilience (`fallbackEngine`, `classifyEngineFailure`, `loops preflight`); cost receipts; curated grounding (`ground.sources`/`curate`) + `ladder`; `--run-id`; helm.
- **0.7.0** — graph-shaping env-backed params (pre-import resolution + write-back); recipe-adjacent config discovery + `loops.config.yaml` + `ctx.config.recipe`; `loops init`; decision-token helpers (`lastDecisionLine`, `confidenceFromText`, `confidenceCondition`, `lastGateBrief`); `promptBank(dir)`; `agentJob({ role: 'reader' })`; **bounded advisor consults** (`advisor:` on agentJob, recorded as `advisor:consult` events); engine-side Claude CLI model-id normalisation (incl. `[1m]`); stdin prompt delivery; rolling scratch buffers; SIGTERM-restore regression.
- **0.8.0** — stable semantic run record v1 (strict Zod contract + Draft-2020-12 JSON Schema; supervised `semantic.jsonl` carries `schemaVersion: 1` + run id, validated write/read; `readSemanticRecords` adapts the six 0.7.0 kinds in memory); `llms.txt` discovery manifest; broadened npm keywords + README comparison matrix. **Ships NONE of the open SigEnergy asks (§1b–1h, §2–4)** — the island's local workarounds all stay. Island adopts it as a clean version bump (`^0.7.0` → `^0.8.0`): the island consumes no semantic-record API, so no code change; verified TSC CLEAN + smokes + 23 nodes both polarities + both engines preflight.
- **0.9.0**: defensive checkpoint restore; explicit changed-workspace resume trust; Codex final-result preservation after dirty teardown; mergeability + `CheckRun` forge guards; opt-in command output tails; additive decision-token modes; prompt fragment directories; Codex grounding verified through the real adapter.
- **Amps island adoption (at 0.7.0):** `from-def.ts` DELETED (both its jobs — the `[1m]` strip and the `LOOPS_LEAF` marker — are library-owned); `role: 'reader'` adopted for all reader/judge leaves; `--oem`/`--device-type` declared as env-backed params (the §1 trap is closed); `writeScope` lanes on every fix-up loop's `until`; codex-lead executor leaves carry a call-capped Claude advisor; the launcher preflights both engine lanes (`loops preflight -e claude-cli -e codex`) and assigns `--run-id` at dispatch.

---

## ▸ Batch — SigEnergy live-half run (2026-07-10 → 2026-07-11)

Findings from driving the pipeline through the SigEnergy live half (deploy → promote → canonical → go-live/chaos → PR/CI). Each original finding remains in place with its status.

## 1. [VERIFIED 2026-07-10] Killed-run checkpoint restore

0.7.0 ships a SIGTERM-restore regression test for checkpointed DAG nodes, so the library-side question is answered. Production validation landed on the SigEnergy resume (run-id `sigenergy-battery-20260710`): resuming against a checkpoint whose node names no longer match the graph printed a loud, specific skip reason at boot — `restore: restoring nothing from /tmp/sigenergy-battery-v2.ckpt: no checkpointed DAG nodes match the current graph` — then walked fresh from `preconditions`. Exactly the wanted behaviour: no silent fresh-start, no crash, the mismatch named. Closed.

## 1b. [DONE 2026-07-15] The fix-commit-resume loop can never restore a checkpoint

The workspace-fingerprint guard and the sanctioned recovery flow are mutually exclusive. The recovery loop for a mid-run failure is: stop the run, fix the defect, COMMIT the fix (a dirty out-of-lane file would trip every fix-up loop's `writeScope` gate), resume with `--resume`. But the fix commit moves HEAD, the fingerprint no longer matches, and restore refuses wholesale: `restore: restoring nothing from <ckpt>: workspace fingerprint changed` (observed live on the SigEnergy resume: a one-file island fix commit between stop and relaunch cost a full re-walk of the completed nodes; only `SKIP_STAGES` carried the continuation). The diagnostic itself is excellent — loud and specific, both refusal reasons now observed live (name mismatch and fingerprint mismatch).

Candidate fixes, in rough preference order: (a) fingerprint per-node — a green node restores unless files its stage could have touched changed since checkpoint (lanes give the natural scope); (b) fingerprint on the checkpoint's committed TREE rather than HEAD, so commits that only ADD history atop the checkpointed state don't invalidate (a fix commit is exactly that); (c) a `--resume-trust-workspace` escape hatch that restores green nodes despite the fingerprint, for the operator who knows the delta is benign. Without one of these, checkpoints only survive crash/SIGTERM recovery with zero intervening fixes — the rarest recovery case; the common case (something broke, so by definition a fix lands before resume) is the one the guard forbids.

**0.9.0 resolution:** candidate (c) shipped as `RunOptions.resumeTrustWorkspace` and `--resume-trust-workspace`. The default fingerprint refusal remains strict; explicit trust restores only graph-matching green nodes and records the changed fingerprint. A substantive fix changes the committed tree, while write lanes describe allowed outputs rather than node inputs or dependency provenance, so the tree- and lane-based candidates could not safely cover this recovery flow.

## 1c. [DONE 2026-07-15] A signal-abort checkpoint crashes the next resume

`loops run --resume <ckpt>` exits immediately with `cannot resume from "<ckpt>": Cannot read properties of undefined (reading 'status')` when the checkpoint was written during a SIGTERM abort. Repro artifact: `wip/repro-signal-abort-checkpoint-2026-07-10.ckpt` (15KB, from the SigEnergy run killed mid `serverless-tests`). The four top-level dag nodes in it are all well-formed (`phase: done` + `outcome`); the suspect is the SECOND dags entry — a nested path for a sequence stage (`["oem-integrate-sigenergy","lint-format","lint-format"]`) — whose shape the restore walk apparently indexes into expecting an outcome. Two asks: (a) fix the crash; (b) make restore defensive as a principle — a checkpoint must never be able to brick a resume; skip-and-report any entry it cannot parse (the loud per-reason skip diagnostics already set the precedent).

Related observation from the same kill: the leaf ran 40m21s against `timeoutMs` 20m with no timeout firing. The docs mention a post-`timeoutMs` grace window for completing final results — if the grace is unbounded while the engine streams, a hung-but-chatty leaf never times out. Worth pinning the semantics.

**0.9.0 resolution:** repeated nested outcomes remain serializable, and restore validates DAG entries independently. Malformed records are skipped with bounded path-specific diagnostics, valid siblings remain reusable, and malformed checkpoint JSON starts fresh with a reported reason. Engine timing is an absolute `timeoutMs + timeoutGraceMs` boundary per invocation; streaming does not reset it. Worker, fallback, and advisor invocations each receive their own window.

## 1d. [DONE 2026-07-15] commandSucceeds discards subprocess output

`commandSucceeds(cmd, args, opts)` resolves `{ met, reason }` where `reason` on failure is only `` `cmd` exited N `` — the subprocess stdout/stderr is dropped. For the fast internal gates (tsc, jest) that is fine; for long, opaque, externally-dependent shell gates (a deploy, a manifest promote) it means a failure carries NO evidence, forcing an out-of-band manual repro every time. Both live-half gate failures on the SigEnergy run (promote SIGTERM at timeout; deploy exit 255) were blind this way, and both repros then passed — so the failures were transient, but nothing in the run said so. Ask: an opt-in `captureOutput?: boolean` (or always fold the last ~3KB of combined output into `reason` on non-zero exit). The island shipped a local `commandWithTail` (`lib/repo-helpers.ts`) as the stopgap and wired deploy+promote to it; folding the capability into the primitive would let every gate benefit and let the island delete the helper.

**0.9.0 resolution:** `captureOutput: true` appends the scrubbed final 3 KB of combined output to a failed reason. The concise default, the separate evidence channel, and successful-command behavior remain unchanged.

## 1e. [context 2026-07-10] commandWithTail immediately paid off + a resume-cost tension

The island `commandWithTail` stopgap (§1d) worked first time on the next deploy failure: the captured tail showed the builds all succeeded and the process died in docker digest resolution (a transient registry blip), turning a blind exit-255 into a 10-second diagnosis. Reinforces the ask to fold output capture into `commandSucceeds`.

Separate, sharper tension for the fix-commit-resume recovery loop (§1b): when a downstream stage rebuilds artifacts keyed on the git SHA (here, personal-stack docker images tagged with `git rev-parse --short HEAD`), every recovery COMMIT invalidates that cache and forces a full rebuild on resume — so committing a fix to get a clean tree (writeScope demands it) also makes the re-deploy long and more exposed to transient infra flakes. The two guards (writeScope wants a commit; the tag cache wants no commit) pull opposite ways. Argues for a loops answer to "resume across a fix without a HEAD-moving commit" — e.g. a scratch/uncommitted-allowed lane for tooling fixes, or resume keying on tree-content not HEAD (ties to the §1b fingerprint options).

## 1f. [context 2026-07-10] output capture turned a 2x-misdiagnosed hang into a 10s fix

The promote stage hung twice (10 min, then 30 min) and I misdiagnosed it the first time as a slow Postgres connect — because `commandSucceeds` discarded the subprocess output. The moment `commandWithTail` (§1d) was in place, the captured tail showed the truth instantly: an infinite ioredis reconnect loop against a decommissioned (NXDOMAIN) Redis host that jonny's env still declared. This is the strongest possible argument for folding output capture into the library primitive: a blind deterministic gate doesn't just cost forensics time, it produces WRONG root-cause conclusions that get written into commit bodies. A gate that fails should carry its output by default.

## 1g. [DONE 2026-07-15] A non-zero engine exit at TEARDOWN discards the agent's completed output

`go-live-chaos`'s `chaos-malicious-actor` runs on the codex engine (cross-model adversarial diversity). Twice it produced a COMPLETE, clean adversarial report (visible in the stream), then the codex process exited 1 at teardown with `rmcp::transport::worker: worker quit with fatal: Transport channel closed` against a fresh ephemeral MCP port each time (9121, then 3847). loops treats the non-zero exit as an ENGINE failure and discards the finished work, failing the panel. This is the same class as the run-1 death (SIGTERM after the final summary failed the node despite finished work): **a result that was fully produced should survive an engine's dirty exit at teardown.** Ask: when an agent has emitted a complete final result, treat a subsequent non-zero engine exit as a teardown warning, not a result-discarding failure — or add a short engine-level retry for the transport-closed class specifically (it is not a rate limit; `fallbackEngine`'s lane-dead set won't catch it). Compounding factor here: with the island's `PANEL_LIMIT=1` the chaos panel is a single codex member, so one teardown blip fails the whole stage — a single-member panel has no quorum cushion. Workaround taken: skip the stage (it had demonstrably run clean); the connector-vs-platform panel rescope should keep the per-connector adversarial member on a stable pool or give codex a retry.

**0.9.0 resolution:** a non-timeout Codex exit that leaves a nonempty final-output file returns that result and emits a scrubbed warning. A non-zero exit without final output remains an engine failure, and completed work is not retried.

## 1h. [DONE 2026-07-15] ci-watch passes a PR whose CI never ran (conflicting = no merge ref)

`ci-watch` (the pipeline's terminal gate) reported PASS / all-nodes-green on a PR whose CORE CI never ran. The PR conflicted with base, so GitHub could not build the `pull_request` merge ref and never triggered the CI workflow; only the external integrations (Vercel, which build the head commit directly) posted checks. `gh pr checks` / the forge-checks gate then saw those green and NO pending required check, and read "all required green" as success. So a stale/conflicting PR sails through the final gate. The connector was genuinely fine (canonical E2E passed pre-CI); the danger is a REAL CI failure hiding behind an un-run CI on a conflicting branch.

**Fixed island-side** (`ciCheckAndFix` + `ghPrState`): the gate now trusts a "green" only once the PR is MERGEABLE and ≥1 GitHub Actions check-run (`__typename === 'CheckRun'`, not just an external Vercel status) has posted, waiting a bounded window for a still-computing state; and a `CONFLICTING`/`DIRTY` PR is a first-class ci-fix — the fix leaf merges base, resolves conflicts (superset for island files), and pushes so CI can run. **Residual loops ask:** the library's own `forgeChecks()` condition almost certainly shares the blind spot (it keys off posted check-runs, not the expected-workflow list + mergeability). Fold the two guards into `forgeChecks` — (a) a PR that is not mergeable is never green; (b) assert an expected-workflow run exists for the head, don't infer green from the absence of a failing required check.

**0.9.0 resolution:** `forgeChecks()` requires exact `MERGEABLE` state and at least one `CheckRun` before it evaluates required checks. The `CheckRun` is a trust proxy that GitHub Actions ran, not proof of a named expected workflow. Conflict repair, base merge, and push orchestration remain downstream concerns.

## ▸ Batch — earlier (0.5.x–0.7.0 era, carried forward)

Carried-forward items that predate the live-half run, preserved with their status.

## 2. [VERIFIED 2026-07-15] Ground on the codex engine

The Amps island's `LEAD=codex` polarity grounds codex-engine executor leaves (retrieve + working-memory injection); whether the codex engine honours the `ground` config, or silently drops it, has never run live. Verify on the first codex-lead run — grounding is the continuity spine, so a pool that cannot ground cannot lead. If unsupported, that is an engine-parity gap worth closing in loops.

**0.9.0 verification:** an offline subprocess integration through `agentJob({ ground: true })` and the real Codex adapter proves the composed working memory and task prompt reach Codex stdin. No engine-parity change was required.

## 3. [DONE 2026-07-15] Decision-token helpers: contract divergences the island could not adopt

Core's 0.7.0 helpers are parallel implementations, not drop-ins for the island's (which stay in `lib/reply-helpers.ts` / `lib/gates.ts`):

- **`confidenceCondition`**: core is 0–1 scaled with a default 0.8 threshold, returns a one-line `reason` (findings ride on `output`), and treats a missing/`n/a` token as fail. The island's contract is percent-100 unanimity, a clean `n/a` self-skip PASSES (the api-conformance reviewer's skip path), and the FULL findings prose travels as `reason` because `reviewPanel` folds a failing condition's reason into the revision request the fix-up consumes. Candidates: an `allowNa` option, a `reason: 'output'` mode (or reviewPanel folding `output` into revision requests), and a documented percent mode.
- **`lastDecisionLine`**: core requires the token to BE the closing line; the island takes the last line-anchored match anywhere in the work report (chatty leaves close with the tag then occasionally add a line). Core's is stricter — converging on it is fine once the leaves' closing discipline is proven; noted so the difference is deliberate, not drift.

**0.9.0 resolution:** `confidenceCondition` adds opt-in exact `n/a` acceptance for passing jobs, percent-scale thresholds, and output-backed reasons. `lastDecisionLine` adds an opt-in last-anchored-match mode that still fails closed on the newest disallowed token. All prior defaults remain unchanged.

## 4. [DONE 2026-07-15] promptBank: include keys cannot cross subdirectories

`{{> name}}` include keys reject `/`, so a `fragments/` subdirectory convention cannot be expressed; the island keeps its own loader (`lib/prompts.ts`) for that reason alone. Candidate: allow `/` in include keys, or a `fragmentsDir` option on `promptBank(dir)`.

**0.9.0 resolution:** `promptBank(dir, { fragmentsDir })` keeps root templates at `dir` and resolves first-level and nested includes from a contained relative fragments directory. Cycle detection uses resolved file identity, so a root template and fragment may share a name.

## 5. [context] Not yet adopted island-side, deliberately

- **`ground.sources` + `curate`**: overlaps the island's READ FIRST prompt lists (full-doc reads by the agent's own tools vs curated 4k excerpts). A/B after the SigEnergy run via `--no-curate`.
- **Per-leaf `fallback` routes + `ladder`**: evaluate after the run produces failure-mode evidence; fallback pairs naturally with the LEAD polarity (executors spill cross-pool; reviewers deliberately never).
- **Recipe-tunables config (`ctx.config.recipe` / `loops.config.yaml`)**: the island's tunables shape the graph at module scope, so the ctx-time surface does not fit; its own `config.yaml` reader stays.
- **`ratchet`/`sampled`/cost receipts/helm**: no current island consumer.
