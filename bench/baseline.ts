/**
 * Head-to-head — loops+Ledger vs a genuine external orchestrator (no loops).
 *
 * The graph A/B compares loops ON vs OFF (its own ablation). A skeptic says OFF is
 * a strawman. So this runs the SAME contract task through a vanilla orchestrator
 * that does NOT import loops — just raw `claude -p` per node — in two modes:
 *   - nomem:   sequential agents, workspace only (the naive hand-rolled chain).
 *   - gitdump: same, but `git log` is pasted into every node's prompt (the STRONG
 *              baseline — brute-force history access without loops' grounding).
 * Compared against loops+Ledger (9/10, from graph.ts). If gitdump ties loops, the
 * Ledger is mere ergonomics; if it loses, loops' structured grounding is a real
 * capability. Either answer is honest.
 *
 * NOT offline: drives real claude-cli. Each trial runs in a fresh git repo seeded
 * with node 1's code AND node 1's commit (the seeded why, in git history only).
 *
 *   BENCH_MODE=gitdump BENCH_TRIALS=10 BENCH_MODEL=haiku npx tsx bench/baseline.ts
 */

import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_DIR = join(HERE, 'graph-tasks/stable-store-contract');

type Mode = 'nomem' | 'gitdump';
const MODE = (process.env.BENCH_MODE || 'gitdump') as Mode;
const TRIALS = Number(process.env.BENCH_TRIALS ?? 10);
const MODEL = process.env.BENCH_MODEL || 'haiku';

interface Task {
  gate: string;
  foundation_why: string;
  nodes: { name: string; prompt: string }[];
}

const task = JSON.parse(readFileSync(join(TASK_DIR, 'task.json'), 'utf8')) as Task;

async function prepareRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-baseline-`));
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true });
  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: dir, input, stdin: input === undefined ? 'ignore' : undefined });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'bench@loops.local']);
  await git(['config', 'user.name', 'loops bench']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-F', '-'], task.foundation_why);
  return dir;
}

/** Run one node as a raw claude-cli call — no loops, fresh process = fresh context. */
async function runNode(dir: string, prompt: string): Promise<void> {
  let full = prompt;
  if (MODE === 'gitdump') {
    const log = await execa('git', ['log', '--format=%s%n%n%b%n----'], { cwd: dir, reject: false });
    full =
      `Project history (most recent first), for context:\n\n${log.stdout}\n\n` +
      `---\n\n${prompt}`;
  }
  await execa(
    'claude',
    ['-p', '--permission-mode', 'bypassPermissions', '--model', MODEL],
    { cwd: dir, input: full, reject: false, stdin: undefined },
  );
}

async function gatePasses(dir: string): Promise<boolean> {
  copyFileSync(join(TASK_DIR, 'gate.mjs'), join(dir, '__gate.mjs'));
  const r = await execa('bash', ['-c', task.gate], { cwd: dir, reject: false });
  return r.exitCode === 0;
}

async function runTrial(): Promise<boolean> {
  const dir = await prepareRepo();
  try {
    for (const node of task.nodes) await runNode(dir, node.prompt);
    return await gatePasses(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(
    `Head-to-head baseline — vanilla orchestrator (NO loops), mode=${MODE}, ` +
      `model=${MODEL}, ${TRIALS} trials\nnodes: ${task.nodes.map((n) => n.name).join(' → ')}`,
  );
  let held = 0;
  for (let t = 0; t < TRIALS; t++) {
    process.stdout.write(`  trial ${t + 1}/${TRIALS} … `);
    const ok = await runTrial();
    if (ok) held++;
    console.log(ok ? 'INVARIANT HELD' : 'fence broken');
  }
  console.log(`\n${MODE} → ${((held / TRIALS) * 100).toFixed(0)}% held (${held}/${TRIALS})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
