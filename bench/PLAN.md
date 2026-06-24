# Ledger A/B Benchmark — does the git-memory actually help?

Self-contained spec so this survives context compaction. Build target: a harness
that measures whether loops' **Ledger** (grounding + per-iteration commits)
improves convergence on real coding tasks, by running each task twice — **Ledger
ON vs OFF** — same model, same tasks, same gate.

## Why this exists

Landscape review (GCC arXiv 2508.00031, Letta Context Repositories, DiffMem)
showed the git-memory thesis is real and validated by convergence, but loops has
**zero measured evidence**. GCC's headline is a controlled A/B: Claude 4 Sonnet
**+ GCC = 80.2% vs 74.0%** on SWE-bench Verified — the **+6.2pp lift from the
git-context layer** is the claim worth reproducing for loops. We are not chasing
absolute resolve rate (that is the model's); we are isolating **the Ledger's
contribution**.

Hypothesis: OFF re-walks dead ends (no memory of prior attempts); ON reads "I
tried X, it failed because Y" from the draft + committed attempts and avoids it,
so it converges in fewer iterations / at a higher rate.

## The A/B, in loops terms

For each task, two `run()`s, identical except the Ledger:

**Ledger OFF** — a plain fresh-context loop, no memory between iterations:
```ts
loop({
  name: `solve-${task.id}`,
  max: MAX_ITERS,
  body: agentJob({
    engine: 'claude-cli', cwd: taskRepoDir,
    prompt: (c) => `Iteration ${c.iteration}. Problem:\n${task.problem_statement}\n\n`
      + `Make the failing test(s) pass by editing the repo.`,
    outcome: (text) => ({ status: 'fail', summary: text.slice(0, 200) }), // gate decides "done", not the body
  }),
  until: commandSucceeds('bash', ['-c', task.test_cmd], { cwd: taskRepoDir }),
});
```

**Ledger ON** — grounding + a per-iteration committed attempt (the WIP tier, composed
manually so no new loops feature is needed):
```ts
loop({
  name: `solve-${task.id}`,
  max: MAX_ITERS,
  body: sequence(`iter`,
    agentJob({
      engine: 'claude-cli', cwd: taskRepoDir,
      ground: true,              // ← reads prior attempts' draft + committed log
      prompt: (c) => `Iteration ${c.iteration}. Problem:\n${task.problem_statement}\n\n`
        + `Make the failing test(s) pass. Record why each attempt failed.`,
      outcome: (text) => ({ status: 'pass', summary: text.slice(0, 200) }),
    }),
    commitJob({ subject: `attempt ${'${c.iteration}'}: ${task.id}` }), // ← per-iteration memory
  ),
  until: commandSucceeds('bash', ['-c', task.test_cmd], { cwd: taskRepoDir }),
});
```
Try `ground: { retrieve: true }` as a third arm once the basic A/B shows signal.

Key point: each task runs in its OWN copy of the repo at the base commit (so the
two arms do not contaminate each other, and `git add -A` from commitJob is safe).
Reset/clone per arm per task.

## Metrics (per task + aggregate)

- **resolved** (pass@1): the FAIL_TO_PASS test(s) pass AND PASS_TO_PASS still pass.
- **iterations-to-converge**: loop iterations until `until` met (cap = unresolved).
- **tokens**: via `RunOptions.budget` accounting (compare cost, not just outcome).
- Aggregate: resolve-rate ON vs OFF, mean iterations ON vs OFF, token delta.
- The result that matters: **ON − OFF**. A positive resolve-rate / lower iterations
  for ON is the grounded claim. If flat or negative, we learned it cheaply.

## Phasing (do Phase 1 first — cheap signal)

- **Phase 1 — local custom suite, no Docker.** ~8–15 self-contained tasks: a small
  repo at a base state with a failing test and a known fix. Run locally with
  `claude-cli`. Goal: a first signal in an afternoon, no SWE-bench infra.
  Tasks live in `bench/tasks/<id>/` = `{ repo seed, problem.md, test_cmd }`.
- **Phase 2 — SWE-bench Lite (300) via the official harness.** Tasks are
  `princeton-nlp/SWE-bench_Lite` (repo, base_commit, problem_statement,
  FAIL_TO_PASS, PASS_TO_PASS, test patch). Evaluation is **Docker-based** (per-task
  images) — that is the heavy part. Use the official `swebench` runner for the
  test execution; loops drives the editing loop; we record ON vs OFF. Start with a
  20–30 task subset.

## Build layout (in this repo, `bench/`, NOT in the package exports)

- `bench/ab.ts` — the runner: load tasks → for each, prepare two repo copies →
  run OFF then ON via loops `run()` → collect metrics → write `bench/results.json`.
- `bench/tasks/` — Phase 1 custom tasks.
- `bench/swebench.ts` — Phase 2 loader + Docker eval wiring (later).
- `bench/report.ts` — print the ON-vs-OFF table from `results.json`.

## Decisions / constraints

- Engine: **claude-cli** (real file-editing agent; loads the project's tools).
  Needs host Claude auth. The mock engine cannot edit files, so the benchmark is
  NOT offline (unlike the unit tests).
- Same model + same MAX_ITERS for both arms; vary ONLY the Ledger.
- Per-iteration commit for ON is composed in the loop body (sequence(agent,
  commitJob)); we did NOT build a loop-level WIP tier — this is the WIP tier, by
  hand, which is fine for the bench.
- Fresh repo copy per (task, arm) so arms are independent and git-add-all is safe.
- Run from each task repo as the workspace (cwd), so ground/commit target it.

## State of loops at spec time (pushed, main @ a60485a)

Ledger core + 3 axes + the 6 landscape borrows, 158 tests, all offline:
- write: `commitJob` (draft → milestone body); draft = `.loops/progress.md`
  (gitignored, append-only, shared across fan-out).
- read: `agentJob({ ground })` = recent-N ledger + draft; `ground: { retrieve }` =
  a cheap model selects relevant commits (fixes the noise problem).
- worktrees: `dag` `isolation: 'worktree'` + land-back; `tournament` (branch-and-
  select); `DagConfig.onConflict: 'synthesize'` (mergeSynthesis).
- env: `RunOptions.environment` + `DagConfig.environment`; adapters `loops/env/
  {command,sst,docker}` (research pipelines need none).
- consolidate: `consolidateJob` → rolling `LEDGER.md` roadmap.
- limits: rate/quota/budget auto wait-or-resume (`paused`/EXIT_PAUSED).
- API surface: `src/api.ts`. Repo: /Users/jonny/dev/personal/loops, branch main,
  push freely (user-authorised, no PRs/branches for loops).
