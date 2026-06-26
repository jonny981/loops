/**
 * SWE-ContextBench — does loops' committed memory help an agent REUSE experience
 * across related issues? (arXiv 2602.08316: base tasks + related tasks sharing
 * context; the paper's headline is that SUMMARIZED, correctly-selected experience
 * beats raw trajectory dumps — exactly loops' Ledger thesis.)
 *
 * For each base->related group (the oracle relationship), loops solves the BASE task
 * once and the experience is captured two ways:
 *   - summary    = the base solve's committed "way" (handoff + compacted working log),
 *                  the few-hundred-token distilled record — loops' artifact.
 *   - trajectory = the base solve's raw reasoning stream + the diff that fixed it,
 *                  the bulky record the paper's "Context Learning" arm uses.
 * The RELATED task is then solved three ways and test-scored:
 *   - off     : no prior experience (the No-Context baseline).
 *   - summary : the summary injected as prior experience (loops' Summary Learning).
 *   - dump    : the full trajectory injected (the raw Context Learning the summary should beat).
 * Only the related task is scored, by the OFFICIAL swebench Docker harness, so loops
 * never grades its own work:
 *   python -m swebench.harness.run_evaluation -d jiayuanz3/SWEContextBench --split train \
 *     -p <predictions-summary.jsonl> -id cb-summary -n none --cache_level env --max_workers 2
 *
 *   BENCH_CB_GROUPS=bench/contextbench/groups.json BENCH_MODEL=sonnet npx tsx bench/swecontextbench.ts
 *   BENCH_DRY=1 npx tsx bench/swecontextbench.ts   # offline wiring check (mock engine, no network/spend)
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  run,
  sequence,
  agentJob,
  commitJob,
  MockEngine,
  type Job,
  type RunOptions,
} from '../src/api.ts';

interface Task {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  version: string;
}
interface Group {
  repo: string;
  base: Task;
  related: Task;
}
type Arm = 'off' | 'summary' | 'dump';
interface Experience {
  summary: string;
  trajectory: string;
  tokens: number;
}

const GROUPS_PATH = process.env.BENCH_CB_GROUPS || 'bench/contextbench/groups.json';
const MODEL = process.env.BENCH_MODEL || 'sonnet';
const ENGINE = process.env.BENCH_ENGINE || 'claude-cli';
const CACHE = process.env.BENCH_CB_CACHE || join(tmpdir(), 'loops-cb-cache');
const OUT_DIR = process.env.BENCH_CB_OUT || join(tmpdir(), 'loops-cb-out');
const DRY = !!process.env.BENCH_DRY; // offline: mock engine + a throwaway local repo

const PROMPT = (t: Task) =>
  `You are fixing an issue in the ${t.repo} repository (checked out at the relevant commit).\n\n` +
  `## Issue\n${t.problem_statement}\n\n` +
  `Edit the source files to resolve the issue. Do NOT modify or add test files — the hidden ` +
  `test suite judges your fix. When unsure, read the surrounding code first.`;

/** The related prompt for an arm: the No-Context baseline, or the issue with prior experience. */
function relatedPrompt(related: Task, arm: Arm, exp: Experience | null): string {
  if (arm === 'off' || !exp) return PROMPT(related);
  const body = arm === 'summary' ? exp.summary : exp.trajectory;
  const kind =
    arm === 'summary'
      ? 'a distilled SUMMARY of how and why a related issue in this repo was just solved'
      : 'the FULL record (reasoning and the diff) of how a related issue in this repo was just solved';
  return (
    `## Prior experience — ${kind}:\n\n${body || '(no experience captured)'}\n\n---\n\n` +
    `${PROMPT(related)}\n\nThe prior issue may share a root cause, API, or fix pattern — reuse it where it applies.`
  );
}

/** Clone each repo once into a local cache; per-run copies clone from it fast. */
async function ensureCache(repo: string): Promise<string> {
  const dir = join(CACHE, repo.replace('/', '__'));
  try {
    await execa('git', ['-C', dir, 'rev-parse', '--git-dir']);
    return dir;
  } catch {
    mkdirSync(CACHE, { recursive: true });
    await execa('git', ['clone', '--quiet', `https://github.com/${repo}.git`, dir]);
    return dir;
  }
}

/** A fresh checkout at base_commit — the per-(task, arm) workspace. DRY makes a stub repo. */
async function prepareRepo(t: Task): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-cb-${t.instance_id}-`));
  const git = (args: string[], cwd = dir) => execa('git', args, { cwd });
  if (DRY) {
    await git(['init', '--quiet']);
    writeFileSync(join(dir, 'seed.py'), '# stub repo for offline wiring\n');
    await git(['config', 'user.email', 'bench@loops.local']);
    await git(['config', 'user.name', 'loops bench']);
    await git(['add', '-A']);
    await git(['commit', '--quiet', '-m', 'seed']);
    return dir;
  }
  const cache = await ensureCache(t.repo);
  await git(['clone', '--quiet', cache, dir], CACHE);
  await git(['checkout', '--quiet', t.base_commit]);
  await git(['config', 'user.email', 'bench@loops.local']);
  await git(['config', 'user.name', 'loops bench']);
  return dir;
}

async function captureDiff(dir: string, base: string): Promise<string> {
  const ref = DRY ? 'HEAD' : base;
  const r = await execa('git', ['diff', ref], { cwd: dir, reject: false });
  return r.stdout ?? '';
}

/** Run options for a workspace — mock engine offline, else the host claude-cli. */
function optsFor(dir: string, onText?: (s: string) => void): RunOptions {
  if (DRY) {
    return {
      cwd: dir,
      engine: 'mock',
      engines: {
        mock: () =>
          new MockEngine((req) => {
            const text = `MOCK reasoning for: ${req.prompt.slice(0, 60).replace(/\n/g, ' ')}…`;
            onText?.(text);
            return text;
          }),
      },
    };
  }
  return {
    cwd: dir,
    engine: ENGINE,
    engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
    onEvent: onText
      ? (e) => {
          if (e.kind === 'engine:text') onText(e.delta);
        }
      : undefined,
  };
}

/** Solve the BASE task once; capture the experience two ways (summary + trajectory). */
async function solveBase(base: Task): Promise<Experience> {
  const dir = await prepareRepo(base);
  try {
    let traj = '';
    const job: Job = sequence(
      'base',
      agentJob({
        label: 'base-fix',
        ground: true, // write the handoff / working notes — that becomes the summary
        prompt: () => PROMPT(base),
        // MUST be `pass`: this runs in a `sequence` (stopOnError), so a `fail` here would
        // stop before `commitJob` and leave the base commit (its message, not our handoff).
        outcome: (text) => ({ status: 'pass', summary: text.slice(0, 200) }),
      }),
      commitJob({ subject: () => `solve: ${base.instance_id}`, allowEmpty: true }),
    );
    const result = await run(job, optsFor(dir, (s) => (traj += s)));
    // summary = the committed "way" (handoff + compacted working log); trajectory =
    // the raw reasoning stream plus the diff that fixed it (the bulky record).
    const body = await execa('git', ['log', '-1', '--format=%B'], { cwd: dir, reject: false });
    const diff = await captureDiff(dir, base.base_commit);
    const summary = (body.stdout ?? '').trim();
    const trajectory = `${traj.trim()}\n\n## The fix (diff)\n${diff}`.trim();
    return {
      summary,
      trajectory,
      tokens: result.stats.totalInputTokens + result.stats.totalOutputTokens,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ArmRun {
  patch: string;
  tokens: number;
  dead: boolean;
}

/** Solve the RELATED task for one arm; return its prediction patch. */
async function solveRelated(related: Task, arm: Arm, exp: Experience | null): Promise<ArmRun> {
  const dir = await prepareRepo(related);
  try {
    const job = agentJob({
      label: `related-${arm}`,
      prompt: () => relatedPrompt(related, arm, exp),
      outcome: (text) => ({ status: 'fail', summary: text.slice(0, 200) }),
    });
    const result = await run(job, optsFor(dir));
    const patch = await captureDiff(dir, related.base_commit);
    const tokens = result.stats.totalInputTokens + result.stats.totalOutputTokens;
    const dead = !patch.trim() && result.stats.totalOutputTokens === 0 && result.stats.elapsedMs < 20_000;
    return { patch, tokens, dead };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const all = JSON.parse(readFileSync(GROUPS_PATH, 'utf8')) as Group[];
  const groups = filter.length ? all.filter((g) => filter.includes(g.related.instance_id)) : all;
  if (!groups.length) {
    console.error('no matching groups');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const arms: Arm[] = ['off', 'summary', 'dump'];
  const predPath = (arm: Arm) => join(OUT_DIR, `predictions-${arm}.jsonl`);
  for (const arm of arms) appendFileSync(predPath(arm), '', { flag: 'w' });

  console.log(
    `SWE-ContextBench — ${groups.length} group(s), model ${DRY ? 'MOCK' : MODEL}, engine ${DRY ? 'mock' : ENGINE}\n` +
      `arms: off · summary · dump   predictions → ${OUT_DIR}`,
  );

  let deadStreak = 0;
  for (const g of groups) {
    console.log(`\n■ ${g.related.instance_id} (${g.repo})  ← base ${g.base.instance_id}`);
    // Solve the base once; off needs no experience, summary/dump share it.
    const exp = await solveBase(g.base);
    console.log(
      `  base solved · summary ${exp.summary.length}c · trajectory ${exp.trajectory.length}c · ${exp.tokens} tok`,
    );
    if (DRY) {
      // Eyeball the injection: each arm's related prompt should differ as designed.
      for (const arm of arms)
        console.log(`  [dry] ${arm.padEnd(7)} prompt ${relatedPrompt(g.related, arm, exp).length}c`);
    }
    for (const arm of arms) {
      process.stdout.write(`  ${arm.padEnd(7)} … `);
      const { patch, tokens, dead } = await solveRelated(g.related, arm, arm === 'off' ? null : exp);
      console.log(`${patch.trim() ? `${patch.split('\n').length} diff lines` : 'EMPTY'} · ${tokens} tok`);
      appendFileSync(
        predPath(arm),
        JSON.stringify({
          instance_id: g.related.instance_id,
          model_name_or_path: `loops-${arm}`,
          model_patch: patch,
        }) + '\n',
      );
      deadStreak = dead ? deadStreak + 1 : 0;
      if (deadStreak >= 3) {
        console.error('\nENGINE DEAD: 3 consecutive empty/0-token runs (usage limit or logout). Aborting.');
        process.exit(3);
      }
    }
  }

  console.log(
    `\nwrote predictions. Score each arm with the official harness:\n` +
      arms
        .map(
          (arm) =>
            `  python -m swebench.harness.run_evaluation -d jiayuanz3/SWEContextBench --split train \\\n` +
            `    -p ${predPath(arm)} -id cb-${arm} -n none --cache_level env --max_workers 2`,
        )
        .join('\n'),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
