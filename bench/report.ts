/**
 * Print the ON-vs-OFF table from a bench results file (default results.json).
 * The bottom line is the Ledger's lift: ON − OFF on resolve-rate,
 * iterations-to-converge, and tokens. See bench/PLAN.md.
 *
 *   npx tsx bench/report.ts [results-file]
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const RESULTS = arg
  ? isAbsolute(arg)
    ? arg
    : join(process.cwd(), arg)
  : join(HERE, 'results.json');

interface TrialResult {
  resolved: boolean;
  status: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}
interface ArmResult {
  arm: 'off' | 'on';
  trials: TrialResult[];
}
interface TaskResult {
  id: string;
  arms: ArmResult[];
}
interface Results {
  generatedAt: string;
  config: {
    maxIters: number;
    engine: string;
    model: string | null;
    trials: number;
    tasksDir?: string;
  };
  tasks: TaskResult[];
}

function trialsOf(t: TaskResult, arm: 'off' | 'on'): TrialResult[] {
  return t.arms.find((a) => a.arm === arm)?.trials ?? [];
}
const tok = (xs: TrialResult[]): number =>
  xs.reduce((a, t) => a + t.inputTokens + t.outputTokens, 0);
const resolved = (xs: TrialResult[]): number => xs.filter((t) => t.resolved).length;
const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
/** Mean iterations over the trials an arm actually resolved (converged in). */
function meanItersResolved(xs: TrialResult[]): number | null {
  return mean(xs.filter((t) => t.resolved).map((t) => t.iterations));
}
const fmt = (x: number | null, digits = 1): string =>
  x == null ? '—' : x.toFixed(digits);

function main(): void {
  if (!existsSync(RESULTS)) {
    console.error(`no ${RESULTS} — run \`npx tsx bench/ab.ts\` first`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(RESULTS, 'utf8')) as Results;
  const { tasks, config } = data;
  const N = config.trials;

  console.log(
    `Ledger A/B — ${tasks.length} task(s) × ${N} trial(s) · max ${config.maxIters} ` +
      `iters · ${config.engine} · ${config.model ?? '(cli default)'} · ${data.generatedAt}\n`,
  );

  // ── per-task table: resolve count k/N, mean iters (resolved), tokens ───────
  const W = { task: 18, res: 7, it: 5, tok: 9 };
  const head =
    pad('task', W.task) +
    '  ' + pad('OFF k/N', W.res) + padL('it', W.it) + padL('tok', W.tok) +
    '    ' + pad('ON k/N', W.res) + padL('it', W.it) + padL('tok', W.tok);
  console.log(head);
  console.log('─'.repeat(head.length));

  for (const t of tasks) {
    const off = trialsOf(t, 'off');
    const on = trialsOf(t, 'on');
    const cell = (xs: TrialResult[]) =>
      pad(`${resolved(xs)}/${xs.length}`, W.res) +
      padL(fmt(meanItersResolved(xs)), W.it) +
      padL(tok(xs).toLocaleString('en-US'), W.tok);
    console.log(pad(t.id, W.task) + '  ' + cell(off) + '    ' + cell(on));
  }

  // ── aggregate (the headline) ──────────────────────────────────────────────
  const allOff = tasks.flatMap((t) => trialsOf(t, 'off'));
  const allOn = tasks.flatMap((t) => trialsOf(t, 'on'));
  const offRate = (resolved(allOff) / allOff.length) * 100;
  const onRate = (resolved(allOn) / allOn.length) * 100;
  const offIters = meanItersResolved(allOff);
  const onIters = meanItersResolved(allOn);
  const offTok = tok(allOff);
  const onTok = tok(allOn);

  console.log('\n' + '─'.repeat(head.length));
  console.log(
    `resolve-rate   OFF ${fmt(offRate, 0)}% (${resolved(allOff)}/${allOff.length})` +
      `        ON ${fmt(onRate, 0)}% (${resolved(allOn)}/${allOn.length})`,
  );
  console.log(`mean iters*    OFF ${fmt(offIters)}                ON ${fmt(onIters)}`);
  console.log(
    `total tokens   OFF ${offTok.toLocaleString('en-US')}            ` +
      `ON ${onTok.toLocaleString('en-US')}`,
  );
  console.log('  * over trials that arm resolved\n');

  const sign = (x: number, d = 1, unit = '') =>
    `${x >= 0 ? '+' : ''}${x.toFixed(d)}${unit}`;
  const iterDelta = offIters != null && onIters != null ? onIters - offIters : null;
  console.log(
    `ON − OFF:  resolve ${sign(onRate - offRate, 0, 'pp')}` +
      (iterDelta != null ? `  ·  iters ${sign(iterDelta)}` : '') +
      `  ·  tokens ${sign(onTok - offTok, 0)}`,
  );
  console.log(
    'A positive resolve / lower iters for ON is the grounded claim; flat or ' +
      'negative, we learned it cheaply.',
  );
}

main();
