/**
 * Fold a loops SWE-bench run (bench/swebench.ts output) into a table directly
 * comparable to the external reference study — same 135-instance slice,
 * same official grader, same cost semantics (measured dollars from real token
 * usage, plus the labeled reconstructed baseline).
 *
 * The yardstick constants below were extracted from the reference study's COMMITTED
 * artifacts (preds JSONL, grade JSONs, swe_lite_ledger.sqlite), not its README
 * — the README's headline ("47% cheaper at equal quality") does not match the
 * artifacts; these numbers do.
 *
 *   npx tsx bench/yardstick/report.ts \
 *     --ledger  <out>/ledger.jsonl \
 *     --grades  <official run_evaluation report json> \
 *     --prices  prices.json --baseline-model <ceiling-model> [--arm on]
 */

import { readFileSync } from 'node:fs';

import {
  costReport,
  type CostReport,
  type PriceTable,
} from '../../src/api.ts';

/** The reference study's results on the frozen slice, verified from its artifacts. */
export const YARDSTICK = {
  source:
    'github.com/professorpalmer/swebench-pm — committed preds + grade JSONs + swe_lite_ledger.sqlite (verified 2026-07-09)',
  dataset: 'princeton-nlp/SWE-bench_Lite (test split), official harness grading',
  slice: {
    n: 135,
    composition:
      'django 114 (84%), astropy 6, matplotlib 5, sympy 5, others 5 — an easy-skewed slice vs the full Lite-300 (38% django)',
  },
  ceilingModel: 'gpt-5.5 (per registry_frontier.json; temperature 1.0, single seed)',
  arms: [
    {
      arm: 'A — frontier baseline (every turn on the ceiling model)',
      resolved: 98,
      measuredUsd: 27.51,
      reconstructedBaselineUsd: 27.51,
      turns: 1756,
      inputTokens: 20_243_026,
      outputTokens: 220_638,
    },
    {
      arm: 'B — A + CodeGraph context + cost router',
      resolved: 80,
      measuredUsd: 17.44,
      reconstructedBaselineUsd: 32.66,
      turns: 1938,
      inputTokens: 23_654_615,
      outputTokens: 309_642,
    },
    {
      arm: 'C — B + durable retries (3 attempts, non-empty-diff acceptance)',
      resolved: 90,
      measuredUsd: 19.45,
      reconstructedBaselineUsd: 37.13,
      turns: 2110,
      inputTokens: 27_001_806,
      outputTokens: 337_695,
    },
  ],
} as const;

interface LedgerRow {
  instance_id: string;
  arm: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  models?: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  elapsedMs: number;
  emptyPatch: boolean;
}

export interface LoopsArmSummary {
  arm: string;
  instances: number;
  emptyPatches: number;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  cost?: CostReport;
  resolved?: number;
}

export function foldLedger(
  jsonl: string,
  arm: string,
  prices?: PriceTable,
  baselineModel?: string,
): LoopsArmSummary {
  const rows = jsonl
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerRow)
    .filter((r) => r.arm === arm);
  const models = new Map<
    string,
    { model: string; calls: number; inputTokens: number; outputTokens: number }
  >();
  for (const row of rows) {
    for (const [model, usage] of Object.entries(row.models ?? {})) {
      const agg = models.get(model) ?? {
        model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      agg.calls += usage.calls;
      agg.inputTokens += usage.inputTokens;
      agg.outputTokens += usage.outputTokens;
      models.set(model, agg);
    }
  }
  return {
    arm,
    instances: rows.length,
    emptyPatches: rows.filter((r) => r.emptyPatch).length,
    inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
    elapsedMs: rows.reduce((s, r) => s + r.elapsedMs, 0),
    cost: prices
      ? costReport({ models: [...models.values()] }, prices, baselineModel)
      : undefined,
  };
}

/** Read the resolved count out of an official harness report (either shape). */
export function resolvedFrom(gradeJson: unknown): number | undefined {
  const g = gradeJson as {
    resolved_instances?: number;
    resolved_ids?: string[];
  };
  if (typeof g.resolved_instances === 'number') return g.resolved_instances;
  if (Array.isArray(g.resolved_ids)) return g.resolved_ids.length;
  return undefined;
}

export function renderComparison(loops: LoopsArmSummary): string {
  const lines: string[] = [];
  const pct = (n: number | undefined, d: number) =>
    n === undefined ? '?' : `${n}/${d} = ${((n / d) * 100).toFixed(1)}%`;
  lines.push(
    `# yardstick — loops vs the reference study on the same ${YARDSTICK.slice.n}-instance slice`,
    '',
    `Slice: ${YARDSTICK.slice.composition}`,
    `Grading: ${YARDSTICK.dataset}`,
    '',
    '## Yardstick (the reference study, verified from its committed artifacts)',
    '',
  );
  for (const a of YARDSTICK.arms) {
    lines.push(
      `- ${a.arm}: resolved ${pct(a.resolved, YARDSTICK.slice.n)}, measured $${a.measuredUsd} ` +
        `(reconstructed frontier baseline $${a.reconstructedBaselineUsd}), ` +
        `${a.turns} turns, ${a.inputTokens}/${a.outputTokens} tok — ceiling ${YARDSTICK.ceilingModel}`,
    );
  }
  lines.push(
    '',
    '## This loops run',
    '',
    `- arm "${loops.arm}": ${loops.instances} instance(s), ${loops.emptyPatches} empty patch(es), ` +
      `resolved ${pct(loops.resolved, loops.instances)}, ` +
      `${loops.inputTokens}/${loops.outputTokens} tok, ${(loops.elapsedMs / 3.6e6).toFixed(1)}h agent time`,
  );
  if (loops.cost) {
    if (loops.cost.spentUsd !== undefined)
      lines.push(`- spent (measured): $${loops.cost.spentUsd}`);
    if (loops.cost.unpricedModels.length)
      lines.push(
        `- NO TOTAL: unpriced model(s) ${loops.cost.unpricedModels.join(', ')}`,
      );
    if (loops.cost.baselineUsd !== undefined)
      lines.push(
        `- baseline (reconstructed, same tokens on ${loops.cost.baselineModel}): $${loops.cost.baselineUsd}` +
          (loops.cost.savedUsd !== undefined
            ? ` — ${loops.cost.savedUsd >= 0 ? 'saved' : 'over by'} $${Math.abs(loops.cost.savedUsd)}`
            : ''),
      );
  }
  lines.push(
    '',
    '## Read the comparison honestly',
    '',
    '- Same instances, same grader: resolve rates ARE comparable on this slice.',
    '- The slice is 84% django (easy-skewed): rates here overstate full Lite-300 rates for BOTH systems. Comparable to each other, not to leaderboards.',
    '- Dollars are comparable only as (measured vs measured) or (reconstructed vs reconstructed) — never across the two. the reference study's arm A is its only fully-measured frontier arm.',
    '- Model ceilings differ (theirs: gpt-5.5) unless you pinned the same family; report your ceiling next to theirs.',
    '- Both studies are single-seed at high temperature: differences inside a few points are noise.',
    '- loops attempts are gated without ever seeing FAIL_TO_PASS (same discipline as the reference generation).',
  );
  return lines.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const ledgerPath = arg('ledger');
  if (!ledgerPath) {
    console.error(
      'usage: report.ts --ledger <ledger.jsonl> [--grades <report.json>] [--prices <prices.json>] [--baseline-model <id>] [--arm on|off]',
    );
    process.exit(1);
  }
  const prices = arg('prices')
    ? (JSON.parse(readFileSync(arg('prices')!, 'utf8')) as PriceTable)
    : undefined;
  const summary = foldLedger(
    readFileSync(ledgerPath, 'utf8'),
    arg('arm') ?? 'on',
    prices,
    arg('baseline-model'),
  );
  if (arg('grades')) {
    summary.resolved = resolvedFrom(
      JSON.parse(readFileSync(arg('grades')!, 'utf8')),
    );
  }
  console.log(renderComparison(summary));
}

// Run as a script; stay silent when imported (the fold is unit-tested).
if (process.argv[1]?.endsWith('report.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
