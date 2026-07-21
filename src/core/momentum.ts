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
 * The incremental fold behind every momentum read: feed it events as they
 * happen (a live listener) or in a batch (`momentumFromEvents`), ask for a
 * report at any time. One implementation, so a webhook consumer polling
 * `GET /momentum` and a `loops status` read can never disagree on what
 * momentum means.
 */
export class MomentumTracker {
  #crystallized = 0;
  #steers = 0;
  #stalls = 0;
  #firstCrystallizedAt: number | undefined;
  #lastCrystallizedAt: number | undefined;
  #lastStallAt: number | undefined;
  #newestTs: number | undefined;

  record(event: LoopEvent): void {
    if (this.#newestTs === undefined || event.ts > this.#newestTs)
      this.#newestTs = event.ts;
    switch (event.kind) {
      case 'dag:node':
        if (
          event.phase === 'done' &&
          event.outcome?.status === 'pass' &&
          !event.cached
        )
          this.#crystallize(event.ts);
        break;
      case 'loop:end':
        if (event.outcome.status === 'pass') this.#crystallize(event.ts);
        break;
      case 'dag:edit':
        if (event.accepted) this.#steers += 1;
        break;
      case 'loop:stall':
        this.#stalls += 1;
        this.#lastStallAt = event.ts;
        break;
    }
  }

  #crystallize(ts: number): void {
    this.#crystallized += 1;
    this.#firstCrystallizedAt ??= ts;
    this.#lastCrystallizedAt = ts;
  }

  report(options: MomentumOptions = {}): MomentumReport {
    const now = options.now ?? this.#newestTs ?? Date.now();
    // A rate needs a meaningful span: extrapolating seconds of burst to an
    // hourly figure is noise, not momentum. Below a minute, report the count
    // and no rate — never a fabricated number.
    const MIN_RATE_SPAN_MS = 60_000;
    const spanMs =
      this.#crystallized >= 2 &&
      this.#lastCrystallizedAt! - this.#firstCrystallizedAt! >=
        MIN_RATE_SPAN_MS
        ? this.#lastCrystallizedAt! - this.#firstCrystallizedAt!
        : undefined;
    const ratePerHour =
      spanMs !== undefined
        ? ((this.#crystallized - 1) / spanMs) * 3_600_000
        : undefined;

    let state: MomentumState;
    if (options.status && options.status !== 'running') {
      state = 'done';
    } else if (
      this.#lastStallAt !== undefined &&
      (this.#lastCrystallizedAt === undefined ||
        this.#lastStallAt > this.#lastCrystallizedAt)
    ) {
      state = 'stalled';
    } else if (
      this.#lastCrystallizedAt !== undefined &&
      now - this.#lastCrystallizedAt <=
        (options.aliveWindowMs ?? DEFAULT_ALIVE_WINDOW_MS)
    ) {
      state = 'alive';
    } else {
      state = 'idle';
    }

    return {
      state,
      crystallized: this.#crystallized,
      steers: this.#steers,
      stalls: this.#stalls,
      lastCrystallizedAt: this.#lastCrystallizedAt,
      ratePerHour,
    };
  }
}

/**
 * Fold an event stream (or a tail of one) into a momentum report. Pure and
 * windowed: on a long run, feed it the tail and the report describes that
 * window, which is exactly what a supervision read wants.
 */
export function momentumFromEvents(
  events: readonly LoopEvent[],
  options: MomentumOptions = {},
): MomentumReport {
  const tracker = new MomentumTracker();
  for (const event of events) tracker.record(event);
  return tracker.report(options);
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
