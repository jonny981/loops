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
 * NOT offline: the arms drive the real `claude-cli` engine, which edits files, so
 * this needs host Claude auth (unlike the unit tests). Each (task, arm) runs in
 * its own throwaway git repo seeded from the task, so the arms never contaminate
 * each other and `commitJob`'s `git add -A` is safe.
 *
 *   npx tsx bench/ab.ts                 # all tasks, both arms
 *   npx tsx bench/ab.ts fix-fizzbuzz    # one task
 *   BENCH_MAX_ITERS=4 BENCH_MODEL=claude-sonnet-4-6 npx tsx bench/ab.ts
 *
 * Then:  npx tsx bench/report.ts
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
import { dirname, join } from 'node:path';
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
const TASKS_DIR = join(HERE, 'tasks');
const RESULTS = join(HERE, 'results.json');

/** Same cap for both arms — only the Ledger varies. */
const MAX_ITERS = Number(process.env.BENCH_MAX_ITERS ?? 6);
/** Same model for both arms (undefined → the CLI default). Critical for the A/B. */
const MODEL = process.env.BENCH_MODEL || undefined;
const ENGINE = 'claude-cli';

type Arm = 'off' | 'on';

interface Task {
  id: string;
  problem: string;
  testCmd: string;
  seedDir: string;
}

interface ArmResult {
  arm: Arm;
  /** The authoritative check: the test command passes on the final tree. */
  resolved: boolean;
  /** The loop's own terminal status (pass / exhausted / fail / …). */
  status: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  repoDir: string;
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

/** A fresh git repo seeded at the task's broken state — the per-arm workspace. */
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

async function runArm(task: Task, arm: Arm): Promise<ArmResult> {
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
    arm,
    resolved,
    status: result.outcome.status,
    iterations: stat?.iterations ?? 0,
    inputTokens: result.stats.totalInputTokens,
    outputTokens: result.stats.totalOutputTokens,
    elapsedMs: result.stats.elapsedMs,
    repoDir,
  };
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const tasks = loadTasks(filter);
  if (!tasks.length) {
    console.error(`no tasks under ${TASKS_DIR}` + (filter.length ? ` matching ${filter.join(', ')}` : ''));
    process.exit(1);
  }

  console.log(
    `Ledger A/B — ${tasks.length} task(s), max ${MAX_ITERS} iters, ` +
      `engine ${ENGINE}, model ${MODEL ?? '(cli default)'}`,
  );

  const results: TaskResult[] = [];
  for (const task of tasks) {
    console.log(`\n■ ${task.id}`);
    const arms: ArmResult[] = [];
    // OFF first, then ON — each on its own fresh copy of the seed.
    for (const arm of ['off', 'on'] as Arm[]) {
      process.stdout.write(`  ${arm.toUpperCase().padEnd(3)} … `);
      const r = await runArm(task, arm);
      console.log(
        `${r.resolved ? 'resolved' : 'unresolved'} · ${r.iterations} iter · ` +
          `${r.inputTokens + r.outputTokens} tok · ${(r.elapsedMs / 1000).toFixed(0)}s`,
      );
      arms.push(r);
    }
    results.push({ id: task.id, arms });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    config: { maxIters: MAX_ITERS, engine: ENGINE, model: MODEL ?? null },
    tasks: results,
  };
  writeFileSync(RESULTS, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${RESULTS} — run \`npx tsx bench/report.ts\` for the table`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
