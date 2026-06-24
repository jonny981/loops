/**
 * Ledger A/B — the experiment that asks whether loops' git-memory actually helps.
 *
 * Each task runs twice through the SAME model and the SAME gate, varying only the
 * Ledger:
 *   - OFF: a plain fresh-context loop. Iteration N inherits nothing from 1..N-1.
 *   - ON:  every iteration grounds in the branch-local ledger + draft, then
 *          commits its attempt — so the next fresh context reads "I tried X, it
 *          failed because Y" instead of re-walking the dead end.
 * The number that matters is ON − OFF (resolve-rate, iterations, tokens). See
 * bench/PLAN.md for the why.
 *
 * The Ledger only pays off when ONE attempt is not enough (the multi-iteration
 * regime). On one-shot-solvable tasks ON==OFF by construction — grounding is pure
 * overhead — so this runs N TRIALS per (task, arm): few tasks × many trials gives
 * the statistical power to see a resolve-rate gap that a single run cannot.
 *
 * NOT offline: the arms drive the real `claude-cli` engine, which edits files, so
 * this needs host Claude auth. Each trial runs in its own throwaway git repo
 * seeded from the task, so trials and arms never contaminate each other.
 *
 *   npx tsx bench/ab.ts                              # all tasks, both arms
 *   BENCH_TASKS=tasks-hard BENCH_TRIALS=5 BENCH_MODEL=haiku \
 *     BENCH_MAX_ITERS=5 BENCH_OUT=results-hard.json npx tsx bench/ab.ts
 *
 * Then:  npx tsx bench/report.ts [results-file]
 */

import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import {
  run,
  loop,
  sequence,
  agentJob,
  commitJob,
  commandSucceeds,
  type Job,
  type RunResult,
} from '../src/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const resolveIn = (p: string) => (isAbsolute(p) ? p : join(HERE, p));

const TASKS_DIR = resolveIn(process.env.BENCH_TASKS || 'tasks');
const OUT = resolveIn(process.env.BENCH_OUT || 'results.json');

/** Same cap for both arms — only the Ledger varies. */
const MAX_ITERS = Number(process.env.BENCH_MAX_ITERS ?? 6);
/** Same model for both arms (undefined → the CLI default). Critical for the A/B. */
const MODEL = process.env.BENCH_MODEL || undefined;
/** Trials per (task, arm) — power on a small task set. */
const TRIALS = Number(process.env.BENCH_TRIALS ?? 1);
const ENGINE = 'claude-cli';

type Arm = 'off' | 'on';

interface Task {
  id: string;
  problem: string;
  testCmd: string;
  seedDir: string;
}

interface TrialResult {
  /** The authoritative check: the test command passes on the final tree. */
  resolved: boolean;
  /** The loop's own terminal status (pass / exhausted / fail / …). */
  status: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

interface ArmResult {
  arm: Arm;
  trials: TrialResult[];
}

interface TaskResult {
  id: string;
  arms: ArmResult[];
}

function loadTasks(filter: string[]): Task[] {
  const ids = readdirSync(TASKS_DIR).filter((d) =>
    statSync(join(TASKS_DIR, d)).isDirectory(),
  );
  const wanted = filter.length ? ids.filter((id) => filter.includes(id)) : ids;
  return wanted.map((id) => {
    const meta = JSON.parse(
      readFileSync(join(TASKS_DIR, id, 'task.json'), 'utf8'),
    ) as { problem: string; test_cmd: string };
    return {
      id,
      problem: meta.problem,
      testCmd: meta.test_cmd,
      seedDir: join(TASKS_DIR, id, 'seed'),
    };
  });
}

/** A fresh git repo seeded at the task's broken state — the per-trial workspace. */
async function prepareRepo(task: Task, arm: Arm): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-bench-${task.id}-${arm}-`));
  cpSync(task.seedDir, dir, { recursive: true });
  const git = (args: string[]) => execa('git', args, { cwd: dir });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'bench@loops.local']);
  await git(['config', 'user.name', 'loops bench']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'base: seed state (failing test)']);
  return dir;
}

/** Met when the task's test command exits 0 — the honest convergence signal. */
function gate(task: Task, repoDir: string) {
  return commandSucceeds('bash', ['-c', task.testCmd], { cwd: repoDir });
}

/** OFF arm: a plain fresh-context loop, no memory between iterations. */
function offJob(task: Task, repoDir: string): Job {
  return loop({
    name: `solve-${task.id}`,
    max: MAX_ITERS,
    body: agentJob({
      label: 'solve',
      prompt: (c) =>
        `Iteration ${c.iteration}.\n\n${task.problem}\n\n` +
        `Edit the files in this repo to make the test pass. ` +
        `Run \`${task.testCmd}\` to check your work.`,
      // The gate decides "done", not the body — so keep iterating until tests pass.
      outcome: (text) => ({ status: 'fail', summary: text.slice(0, 200) }),
    }),
    until: gate(task, repoDir),
  });
}

/** ON arm: ground in the ledger + draft, then commit each attempt (the memory). */
function onJob(task: Task, repoDir: string): Job {
  return loop({
    name: `solve-${task.id}`,
    max: MAX_ITERS,
    body: sequence(
      'iter',
      agentJob({
        label: 'solve',
        ground: true, // ← reads prior attempts' committed ledger + live draft
        prompt: (c) =>
          `Iteration ${c.iteration}.\n\n${task.problem}\n\n` +
          `Edit the files in this repo to make the test pass. ` +
          `Run \`${task.testCmd}\` to check. If an attempt fails, record why so ` +
          `the next attempt does not repeat it.`,
        outcome: (text) => ({ status: 'pass', summary: text.slice(0, 200) }),
      }),
      // Per-iteration memory: commit the attempt (the "what") welded to the draft
      // (the "way"). allowEmpty so a no-file-change attempt still leaves its why.
      commitJob({
        subject: (c) => `attempt ${c.iteration}: ${task.id}`,
        allowEmpty: true,
      }),
    ),
    until: gate(task, repoDir),
  });
}

async function testPasses(task: Task, dir: string): Promise<boolean> {
  const r = await execa('bash', ['-c', task.testCmd], { cwd: dir, reject: false });
  return r.exitCode === 0;
}

async function runTrial(task: Task, arm: Arm): Promise<TrialResult> {
  const repoDir = await prepareRepo(task, arm);
  const job = arm === 'on' ? onJob(task, repoDir) : offJob(task, repoDir);
  const result: RunResult = await run(job, {
    cwd: repoDir,
    engine: ENGINE,
    engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
  });
  const resolved = await testPasses(task, repoDir);
  const stat = result.stats.loops.find((l) => l.path.includes(`solve-${task.id}`));
  return {
    resolved,
    status: result.outcome.status,
    iterations: stat?.iterations ?? 0,
    inputTokens: result.stats.totalInputTokens,
    outputTokens: result.stats.totalOutputTokens,
    elapsedMs: result.stats.elapsedMs,
  };
}

const pct = (xs: TrialResult[]) =>
  xs.length ? (xs.filter((t) => t.resolved).length / xs.length) * 100 : 0;

async function main(): Promise<void> {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const tasks = loadTasks(filter);
  if (!tasks.length) {
    console.error(`no tasks under ${TASKS_DIR}`);
    process.exit(1);
  }

  console.log(
    `Ledger A/B — ${tasks.length} task(s) × ${TRIALS} trial(s), max ${MAX_ITERS} ` +
      `iters, engine ${ENGINE}, model ${MODEL ?? '(cli default)'}\n` +
      `tasks ${TASKS_DIR}`,
  );

  const results: TaskResult[] = [];
  for (const task of tasks) {
    console.log(`\n■ ${task.id}`);
    const arms: ArmResult[] = [];
    // OFF first, then ON — each trial on its own fresh copy of the seed.
    for (const arm of ['off', 'on'] as Arm[]) {
      const trials: TrialResult[] = [];
      for (let t = 0; t < TRIALS; t++) {
        process.stdout.write(`  ${arm.toUpperCase().padEnd(3)} trial ${t + 1}/${TRIALS} … `);
        const r = await runTrial(task, arm);
        console.log(
          `${r.resolved ? 'resolved' : 'unresolved'} · ${r.iterations} iter · ` +
            `${r.inputTokens + r.outputTokens} tok · ${(r.elapsedMs / 1000).toFixed(0)}s`,
        );
        trials.push(r);
      }
      console.log(`  ${arm.toUpperCase()} → ${pct(trials).toFixed(0)}% resolved (${trials.filter((x) => x.resolved).length}/${TRIALS})`);
      arms.push({ arm, trials });
    }
    results.push({ id: task.id, arms });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    config: {
      maxIters: MAX_ITERS,
      engine: ENGINE,
      model: MODEL ?? null,
      trials: TRIALS,
      tasksDir: TASKS_DIR,
    },
    tasks: results,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT} — run \`npx tsx bench/report.ts ${OUT}\` for the table`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
