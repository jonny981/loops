/**
 * SWE-bench resolve@K — the literature-comparable arm of the Ledger A/B.
 *
 * GCC (arXiv 2508.00031) isolates its git-context layer as a controlled A/B on
 * SWE-bench (Claude Sonnet 80.2% with vs 74.0% without = +6.2pp). This runs the
 * same kind of A/B for loops' Ledger, on SWE-bench Lite instances.
 *
 * SWE-bench forbids showing the agent the tests, so there is no honest gate to
 * converge on during editing. Instead each instance gets K fresh attempts on the
 * same evolving checkout:
 *   - OFF: each attempt sees only the files (the workspace is the state).
 *   - ON:  each attempt also grounds in the committed ledger + draft — what the
 *          prior attempts tried and why — the cross-iteration memory under test.
 * After K attempts the final diff from base_commit is the prediction. The OFFICIAL
 * swebench Docker harness then decides resolved (FAIL_TO_PASS + PASS_TO_PASS),
 * so loops never grades its own work.
 *
 * This writes one predictions JSONL per arm; evaluate them with:
 *   python -m swebench.harness.run_evaluation -d princeton-nlp/SWE-bench_Lite \
 *     -p <predictions-on.jsonl> -id loops-on -n none --cache_level env --max_workers 2
 *
 * Needs host Claude auth (the agent edits real repos) and the instances file:
 *   BENCH_SWE_INSTANCES=/path/instances.json BENCH_K=2 BENCH_MODEL=sonnet \
 *     npx tsx bench/swebench.ts [instance_id ...]
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  run,
  sequence,
  agentJob,
  commitJob,
  type Job,
  type RunResult,
} from '../src/api.ts';

interface Instance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
}

const INSTANCES_PATH = process.env.BENCH_SWE_INSTANCES;
if (!INSTANCES_PATH) {
  console.error('set BENCH_SWE_INSTANCES to a JSON array of instances');
  process.exit(1);
}
const K = Number(process.env.BENCH_K ?? 2);
const MODEL = process.env.BENCH_MODEL || 'sonnet';
const CACHE = process.env.BENCH_SWE_CACHE || join(tmpdir(), 'loops-swe-cache');
const OUT_DIR = process.env.BENCH_SWE_OUT || join(tmpdir(), 'loops-swe-out');
// claude-cli locally; set BENCH_ENGINE=agent-sdk on a headless box (API-key auth).
const ENGINE = process.env.BENCH_ENGINE || 'claude-cli';

type Arm = 'off' | 'on';

/** Clone each repo once into a local cache; per-run copies clone from it fast. */
async function ensureCache(repo: string): Promise<string> {
  const dir = join(CACHE, repo.replace('/', '__'));
  try {
    await execa('git', ['-C', dir, 'rev-parse', '--git-dir']);
    return dir; // already cloned
  } catch {
    mkdirSync(CACHE, { recursive: true });
    await execa('git', ['clone', '--quiet', `https://github.com/${repo}.git`, dir]);
    return dir;
  }
}

/** A fresh checkout at base_commit — the per-(instance, arm) workspace. */
async function prepareRepo(inst: Instance): Promise<string> {
  const cache = await ensureCache(inst.repo);
  const dir = mkdtempSync(join(tmpdir(), `loops-swe-${inst.instance_id}-`));
  const git = (args: string[], cwd = dir) => execa('git', args, { cwd });
  await git(['clone', '--quiet', cache, dir], CACHE);
  await git(['checkout', '--quiet', inst.base_commit]);
  await git(['config', 'user.email', 'bench@loops.local']);
  await git(['config', 'user.name', 'loops bench']);
  return dir;
}

const PROMPT = (inst: Instance, iter: number) =>
  `Attempt ${iter}. You are fixing an issue in the ${inst.repo} repository ` +
  `(checked out at the relevant commit).\n\n## Issue\n${inst.problem_statement}\n\n` +
  `Edit the source files to resolve the issue. Do NOT modify or add test files — ` +
  `the hidden test suite will judge your fix. When unsure, read the surrounding code first.`;

/**
 * One attempt (1-based `k`). Each attempt is its own run so we can capture its diff
 * for pass@K (resolved if ANY attempt passes) — the final cumulative diff alone
 * penalises a later attempt that regresses a correct earlier one. For ON, the attempt
 * grounds in the prior attempts' commits (the git log persists across runs on the
 * shared checkout) and commits its own work. The retry framing tells a grounded
 * attempt to BUILD ON the prior, not to assume it was wrong — the latter makes a weak
 * model talk itself out of a correct first attempt.
 */
function attemptJob(inst: Instance, arm: Arm, k: number): Job {
  const ground = arm === 'on';
  const agent = agentJob({
    label: 'fix',
    ground,
    prompt: () =>
      PROMPT(inst, k) +
      (ground && k > 1
        ? `\n\nBuild on the prior attempt; only change course if you find a concrete, ` +
          `named problem with it. Do not rewrite code that already works.`
        : ''),
    outcome: (text) => ({ status: 'fail', summary: text.slice(0, 200) }),
  });
  return ground
    ? sequence(
        'attempt',
        agent,
        commitJob({ subject: () => `attempt ${k}: ${inst.instance_id}`, allowEmpty: true }),
      )
    : agent;
}

async function captureDiff(dir: string, base: string): Promise<string> {
  const r = await execa('git', ['diff', base], { cwd: dir, reject: false });
  return r.stdout ?? '';
}

interface ArmRun {
  patches: string[]; // diff vs base after each attempt (for pass@K)
  finalPatch: string; // cumulative diff after the last attempt (resolve@K-final)
  tokens: number; // total across attempts
  result: RunResult; // the last attempt's run (for the dead-engine check)
}

async function runArm(inst: Instance, arm: Arm): Promise<ArmRun> {
  const dir = await prepareRepo(inst);
  const patches: string[] = [];
  let tokens = 0;
  let result!: RunResult;
  try {
    for (let k = 1; k <= K; k++) {
      result = await run(attemptJob(inst, arm, k), {
        cwd: dir,
        engine: ENGINE,
        engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
      });
      tokens += result.stats.totalInputTokens + result.stats.totalOutputTokens;
      patches.push(await captureDiff(dir, inst.base_commit));
    }
    return { patches, finalPatch: patches[patches.length - 1] ?? '', tokens, result };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const all = JSON.parse(readFileSync(INSTANCES_PATH!, 'utf8')) as Instance[];
  const insts = filter.length ? all.filter((i) => filter.includes(i.instance_id)) : all;
  if (!insts.length) {
    console.error('no matching instances');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const predPath = (arm: Arm) => join(OUT_DIR, `predictions-${arm}.jsonl`);
  const attemptPath = (arm: Arm, k: number) => join(OUT_DIR, `predictions-${arm}-a${k}.jsonl`);
  // Truncate prior runs (the final + each attempt's file).
  for (const arm of ['off', 'on'] as Arm[]) {
    appendFileSync(predPath(arm), '', { flag: 'w' });
    for (let k = 1; k <= K; k++) appendFileSync(attemptPath(arm, k), '', { flag: 'w' });
  }

  console.log(
    `SWE-bench resolve@${K} — ${insts.length} instance(s), model ${MODEL}, engine ${ENGINE}\n` +
      `predictions → ${OUT_DIR}`,
  );

  // Circuit breaker: a rate-limited / logged-out claude-cli returns in ~5s with
  // no output tokens and no edit. Left unchecked the run writes a full set of
  // empty predictions that score 0/6 — fake data indistinguishable from a real
  // null result. Two such runs in a row means the engine is dead; abort loudly
  // (exit 3) so the caller stops instead of burning the rest of the matrix.
  let deadStreak = 0;
  for (const inst of insts) {
    console.log(`\n■ ${inst.instance_id} (${inst.repo})`);
    for (const arm of ['off', 'on'] as Arm[]) {
      process.stdout.write(`  ${arm.toUpperCase().padEnd(3)} … `);
      const { patches, finalPatch, tokens, result } = await runArm(inst, arm);
      const sizes = patches.map((p) => (p.trim() ? p.split('\n').length : 0)).join(',');
      console.log(
        `${finalPatch ? `${finalPatch.split('\n').length} diff lines` : 'EMPTY patch'} · ` +
          `attempts [${sizes}] · ${tokens} tok · ${(result.stats.elapsedMs / 1000).toFixed(0)}s`,
      );
      const rec = (path: string, p: string) =>
        appendFileSync(
          path,
          JSON.stringify({
            instance_id: inst.instance_id,
            model_name_or_path: `loops-${arm}`,
            model_patch: p,
          }) + '\n',
        );
      rec(predPath(arm), finalPatch);
      patches.forEach((p, i) => rec(attemptPath(arm, i + 1), p));
      const dead =
        !finalPatch.trim() && result.stats.totalOutputTokens === 0 && result.stats.elapsedMs < 20_000;
      deadStreak = dead ? deadStreak + 1 : 0;
      if (deadStreak >= 2) {
        console.error(
          '\nENGINE DEAD: 2 consecutive empty/0-token runs (likely usage limit or logout). Aborting.',
        );
        process.exit(3);
      }
    }
  }

  console.log(
    `\nwrote predictions. Evaluate each arm with the official harness:\n` +
      `  python -m swebench.harness.run_evaluation -d princeton-nlp/SWE-bench_Lite \\\n` +
      `    -p ${predPath('on')} -id loops-on -n none --cache_level env --max_workers 2`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
