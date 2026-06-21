/**
 * The runner assembles a `JobContext` and executes a root `Job` (a loop, a dag,
 * or any job). It owns the engine registry, the abort controller, the shared
 * state, and the stats collector. Reporters/TUI observe via `onEvent`.
 */

import type { Engine, EngineName, EngineOptions, EngineRef } from '../engines/engine.ts';
import { EngineRegistry, type EngineFactory } from '../engines/registry.ts';
import { Stats, type StatsSnapshot } from '../core/stats.ts';
import { LoopError } from '../core/errors.ts';
import type { Job, JobContext, LoopEvent, Outcome } from '../core/types.ts';

export interface RunOptions {
  /** Default engine selected when a job/condition names none. Default agent-sdk. */
  engine?: EngineName;
  engineOptions?: EngineOptions;
  /** Register custom engines (drop-in): name → factory or ready-made instance. */
  engines?: Record<string, EngineFactory | Engine>;
  /** External abort signal (the CLI wires SIGINT + keypress here). */
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void;
  /** Seed the shared, mutable run state. */
  state?: Record<string, unknown>;
}

export interface RunResult {
  outcome: Outcome;
  stats: StatsSnapshot;
}

export async function run(job: Job, options: RunOptions = {}): Promise<RunResult> {
  const registry = new EngineRegistry(options.engineOptions ?? {});
  for (const [name, value] of Object.entries(options.engines ?? {})) {
    registry.register(name, typeof value === 'function' ? value : () => value);
  }
  const defaultEngine = options.engine ?? 'agent-sdk';

  const stats = new Stats();
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const emit = (event: LoopEvent) => {
    stats.record(event);
    options.onEvent?.(event);
  };
  const resolveEngine = (ref?: EngineRef): Engine => registry.create(ref, defaultEngine);

  const rootCtx: JobContext = {
    engine: resolveEngine(defaultEngine),
    resolveEngine,
    signal: controller.signal,
    emit,
    state: options.state ?? {},
    iteration: 0,
    depth: 0,
    path: [],
    log: (message, level = 'info') => emit({ kind: 'log', ts: Date.now(), path: [], level, message }),
  };

  let outcome: Outcome;
  try {
    outcome = await job(rootCtx);
  } catch (e) {
    const error = LoopError.from(e, { code: 'UNKNOWN' });
    emit({ kind: 'error', ts: Date.now(), path: [], message: error.message, code: error.code });
    outcome = { status: 'fail', summary: error.message, error };
  }

  return { outcome, stats: stats.snapshot() };
}

/** Process exit code mapped from a terminal outcome. */
export function exitCodeFor(outcome: Outcome): number {
  switch (outcome.status) {
    case 'pass':
      return 0;
    case 'fail':
      return 1;
    case 'exhausted':
      return 2;
    case 'aborted':
      return 130;
  }
}
