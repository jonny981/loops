/**
 * Print the ON-vs-OFF table from bench/results.json. The bottom line is the
 * Ledger's lift: ON − OFF on resolve-rate, iterations-to-converge, and tokens.
 * See bench/PLAN.md.
 *
 *   npx tsx bench/report.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results.json');

interface ArmResult {
  arm: 'off' | 'on';
  resolved: boolean;
  status: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}
interface TaskResult {
  id: string;
  arms: ArmResult[];
}
interface Results {
  generatedAt: string;
  config: { maxIters: number; engine: string; model: string | null };
  tasks: TaskResult[];
}

function armOf(t: TaskResult, arm: 'off' | 'on'): ArmResult | undefined {
  return t.arms.find((a) => a.arm === arm);
}
const tokens = (a?: ArmResult): number =>
  a ? a.inputTokens + a.outputTokens : 0;
const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
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

  console.log(
    `Ledger A/B — ${tasks.length} task(s) · max ${config.maxIters} iters · ` +
      `${config.engine} · ${config.model ?? '(cli default)'} · ${data.generatedAt}\n`,
  );

  // ── per-task table ────────────────────────────────────────────────────────
  const W = { task: 18, res: 5, it: 4, tok: 9 };
  const header =
    pad('task', W.task) +
    '  ' + pad('OFF', W.res) + padL('it', W.it) + padL('tok', W.tok) +
    '   ' + pad('ON', W.res) + padL('it', W.it) + padL('tok', W.tok);
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const t of tasks) {
    const off = armOf(t, 'off');
    const on = armOf(t, 'on');
    const cell = (a?: ArmResult) =>
      pad(a?.resolved ? '✓' : '✗', W.res) +
      padL(a?.iterations ?? '—', W.it) +
      padL(tokens(a).toLocaleString('en-US'), W.tok);
    console.log(
      pad(t.id, W.task) + '  ' + cell(off) + '   ' + cell(on),
    );
  }

  // ── aggregate (the headline) ──────────────────────────────────────────────
  const n = tasks.length;
  const offSolved = tasks.filter((t) => armOf(t, 'off')?.resolved).length;
  const onSolved = tasks.filter((t) => armOf(t, 'on')?.resolved).length;
  const offRate = (offSolved / n) * 100;
  const onRate = (onSolved / n) * 100;

  // iterations-to-converge, measured only over each arm's resolved tasks.
  const offIters = mean(
    tasks.filter((t) => armOf(t, 'off')?.resolved).map((t) => armOf(t, 'off')!.iterations),
  );
  const onIters = mean(
    tasks.filter((t) => armOf(t, 'on')?.resolved).map((t) => armOf(t, 'on')!.iterations),
  );

  const offTok = tasks.reduce((a, t) => a + tokens(armOf(t, 'off')), 0);
  const onTok = tasks.reduce((a, t) => a + tokens(armOf(t, 'on')), 0);

  console.log('\n' + '─'.repeat(header.length));
  console.log(
    `resolve-rate   OFF ${fmt(offRate, 0)}% (${offSolved}/${n})   ` +
      `ON ${fmt(onRate, 0)}% (${onSolved}/${n})`,
  );
  console.log(
    `mean iters*    OFF ${fmt(offIters)}            ON ${fmt(onIters)}`,
  );
  console.log(
    `total tokens   OFF ${offTok.toLocaleString('en-US')}          ` +
      `ON ${onTok.toLocaleString('en-US')}`,
  );
  console.log('  * over tasks that arm resolved\n');

  const sign = (x: number, d = 1, unit = '') =>
    `${x >= 0 ? '+' : ''}${x.toFixed(d)}${unit}`;
  const iterDelta =
    offIters != null && onIters != null ? onIters - offIters : null;
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
