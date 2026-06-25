/**
 * Tend A/B — does the Ledger keep an INDEFINITE process coherent over a long
 * horizon, and which read-scaling (recent-N / retrieval / consolidation) holds it?
 *
 * Tend is the third archetype: an unbounded process that discovers the next unit
 * each iteration and works it until none remain. The hard part is memory over a
 * long horizon — the loop must not redo a done unit, must keep progressing, must
 * terminate when the backlog is clear.
 *
 * The design makes memory load-bearing (not recoverable from the workspace): the
 * SAME full backlog is shown in-prompt every iteration, and the only record of
 * what has been triaged is the commit log (`triage: <id>` subjects). So the loop
 * can only progress by reading its own ledger:
 *   - off        — no grounding: re-picks the first item forever (stuck)
 *   - recent     — recent-N: progresses until the done-log outgrows the 10-window,
 *                  then forgets early items and redoes them
 *   - retrieve   — a cheap model finds all prior triage commits — full horizon
 *   - consolidate— recent-N + a periodic roadmap (LEDGER.md) that keeps a SUMMARY
 *                  of done items recent, so recent-N still sees the whole horizon
 *
 * Metric: coverage (distinct items triaged / N), redos (duplicate triages),
 * whether it terminated (covered all N within the iteration budget).
 *
 *   BENCH_GROUND=consolidate BENCH_MODEL=haiku npx tsx bench/tend.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  run,
  loop,
  sequence,
  agentJob,
  commitJob,
  consolidateJob,
  fnJob,
  predicate,
  type Job,
  type JobContext,
  type Outcome,
} from '../src/api.ts';

type Mode = 'off' | 'recent' | 'retrieve' | 'consolidate';
const MODE = (process.env.BENCH_GROUND || 'recent') as Mode;
const MODEL = process.env.BENCH_MODEL || undefined;
const ENGINE = 'claude-cli';
const CONSOLIDATE_EVERY = 4;

const ITEMS: { id: string; desc: string }[] = [
  { id: 'item-01', desc: 'login returns 500 for SSO users' },
  { id: 'item-02', desc: 'typo in the footer copyright year' },
  { id: 'item-03', desc: 'orders export misses the tax column' },
  { id: 'item-04', desc: 'dark mode toggle does not persist' },
  { id: 'item-05', desc: 'payment webhook retries duplicate charges' },
  { id: 'item-06', desc: 'search ignores accented characters' },
  { id: 'item-07', desc: 'admin can delete their own account' },
  { id: 'item-08', desc: 'CSV import chokes on quoted commas' },
  { id: 'item-09', desc: 'session does not expire on password change' },
  { id: 'item-10', desc: 'avatar upload accepts 50MB files' },
  { id: 'item-11', desc: 'rate limiter counts cached responses' },
  { id: 'item-12', desc: 'timezone shown in UTC on the dashboard' },
];
const N = ITEMS.length;
const MAX_ITERS = Math.ceil(N * 1.5); // budget room for some redos

const BACKLOG = ITEMS.map((i) => `- ${i.id}: ${i.desc}`).join('\n');

/** Distinct items triaged and total triage commits, read from the log. */
async function triageStats(dir: string): Promise<{ distinct: number; total: number; redos: number }> {
  const r = await execa('git', ['log', '--format=%s'], { cwd: dir, reject: false });
  const ids = (r.stdout.match(/triage:\s*(item-\d+)/g) ?? []).map((s) => s.replace(/triage:\s*/, ''));
  const distinct = new Set(ids).size;
  return { distinct, total: ids.length, redos: ids.length - distinct };
}

function parsePicked(text: string): Outcome {
  // Prefer the explicit PICKED line (allow markdown around it); fall back to the
  // last item id mentioned, since the pick is usually stated last.
  const explicit = /PICKED:\s*\**\s*(item-\d{2})/i.exec(text)?.[1];
  const id = (explicit ?? (text.match(/item-\d{2}/gi) ?? []).pop())?.toLowerCase();
  return id
    ? { status: 'pass', summary: id, data: { item: id } }
    : { status: 'fail', summary: 'no item parsed', data: { item: 'unknown' } };
}

const ground = (mode: Mode) =>
  mode === 'retrieve' ? { retrieve: true } : mode === 'off' ? false : true;

function tendLoop(mode: Mode): Job {
  const triageStep = agentJob({
    label: 'triage',
    ground: ground(mode),
    prompt: () =>
      `You are triaging a backlog. The FULL backlog (it never changes):\n${BACKLOG}\n\n` +
      `Your prior triage decisions appear in the ledger above (lines like ` +
      `"triage: item-NN"). Pick exactly ONE item that is NOT already in your ledger, ` +
      `choosing the most important one remaining.\n\n` +
      `Respond with EXACTLY these two lines and nothing else:\n` +
      `PICKED: item-NN\n` +
      `ACTION: <high|med|low> — <one-line action>`,
    outcome: (text) => parsePicked(text),
  });
  const commitStep = commitJob({
    subject: (_c: JobContext, last: Outcome | undefined) =>
      `triage: ${(last?.data as { item?: string })?.item ?? 'unknown'}`,
    allowEmpty: true,
  });
  // consolidate mode folds the triage log into a rolling roadmap every K turns,
  // so recent-N grounding keeps seeing a SUMMARY of what's done.
  const maybeConsolidate = fnJob('maybe-consolidate', async (ctx) => {
    if (mode === 'consolidate' && ctx.iteration > 0 && ctx.iteration % CONSOLIDATE_EVERY === 0)
      return consolidateJob({ subject: 'docs(ledger): triage roadmap' })(ctx);
    return { status: 'pass', summary: 'skip' };
  });

  return loop({
    name: 'triage',
    max: MAX_ITERS,
    body: sequence('turn', triageStep, commitStep, maybeConsolidate),
    until: predicate(async (ctx) => (await triageStats(ctx.workspace.dir)).distinct >= N, 'all triaged'),
  });
}

async function prepareRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-tend-`));
  const git = (args: string[]) => execa('git', args, { cwd: dir });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'bench@loops.local']);
  await git(['config', 'user.name', 'loops bench']);
  await git(['commit', '-q', '--allow-empty', '-m', 'chore: start triage']);
  return dir;
}

async function main(): Promise<void> {
  console.log(
    `Tend A/B — triage ${N} items, grounding=${MODE}, model ${MODEL ?? '(cli default)'}, ` +
      `max ${MAX_ITERS} turns`,
  );
  const dir = await prepareRepo();
  let outcome;
  try {
    const result = await run(tendLoop(MODE), {
      cwd: dir,
      engine: ENGINE,
      engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
    });
    outcome = result.outcome;
    const stats = await triageStats(dir);
    const iters = result.stats.loops.find((l) => l.path.includes('triage'))?.iterations ?? 0;
    console.log(
      `\n${MODE}: coverage ${stats.distinct}/${N}  ·  redos ${stats.redos}  ·  ` +
        `${iters} turns  ·  ${outcome.status === 'pass' ? 'cleared the backlog' : `stopped (${outcome.status})`}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
