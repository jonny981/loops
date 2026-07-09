/**
 * Cost accounting over the run's measured token usage — the honest-receipt
 * fold. Two rules carried over from auditing supervisor-orchestrator ledgers:
 *
 * 1. **Never silently $0.** A model with usage but no price entry lands in
 *    `unpricedModels`, and the totals stay `undefined` rather than pretending
 *    the run was free.
 * 2. **The baseline is labeled a reconstruction.** `baselineUsd` prices the
 *    SAME measured token stream at the baseline model's rates — "what these
 *    exact tokens would have cost on the ceiling model". It is a like-for-like
 *    counterfactual, not a measured alternative run, and consumers should say
 *    so when they print it.
 *
 * Prices are supplied by the caller (a JSON file via `--prices`, or a table
 * in code). The library ships none: hardcoded prices go stale, and a wrong
 * price is worse than no price.
 */

import type { StatsSnapshot } from './stats.ts';

export interface ModelPrice {
  /** Dollars per million input tokens. */
  inputPerMTokUsd: number;
  /** Dollars per million output tokens. */
  outputPerMTokUsd: number;
}

/** Model id → price. Keys match exactly first, then by longest prefix, so
 *  `"claude-sonnet-5"` covers dated ids like `claude-sonnet-5-20250929`. */
export type PriceTable = Record<string, ModelPrice>;

export interface ModelCost {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined when the table carries no price for this model. */
  usd?: number;
}

export interface CostReport {
  /** Measured usage priced at each model's own rate; undefined if ANY used
   *  model is unpriced (a partial total masquerading as a total is a lie). */
  spentUsd?: number;
  /** The same token stream repriced at the baseline model — a reconstruction. */
  baselineModel?: string;
  baselineUsd?: number;
  /** `baselineUsd - spentUsd` when both exist. Negative means the run cost
   *  MORE than the baseline would have. */
  savedUsd?: number;
  /** Models that carried usage but had no price entry. */
  unpricedModels: string[];
  models: ModelCost[];
}

/** Exact key first, then the longest prefix whose next char is a boundary. */
export function priceFor(
  table: PriceTable,
  model: string,
): ModelPrice | undefined {
  if (table[model]) return table[model];
  let best: { key: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table)) {
    if (!model.startsWith(key)) continue;
    const boundary = model.charAt(key.length);
    if (boundary !== '' && boundary !== '-' && boundary !== ':' && boundary !== '.')
      continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price;
}

function usdFor(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * price.inputPerMTokUsd +
      outputTokens * price.outputPerMTokUsd) /
    1_000_000
  );
}

function round(usd: number): number {
  return Number(usd.toFixed(6));
}

export function costReport(
  snapshot: Pick<StatsSnapshot, 'models'>,
  prices: PriceTable,
  baselineModel?: string,
): CostReport {
  const models: ModelCost[] = [];
  const unpriced: string[] = [];
  let spent = 0;
  let allPriced = true;
  for (const m of snapshot.models) {
    const price = priceFor(prices, m.model);
    const usd = price ? round(usdFor(price, m.inputTokens, m.outputTokens)) : undefined;
    if (usd === undefined) {
      allPriced = false;
      unpriced.push(m.model);
    } else {
      spent += usd;
    }
    models.push({
      model: m.model,
      calls: m.calls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      usd,
    });
  }

  let baselineUsd: number | undefined;
  if (baselineModel && snapshot.models.length) {
    const baselinePrice = priceFor(prices, baselineModel);
    if (baselinePrice) {
      baselineUsd = round(
        snapshot.models.reduce(
          (sum, m) => sum + usdFor(baselinePrice, m.inputTokens, m.outputTokens),
          0,
        ),
      );
    }
  }
  const spentUsd = allPriced && models.length ? round(spent) : undefined;
  return {
    spentUsd,
    baselineModel,
    baselineUsd,
    savedUsd:
      spentUsd !== undefined && baselineUsd !== undefined
        ? round(baselineUsd - spentUsd)
        : undefined,
    unpricedModels: unpriced,
    models,
  };
}

/** A compact receipt for the exit summary. States what is measured and what
 *  is reconstructed; names unpriced models instead of zeroing them. */
export function formatCostReport(report: CostReport): string[] {
  const lines: string[] = [];
  for (const m of report.models) {
    lines.push(
      `${m.model}: ${m.inputTokens}/${m.outputTokens} tok over ${m.calls} call(s)${m.usd !== undefined ? ` = $${m.usd}` : ' (unpriced)'}`,
    );
  }
  if (report.spentUsd !== undefined) {
    lines.push(`spent (measured): $${report.spentUsd}`);
  }
  if (report.unpricedModels.length) {
    lines.push(
      `no total: unpriced model(s) ${report.unpricedModels.join(', ')} — add them to the price table`,
    );
  }
  if (report.baselineUsd !== undefined) {
    lines.push(
      `baseline (reconstructed, same tokens on ${report.baselineModel}): $${report.baselineUsd}`,
    );
    if (report.savedUsd !== undefined) {
      lines.push(
        report.savedUsd >= 0
          ? `saved vs baseline: $${report.savedUsd}`
          : `over baseline: $${Math.abs(report.savedUsd)}`,
      );
    }
  }
  return lines;
}
