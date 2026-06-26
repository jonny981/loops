/**
 * The runner assembles a `JobContext` and executes a root `Job` (a loop, a dag,
 * or any job). It owns the engine registry, the abort controller, the shared
 * state, and the stats collector. Reporters/TUI observe via `onEvent`.
 */

import type {
  Engine,
  EngineName,
  EngineOptions,
  EngineRef,
} from '../engines/engine.ts';
import { EngineRegistry, type EngineFactory } from '../engines/registry.ts';
import { Stats, type StatsSnapshot } from '../core/stats.ts';
import { LoopError } from '../core/errors.ts';
import { Budget, type BudgetConfig } from '../core/budget.ts';
import {
  makeRecorder,
  makeCheckpointer,
  loadCheckpoint,
  flushCheckpoint,
} from './persist.ts';
import { startSupervisor, newRunId, type Supervisor } from './supervisor.ts';
import { jobMeta } from '../core/describe.ts';
import { currentBranch } from '../core/git.ts';
import type { Environment, EnvHandle } from '../env/environment.ts';
import type { Forge } from '../core/forge.ts';
import type {
  Job,
  JobContext,
  LimitPolicy,
  LoopEvent,
  Outcome,
  Workspace,
} from '../core/types.ts';

/** Default ceiling on an interruptible limit-wait: 5 minutes. */
const DEFAULT_MAX_WAIT_MS = 300_000;

/**
 * Exit code for a `paused` run: EX_TEMPFAIL (sysexits.h). Distinct from `fail`
 * (1) so a wrapper/cron can tell "paused, resumable" from "failed".
 */
export const EXIT_PAUSED = 75;

export interface RunOptions {
  /** Default engine selected when a job/condition names none. Default agent-sdk. */
  engine?: EngineName;
  engineOptions?: EngineOptions;
  /** Register custom engines (drop-in): name → factory or ready-made instance. */
  engines?: Record<string, EngineFactory | Engine>;
  /** External abort signal (the CLI wires SIGINT + keypress here). */
  signal?: AbortSignal;
  /** Root working directory the run operates in. Default: process.cwd(). */
  cwd?: string;
  /**
   * Bring an environment up for the run (the root workspace) before the job, and
   * tear it down after — so the gate can test the running thing. The adapter
   * (sst, Vercel, …) is yours; loops owns only the seam. Per-team environments
   * at the worktree boundary are a separate, later binding.
   */
  environment?: Environment;
  /**
   * The PR host for `pushJob`/`pullRequestJob`/`mergeJob`. Default: `GhForge`
   * (the `gh` CLI) when a job needs one. Pass a `MockForge` to run offline.
   */
  forge?: Forge;
  onEvent?: (event: LoopEvent) => void;
  /** Seed the shared, mutable run state. */
  state?: Record<string, unknown>;
  /**
   * Cap total tokens (input + output) for the run. A bare number is the limit;
   * pass `{ limit, headroom?, soft? }` for headroom or warn-don't-refuse mode.
   * Engine call sites refuse to spend past it (see `Budget`).
   */
  budget?: number | BudgetConfig;
  /** Append every structured event as JSONL here — a readable run record. */
  recordTo?: string;
  /** Snapshot the shared run state here at each loop/dag/job boundary. */
  checkpoint?: string;
  /**
   * Register this run in the global registry (`~/.loops/runs/<runId>`) and write
   * its live state there, so another process can `loops list` / `status` / `tail`
   * it. Off by default — opt in to make a run observable from outside.
   */
  supervise?: boolean;
  /** Restore shared run state written by a prior `checkpoint` before starting. */
  resumeFrom?: string;
  /**
   * How a loop reacts to a rate limit / quota / token budget. Default `auto`:
   * wait out a known reset within `maxWaitMs`, else checkpoint and exit with a
   * resume command (the `paused` status, exit code 75). `wait` waits any known
   * reset with no ceiling; `exit-resume` never waits; `fail` is the old fatal
   * behaviour.
   */
  onLimit?: LimitPolicy;
  /** Ceiling on a single interruptible limit-wait, in ms. Default 300000. */
  maxWaitMs?: number;
  /**
   * Ready-to-paste command to resume a paused run, surfaced to reporters and the
   * `limit:pause` event. The CLI reconstructs this from the invocation.
   */
  resumeCommand?: string;
}

export interface RunResult {
  outcome: Outcome;
  stats: StatsSnapshot;
  /** Final token accounting, when a budget was set. */
  budget?: { limit: number; spent: number; remaining: number };
  /** The registry id, when the run was supervised. */
  runId?: string;
}

export async function run(
  job: Job,
  options: RunOptions = {},
): Promise<RunResult> {
  const registry = new EngineRegistry(options.engineOptions ?? {});
  for (const [name, value] of Object.entries(options.engines ?? {})) {
    registry.register(name, typeof value === 'function' ? value : () => value);
  }
  const defaultEngine = options.engine ?? 'agent-sdk';

  const stats = new Stats();
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else
      options.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
  }

  const budget =
    options.budget != null
      ? new Budget(
          typeof options.budget === 'number'
            ? { limit: options.budget }
            : options.budget,
        )
      : undefined;

  // Resume restores the shared scratchpad a prior checkpoint wrote; an explicit
  // `state` seed wins over the restored values.
  let initialState: Record<string, unknown> = options.state ?? {};
  if (options.resumeFrom) {
    try {
      initialState = { ...loadCheckpoint(options.resumeFrom), ...initialState };
    } catch (e) {
      throw new LoopError({
        code: 'CONFIG',
        message: `cannot resume from "${options.resumeFrom}": ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Persistence sinks observe the same event stream as reporters. The
  // checkpointer closes over `initialState`, which is `rootCtx.state` — so it
  // always snapshots the live, mutated scratchpad.
  const dir = options.cwd ?? process.cwd();
  const sinks: Array<(event: LoopEvent) => void> = [];
  if (options.recordTo) sinks.push(makeRecorder(options.recordTo));
  if (options.checkpoint)
    sinks.push(makeCheckpointer(options.checkpoint, initialState));

  // A supervised run registers itself in the global registry (~/.loops/runs) and
  // writes its live state there, so another process can list/status/tail it.
  let supervisor: Supervisor | undefined;
  if (options.supervise) {
    const shape = jobMeta(job);
    const title = shape?.name ?? 'run';
    supervisor = startSupervisor({
      runId: newRunId(title),
      cwd: dir,
      title,
      shape,
    });
    sinks.push(supervisor.sink);
  }

  const emit = (event: LoopEvent) => {
    stats.record(event);
    if (budget && event.kind === 'engine:usage')
      budget.add(event.usage.inputTokens + event.usage.outputTokens);
    options.onEvent?.(event);
    for (const sink of sinks) sink(event);
  };
  const resolveEngine = (ref?: EngineRef): Engine =>
    registry.create(ref, defaultEngine);

  // The root workspace is the substrate the whole run reads and writes. Branch
  // resolution is best-effort: a non-git cwd just leaves `branch` undefined.
  const workspace: Workspace = {
    dir,
    branch: await currentBranch({ cwd: dir, signal: controller.signal }),
  };

  // Bring the environment up for the run before the job, so the gate can test
  // the running thing. A failed start fails the run cleanly rather than throwing.
  let environment: EnvHandle | undefined;
  if (options.environment) {
    try {
      environment = await options.environment.up(workspace, controller.signal);
    } catch (e) {
      const error = LoopError.from(e, { code: 'CONFIG' });
      emit({
        kind: 'error',
        ts: Date.now(),
        path: [],
        message: `environment "${options.environment.name}" failed to start: ${error.message}`,
        code: error.code,
      });
      const failOutcome: Outcome = {
        status: 'fail',
        summary: `environment failed to start: ${error.message}`,
        error,
      };
      supervisor?.finish(failOutcome);
      return {
        outcome: failOutcome,
        stats: stats.snapshot(),
        budget: budget
          ? {
              limit: budget.limit,
              spent: budget.spent(),
              remaining: budget.remaining(),
            }
          : undefined,
        runId: supervisor?.runId,
      };
    }
  }

  const rootCtx: JobContext = {
    engine: resolveEngine(defaultEngine),
    resolveEngine,
    signal: controller.signal,
    emit,
    state: initialState,
    workspace,
    environment,
    forge: options.forge,
    budget,
    onLimit: options.onLimit ?? 'auto',
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    resumeCommand: options.resumeCommand,
    iteration: 0,
    depth: 0,
    path: [],
    log: (message, level = 'info') =>
      emit({ kind: 'log', ts: Date.now(), path: [], level, message }),
  };

  let outcome: Outcome;
  try {
    outcome = await job(rootCtx);
  } catch (e) {
    const error = LoopError.from(e, { code: 'UNKNOWN' });
    emit({
      kind: 'error',
      ts: Date.now(),
      path: [],
      message: error.message,
      code: error.code,
    });
    outcome = { status: 'fail', summary: error.message, error };
  } finally {
    // Tear the environment down whatever happened (best-effort).
    if (environment) await environment.down(controller.signal).catch(() => {});
  }

  // A paused run is meant to be resumed; guarantee the latest shared state is on
  // disk even if no boundary event flushed it (the checkpointer is best-effort).
  if (outcome.status === 'paused' && options.checkpoint)
    flushCheckpoint(options.checkpoint, initialState);

  supervisor?.finish(outcome);

  return {
    outcome,
    stats: stats.snapshot(),
    budget: budget
      ? {
          limit: budget.limit,
          spent: budget.spent(),
          remaining: budget.remaining(),
        }
      : undefined,
    runId: supervisor?.runId,
  };
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
    case 'paused':
      return EXIT_PAUSED;
  }
}
