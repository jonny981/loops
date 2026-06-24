/**
 * Graph A/B — does cross-node memory help a DEEP agent graph?
 *
 * The single-loop benchmarks (ab.ts) measure the Ledger across loop ITERATIONS.
 * This measures it across graph NODES: a chain where an upstream node establishes
 * a load-bearing invariant whose rationale lives ONLY in its commit body (not its
 * code), and downstream nodes can innocently break it — a cross-node Chesterton's
 * fence. This is the gap the amps-os dispatch protocol leaves open: the dispatch
 * chain carries WHO ran, not WHY they chose what they chose.
 *
 * The one isolated variable: both arms build identical git history (each node =
 * agent then commit), but only ON grounds each node in the accumulated ledger
 * (`ground:true`) — so only ON reads the upstream why. OFF sees the code and the
 * task, re-derives, and removes the fence it cannot see the reason for.
 *
 * Resolve = a hidden invariant gate (the nodes never see it) passes after the
 * whole chain. Depth is a knob: a longer chain accumulates more why, so the lift
 * should grow with depth.
 *
 * NOT offline: the nodes drive the real claude-cli engine. Each trial runs in a
 * fresh git repo seeded with node 1's code AND node 1's commit (the seeded why).
 *
 *   BENCH_TRIALS=5 BENCH_MODEL=haiku BENCH_OUT=results-graph.json \
 *     npx tsx bench/graph.ts
 *   npx tsx bench/report.ts bench/results-graph.json
 */

import {
  cpSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import {
  run,
  sequence,
  agentJob,
  commitJob,
  type Job,
  type RunResult,
} from '../src/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const resolveIn = (p: string) => (isAbsolute(p) ? p : join(HERE, p));

const TASK_DIR = resolveIn(process.env.BENCH_GRAPH_TASK || 'graph-tasks/stable-store');
const OUT = resolveIn(process.env.BENCH_OUT || 'results-graph.json');
const MODEL = process.env.BENCH_MODEL || undefined;
const TRIALS = Number(process.env.BENCH_TRIALS ?? 1);
const ENGINE = 'claude-cli';

type Arm = 'off' | 'on';

interface GraphTask {
  name: string;
  gate: string;
  foundation_why: string;
  nodes: { name: string; prompt: string }[];
}

interface TrialResult {
  resolved: boolean;
  status: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

function loadTask(): GraphTask {
  return JSON.parse(readFileSync(join(TASK_DIR, 'task.json'), 'utf8')) as GraphTask;
}

/** Fresh repo seeded with node 1's code AND node 1's commit (the upstream why). */
async function prepareRepo(task: GraphTask): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-graph-${task.name}-`));
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true });
  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: dir, input, stdin: input === undefined ? 'ignore' : undefined });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'bench@loops.local']);
  await git(['config', 'user.name', 'loops bench']);
  await git(['add', '-A']);
  // The seed commit body IS node 1's "way" — the rationale ON grounds on, OFF ignores.
  await git(['commit', '-q', '-F', '-'], task.foundation_why);
  return dir;
}

/** The node chain: each node = an agent turn then a commit. Only `ground` varies. */
function chainJob(task: GraphTask, arm: Arm): Job {
  const steps: Job[] = [];
  for (const node of task.nodes) {
    steps.push(
      agentJob({
        label: node.name,
        ground: arm === 'on', // ← the single isolated variable: read the upstream why
        prompt: node.prompt,
        outcome: (text) => ({ status: 'pass', summary: text.slice(0, 200) }),
      }),
    );
    steps.push(commitJob({ subject: `feat(store): ${node.name}` }));
  }
  return sequence('chain', ...steps);
}

async function gatePasses(task: GraphTask, dir: string): Promise<boolean> {
  copyFileSync(join(TASK_DIR, 'gate.mjs'), join(dir, '__gate.mjs'));
  const r = await execa('bash', ['-c', task.gate], { cwd: dir, reject: false });
  return r.exitCode === 0;
}

async function runTrial(task: GraphTask, arm: Arm): Promise<TrialResult> {
  const dir = await prepareRepo(task);
  const result: RunResult = await run(chainJob(task, arm), {
    cwd: dir,
    engine: ENGINE,
    engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
  });
  const resolved = await gatePasses(task, dir);
  return {
    resolved,
    status: result.outcome.status,
    iterations: task.nodes.length, // chain depth
    inputTokens: result.stats.totalInputTokens,
    outputTokens: result.stats.totalOutputTokens,
    elapsedMs: result.stats.elapsedMs,
  };
}

const pct = (xs: TrialResult[]) =>
  xs.length ? (xs.filter((t) => t.resolved).length / xs.length) * 100 : 0;

async function main(): Promise<void> {
  const task = loadTask();
  console.log(
    `Graph A/B — "${task.name}" · ${task.nodes.length}-node chain × ${TRIALS} trial(s) · ` +
      `engine ${ENGINE}, model ${MODEL ?? '(cli default)'}\n` +
      `nodes: ${task.nodes.map((n) => n.name).join(' → ')} (seeded foundation carries the why)`,
  );

  const arms: { arm: Arm; trials: TrialResult[] }[] = [];
  for (const arm of ['off', 'on'] as Arm[]) {
    const trials: TrialResult[] = [];
    for (let t = 0; t < TRIALS; t++) {
      process.stdout.write(`  ${arm.toUpperCase().padEnd(3)} trial ${t + 1}/${TRIALS} … `);
      const r = await runTrial(task, arm);
      console.log(
        `${r.resolved ? 'INVARIANT HELD' : 'fence broken'} · ` +
          `${r.inputTokens + r.outputTokens} tok · ${(r.elapsedMs / 1000).toFixed(0)}s`,
      );
      trials.push(r);
    }
    console.log(`  ${arm.toUpperCase()} → ${pct(trials).toFixed(0)}% held (${trials.filter((x) => x.resolved).length}/${TRIALS})`);
    arms.push({ arm, trials });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    config: { maxIters: task.nodes.length, engine: ENGINE, model: MODEL ?? null, trials: TRIALS, tasksDir: TASK_DIR },
    tasks: [{ id: task.name, arms }],
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${OUT} — run \`npx tsx bench/report.ts ${OUT}\` for the table`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
