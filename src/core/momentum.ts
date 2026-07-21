/**
 * Momentum — the quantity that says whether a run is alive (docs/momentum.md).
 *
 * Momentum is the rate at which gated work crystallizes from the frontier into
 * the immutable past — never activity. A unit of momentum is a completion that
 * survived its gate: a dag node landing `pass` (fresh work, not a checkpoint
 * restore, not a skipped `when`), or a loop converging `pass`. It cannot be
 * faked, because every counted unit is an auditable event welded to real work.
 *
 * The fold induces the state taxonomy:
 *   - `alive`   — work crystallized within the observation window
 *   - `idle`    — activity or quiet with nothing crystallizing: legitimate
 *                 potential energy (a Tend loop watching the world)
 *   - `stalled` — the pathological case: the noProgress detector tripped after
 *                 the last crystallization — motion without momentum
 *   - `done`    — the run reached a terminal status; nothing more is coming
 *                 without a steer
 */

import type { LoopEvent } from './types.ts';

export type MomentumState = 'alive' | 'idle' | 'stalled' | 'done';

export interface MomentumReport {
  state: MomentumState;
  /** Gate-accepted completions: fresh passing dag nodes + converged loops. */
  crystallized: number;
  /** Accepted steering edits — force applied to the plan. */
  steers: number;
  /** noProgress trips observed. */
  stalls: number;
  /** Epoch ms of the most recent crystallization, when any occurred. */
  lastCrystallizedAt?: number;
  /** Crystallizations per hour over the observed span (>= 2 units required). */
  ratePerHour?: number;
}

export interface MomentumOptions {
  /**
   * The run's stored disposition (`RunStatus.status`): any terminal status
   * maps to `done`. Omit (or pass 'running') for a live run.
   */
  status?: string;
  /** "Now" for windowing; defaults to the newest event's timestamp. */
  now?: number;
  /** How recent a crystallization must be to count as `alive`. Default 10 min. */
  aliveWindowMs?: number;
}

const DEFAULT_ALIVE_WINDOW_MS = 10 * 60_000;

/**
 * Fold an event stream (or a tail of one) into a momentum report. Pure and
 * windowed: on a long run, feed it the tail and the report describes that
 * window, which is exactly what a supervision read wants.
 */
export function momentumFromEvents(
  events: readonly LoopEvent[],
  options: MomentumOptions = {},
): MomentumReport {
  let crystallized = 0;
  let steers = 0;
  let stalls = 0;
  let lastCrystallizedAt: number | undefined;
  let firstCrystallizedAt: number | undefined;
  let lastStallAt: number | undefined;
  let newestTs: number | undefined;

  for (const event of events) {
    if (newestTs === undefined || event.ts > newestTs) newestTs = event.ts;
    switch (event.kind) {
      case 'dag:node':
        if (
          event.phase === 'done' &&
          event.outcome?.status === 'pass' &&
          !event.cached
        ) {
          crystallized += 1;
          firstCrystallizedAt ??= event.ts;
          lastCrystallizedAt = event.ts;
        }
        break;
      case 'loop:end':
        if (event.outcome.status === 'pass') {
          crystallized += 1;
          firstCrystallizedAt ??= event.ts;
          lastCrystallizedAt = event.ts;
        }
        break;
      case 'dag:edit':
        if (event.accepted) steers += 1;
        break;
      case 'loop:stall':
        stalls += 1;
        lastStallAt = event.ts;
        break;
    }
  }

  const now = options.now ?? newestTs ?? Date.now();
  // A rate needs a meaningful span: extrapolating seconds of burst to an
  // hourly figure is noise, not momentum. Below a minute, report the count
  // and no rate — never a fabricated number.
  const MIN_RATE_SPAN_MS = 60_000;
  const spanMs =
    crystallized >= 2 &&
    lastCrystallizedAt! - firstCrystallizedAt! >= MIN_RATE_SPAN_MS
      ? lastCrystallizedAt! - firstCrystallizedAt!
      : undefined;
  const ratePerHour =
    spanMs !== undefined
      ? ((crystallized - 1) / spanMs) * 3_600_000
      : undefined;

  let state: MomentumState;
  if (options.status && options.status !== 'running') {
    state = 'done';
  } else if (
    lastStallAt !== undefined &&
    (lastCrystallizedAt === undefined || lastStallAt > lastCrystallizedAt)
  ) {
    state = 'stalled';
  } else if (
    lastCrystallizedAt !== undefined &&
    now - lastCrystallizedAt <=
      (options.aliveWindowMs ?? DEFAULT_ALIVE_WINDOW_MS)
  ) {
    state = 'alive';
  } else {
    state = 'idle';
  }

  return {
    state,
    crystallized,
    steers,
    stalls,
    lastCrystallizedAt,
    ratePerHour,
  };
}

/** One supervision line: `alive — 5 crystallized (2.4/h), 2 steers`. */
export function momentumLine(report: MomentumReport): string {
  const parts = [
    `${report.crystallized} crystallized${
      report.ratePerHour !== undefined
        ? ` (${report.ratePerHour.toFixed(1)}/h)`
        : ''
    }`,
  ];
  if (report.steers) parts.push(`${report.steers} steer${report.steers === 1 ? '' : 's'}`);
  if (report.stalls) parts.push(`${report.stalls} stall${report.stalls === 1 ? '' : 's'}`);
  return `${report.state} — ${parts.join(', ')}`;
}
