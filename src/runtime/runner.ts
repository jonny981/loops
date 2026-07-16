/**
 * The runner assembles a `JobContext` and executes a root `Job` (a loop, a dag,
 * or any job). It owns the engine registry, the abort controller, the shared
 * state, and the stats collector. Reporters/TUI observe via `onEvent`.
 */

import { join } from 'node:path';

import type {
  Engine,
  EngineName,
  EngineOptions,
  EngineRef,
} from '../engines/engine.ts';
import { EngineRegistry, type EngineFactory } from '../engines/registry.ts';
import { Stats, type StatsSnapshot } from '../core/stats.ts';
import { costReport, type CostReport, type PriceTable } from '../core/cost.ts';
import { LoopError } from '../core/errors.ts';
import { Budget, type BudgetConfig } from '../core/budget.ts';
import {
  makeRecorder,
  makeCheckpointer,
  loadCheckpointEnvelope,
  flushCheckpoint,
  type CheckpointDiagnostics,
} from './persist.ts';
import { startSupervisor, newRunId, type Supervisor } from './supervisor.ts';
import { jobMeta } from '../core/describe.ts';
import { currentBranch, workspaceFingerprint } from '../core/git.ts';
import type { GroundConfig } from '../core/job.ts';
import {
  assertSafeScratchPath,
  ensureScratchSubdir,
  resetLedger,
  resetPrompt,
} from '../core/draft.ts';
import type { Environment, EnvHandle } from '../env/environment.ts';
import type { Forge } from '../core/forge.ts';
import type { RunParams } from '../core/params.ts';
import type {
  Job,
  JobContext,
  JobMeta,
  LimitPolicy,
  LoopEvent,
  Outcome,
  Workspace,
  CheckpointControl,
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
   * Bring an environment up for the run (the root workspace) before the job and
   * tear it down after, so the gate can test the running thing. The adapter
   * (sst, Vercel, …) is yours; loops owns only the interface. Per-team
   * environments at the worktree boundary are a separate, later binding.
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
  /** Values parsed from a recipe's declared run parameters. */
  params?: RunParams;
  /** Config surfaced to recipes. */
  config?: { recipe?: Record<string, unknown> };
  /** Clear `.loops/ledger.md` and `.loops/prompt.md` before a fresh run. */
  resetScratch?: boolean;
  /**
   * Default grounding for every `agentJob` in the run. A job's own `ground`
   * (including an explicit `false`) always wins.
   */
  ground?: boolean | GroundConfig;
  /**
   * Run-level kill switches for curated grounding, so the same recipe
   * benchmarks with and without: `curate: false` skips every curation turn,
   * `ladder: false` pins every laddered job to its default lane (rung 0).
   * Leave undefined to let the recipe decide.
   */
  curate?: boolean;
  ladder?: boolean;
  /**
   * Cap total tokens (input + output) for the run. A bare number is the limit;
   * pass `{ limit, headroom?, soft? }` for headroom or warn-don't-refuse mode.
   * Engine call sites refuse to spend past it (see `Budget`).
   */
  budget?: number | BudgetConfig;
  /** Append every structured event as JSONL here, or auto-name one under `.loops/records`. */
  recordTo?: string | 'auto';
  /** Snapshot the shared run state here at each loop/dag/job boundary. */
  checkpoint?: string;
  /**
   * Register this run in the global registry (`~/.loops/runs/<runId>`) and write
   * its live state there, so another process can `loops list` / `status` / `tail`
   * it. Off by default; opt in to make a run observable from outside.
   */
  supervise?: boolean;
  /**
   * Assign the registry id instead of generating one, so a dispatching tool
   * (the helm bridge, a wrapper script) knows the id before the run registers.
   * Must match the registry alphabet (`[a-z0-9][a-z0-9-]*`); only meaningful
   * with `supervise` or `recordTo: 'auto'`.
   */
  runId?: string;
  /** Restore shared run state written by a prior `checkpoint` before starting. */
  resumeFrom?: string;
  /**
   * Reuse checkpointed green DAG nodes when the checkpoint has a valid but
   * different workspace fingerprint. This is an explicit operator trust
   * decision; the default remains a fresh run for changed workspaces.
   */
  resumeTrustWorkspace?: boolean;
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
   * Price the run's measured token usage (`RunResult.cost`). Prices are
   * caller-supplied — the library hardcodes none. `baselineModel` adds the
   * reconstructed counterfactual: the same token stream at that model's rates.
   */
  cost?: { prices: PriceTable; baselineModel?: string };
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
  /** The JSONL event record path, when recording was enabled. */
  recordPath?: string;
  /** The priced receipt, when `RunOptions.cost` was set. */
  cost?: CostReport;
}

type RestoreEvent = Extract<LoopEvent, { kind: 'runtime:restore' }>;

function countCheckpointNodes(
  dags: CheckpointControl['resumeDags'] | undefined,
): number {
  return Object.values(dags ?? {}).reduce(
    (total, dag) => total + Object.keys(dag.nodes).length,
    0,
  );
}

function restorableCheckpointDags(
  dags: CheckpointControl['resumeDags'] | undefined,
  shape: JobMeta | undefined,
): CheckpointControl['resumeDags'] | undefined {
  if (!dags || !shape) return dags;
  const current = dagShapeKeys(shape);
  const filtered: NonNullable<CheckpointControl['resumeDags']> = {};
  for (const [key, dag] of Object.entries(dags)) {
    const nodes = current.get(key);
    if (!nodes) continue;
    const kept = Object.fromEntries(
      Object.entries(dag.nodes).filter(
        ([name, node]) =>
          nodes.has(name) &&
          node.phase === 'done' &&
          node.outcome?.status === 'pass',
      ),
    );
    if (Object.keys(kept).length) filtered[key] = { nodes: kept };
  }
  return filtered;
}

function dagShapeKeys(
  meta: JobMeta | undefined,
  path: string[] = [],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!meta) return out;
  if (meta.kind === 'loop' && typeof meta.name === 'string') {
    mergeDagShapeKeys(out, dagShapeKeys(meta.body as JobMeta | undefined, [...path, meta.name]));
    return out;
  }
  if (meta.kind === 'dag' && typeof meta.name === 'string') {
    const dagPath = [...path, meta.name];
    const nodes = ((meta.nodes as Array<{ name?: unknown; job?: JobMeta }> | undefined) ?? [])
      .filter((node): node is { name: string; job?: JobMeta } => typeof node.name === 'string');
    out.set(JSON.stringify(dagPath), new Set(nodes.map((node) => node.name)));
    for (const node of nodes) {
      mergeDagShapeKeys(out, dagShapeKeys(node.job, [...dagPath, node.name]));
    }
  }
  return out;
}

function mergeDagShapeKeys(
  target: Map<string, Set<string>>,
  source: Map<string, Set<string>>,
): void {
  for (const [key, nodes] of source) target.set(key, nodes);
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => path !== undefined))];
}

function withCheckpointDiagnostics(
  reason: string,
  diagnostics: CheckpointDiagnostics,
): string {
  if (diagnostics.skippedEntries === 0) return reason;
  const count = diagnostics.skippedEntries;
  const details = diagnostics.entries
    .map((entry) => `${entry.path}: ${entry.reason}`)
    .join('; ');
  const omitted = count - diagnostics.entries.length;
  return `${reason}; skipped ${count} malformed checkpoint ${count === 1 ? 'entry' : 'entries'}${details ? `: ${details}` : ''}${omitted > 0 ? `; ${omitted} more omitted` : ''}`;
}

export async function run(
  job: Job,
  options: RunOptions = {},
): Promise<RunResult> {
  const defaultEngine = options.engine ?? 'agent-sdk';
  const engineOptions: EngineOptions = {
    ...(options.engineOptions ?? {}),
    defaultEngine,
  };
  const registry = new EngineRegistry(engineOptions);
  for (const [name, value] of Object.entries(options.engines ?? {})) {
    registry.register(name, typeof value === 'function' ? value : () => value);
  }

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
  const dir = options.cwd ?? process.cwd();
  const shape = jobMeta(job);
  const title = shape?.name ?? 'run';
  const needsRunId = options.supervise || options.recordTo === 'auto';
  if (options.runId != null && !/^[a-z0-9][a-z0-9-]*$/.test(options.runId)) {
    throw new LoopError({
      code: 'CONFIG',
      message: `runId must match [a-z0-9][a-z0-9-]*, got "${options.runId}"`,
    });
  }
  const runId = needsRunId ? (options.runId ?? newRunId(title)) : undefined;
  if (options.resetScratch && !options.resumeFrom) {
    resetLedger({ dir });
    resetPrompt({ dir });
  }

  // Resume restores the shared scratchpad a prior checkpoint wrote; an explicit
  // `state` seed wins over the restored values.
  let initialState: Record<string, unknown> = options.state ?? {};
  let checkpointControl: CheckpointControl | undefined =
    options.checkpoint || options.resumeFrom ? { dags: {} } : undefined;
  let restoreEvent: RestoreEvent | undefined;
  if (options.resumeFrom) {
    try {
      assertSafeScratchPath({ dir }, options.resumeFrom);
      const checkpoint = loadCheckpointEnvelope(options.resumeFrom);
      initialState = { ...checkpoint.state, ...initialState };
      checkpointControl = checkpoint.control;
      const checkpointNodes = countCheckpointNodes(checkpointControl.resumeDags);
      const currentFingerprint = await workspaceFingerprint({
        cwd: dir,
        signal: controller.signal,
        excludePaths: uniquePaths([options.resumeFrom, options.checkpoint]),
      });
      const workspaceChanged =
        currentFingerprint !== undefined &&
        checkpoint.workspaceFingerprint !== undefined &&
        checkpoint.workspaceFingerprint !== currentFingerprint;
      if (!checkpoint.workspaceFingerprintValid) {
        checkpointControl.resumeDags = undefined;
        checkpointControl.dags = {};
        restoreEvent = {
          kind: 'runtime:restore',
          ts: Date.now(),
          path: [],
          checkpoint: options.resumeFrom,
          decision: 'skipped',
          restoredNodes: 0,
          totalNodes: checkpointNodes,
          reason: withCheckpointDiagnostics(
            `restoring nothing from ${options.resumeFrom}: checkpoint workspace fingerprint is invalid`,
            checkpoint.diagnostics,
          ),
          fingerprint: 'changed',
        };
      } else if (workspaceChanged && !options.resumeTrustWorkspace) {
        checkpointControl.resumeDags = undefined;
        checkpointControl.dags = {};
        restoreEvent = {
          kind: 'runtime:restore',
          ts: Date.now(),
          path: [],
          checkpoint: options.resumeFrom,
          decision: 'skipped',
          restoredNodes: 0,
          totalNodes: checkpointNodes,
          reason: withCheckpointDiagnostics(
            `restoring nothing from ${options.resumeFrom}: workspace fingerprint changed`,
            checkpoint.diagnostics,
          ),
          fingerprint: 'changed',
        };
      } else {
        checkpointControl.resumeDags = restorableCheckpointDags(
          checkpointControl.resumeDags,
          shape,
        );
        checkpointControl.dags = restorableCheckpointDags(
          checkpointControl.dags,
          shape,
        ) ?? {};
        const restoredNodes = countCheckpointNodes(checkpointControl.resumeDags);
        const totalNodes = checkpointNodes;
        const fingerprint =
          workspaceChanged
            ? 'changed'
            : checkpoint.workspaceFingerprint === undefined
              ? 'checkpoint-missing'
              : currentFingerprint === undefined
                ? 'workspace-unavailable'
                : 'matched';
        const restoreReason = workspaceChanged
          ? `restored ${restoredNodes}/${totalNodes} nodes from ${options.resumeFrom} after an explicitly trusted changed workspace`
          : `restored ${restoredNodes}/${totalNodes} nodes from ${options.resumeFrom}`;
        restoreEvent =
          restoredNodes > 0
            ? {
                kind: 'runtime:restore',
                ts: Date.now(),
                path: [],
                checkpoint: options.resumeFrom,
                decision: 'restored',
                restoredNodes,
                totalNodes,
                reason: withCheckpointDiagnostics(
                  restoreReason,
                  checkpoint.diagnostics,
                ),
                fingerprint,
              }
            : {
                kind: 'runtime:restore',
                ts: Date.now(),
                path: [],
                checkpoint: options.resumeFrom,
                decision: 'skipped',
                restoredNodes: 0,
                totalNodes,
                reason: withCheckpointDiagnostics(
                  `restoring nothing from ${options.resumeFrom}: no checkpointed DAG nodes match the current graph`,
                  checkpoint.diagnostics,
                ),
                fingerprint,
              };
      }
    } catch (e) {
      throw new LoopError({
        code: 'CONFIG',
        message: `cannot resume from "${options.resumeFrom}": ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Persistence sinks observe the same event stream as reporters. The
  // checkpointer closes over `initialState`, which is `rootCtx.state`, so it
  // always snapshots the live, mutated scratchpad.
  const sinks: Array<(event: LoopEvent) => void> = [];
  const recordPath =
    options.recordTo === 'auto'
      ? join(ensureScratchSubdir({ dir }, 'records'), `${runId!}.jsonl`)
      : options.recordTo;
  if (recordPath) {
    sinks.push(makeRecorder(recordPath, { thin: options.recordTo === 'auto' }));
  }
  if (options.checkpoint) {
    assertSafeScratchPath({ dir }, options.checkpoint);
    sinks.push(
      makeCheckpointer(options.checkpoint, initialState, checkpointControl),
    );
  }

  // A supervised run registers itself in the global registry (~/.loops/runs) and
  // writes its live state there, so another process can list/status/tail it.
  let supervisor: Supervisor | undefined;
  if (options.supervise) {
    supervisor = startSupervisor({
      runId: runId!,
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

  if (restoreEvent) emit({ ...restoreEvent, ts: Date.now() });

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
        runId: supervisor?.runId ?? runId,
        recordPath,
      };
    }
  }

  const rootCtx: JobContext = {
    engine: resolveEngine(defaultEngine),
    resolveEngine,
    signal: controller.signal,
    runId,
    checkpoint: checkpointControl,
    emit,
    state: initialState,
    params: options.params ?? {},
    config: options.config ?? {},
    workspace,
    environment,
    forge: options.forge,
    budget,
    onLimit: options.onLimit ?? 'auto',
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    resumeCommand: options.resumeCommand,
    groundDefault: options.ground,
    curateEnabled: options.curate,
    ladderEnabled: options.ladder,
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

  // Paused runs and graceful signal aborts are meant to be resumable; guarantee
  // the latest shared state is on disk even if no boundary event flushed it.
  if (
    options.checkpoint &&
    (outcome.status === 'paused' ||
      (outcome.status === 'aborted' && controller.signal.aborted))
  )
    flushCheckpoint(
      options.checkpoint,
      initialState,
      checkpointControl,
      await workspaceFingerprint({
        cwd: dir,
        signal: controller.signal.aborted ? undefined : controller.signal,
        excludePaths: uniquePaths([options.checkpoint, options.resumeFrom]),
      }),
    );

  supervisor?.finish(outcome);

  const finalStats = stats.snapshot();
  return {
    outcome,
    stats: finalStats,
    budget: budget
      ? {
          limit: budget.limit,
          spent: budget.spent(),
          remaining: budget.remaining(),
        }
      : undefined,
    runId: supervisor?.runId ?? runId,
    recordPath,
    cost: options.cost
      ? costReport(finalStats, options.cost.prices, options.cost.baselineModel)
      : undefined,
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
