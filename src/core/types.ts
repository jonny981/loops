/**
 * The core contract. Borrowing the Jenkins instinct — "everything is a job" —
 * there is one universal runnable unit and two supporting types:
 *
 *   - a `Job`       — a unit of work that runs once and returns an `Outcome`.
 *                     Any size: a single agent turn, or a whole nested loop.
 *   - a `Condition` — a question answered against the current context (a `when`).
 *   - a `Loop`      — produced by `loop()`, and is *itself a `Job`*.
 *
 * Because a `Loop` is a `Job`, a loop's `body`/`review`/any stage can be
 * another `loop(...)`. Nesting is the absence of a special case, not a feature.
 *
 * The Jenkins mapping, for the parts we borrow: Job≈job/pipeline, Engine≈agent/
 * node (where it runs), `start`≈trigger, `Condition`≈`when`, `review`+`onComplete`
 * ≈`post`, `retry`≈`retry`/`catchError`. We deliberately do NOT import the
 * stage/DAG machinery — the primitive here is the loop, not a pipeline.
 */

import type { Engine, EngineRef, Usage } from '../engines/engine.ts';
import type { LoopError } from './errors.ts';
import type { Budget } from './budget.ts';
import type { CommitJobConfig } from './job.ts';
import type { EnvHandle, Environment } from '../env/environment.ts';

/** Terminal disposition of a `Job`. */
export type OutcomeStatus =
  | 'pass' // the step achieved its goal
  | 'fail' // the step ran but did not achieve its goal (loops keep going)
  | 'aborted' // an early-exit signal or `stopOn` cut the work short
  | 'exhausted'; // a loop hit `max` iterations without passing

export interface Outcome {
  status: OutcomeStatus;
  /** 0..1 confidence, when the outcome was decided by an agent validator. */
  confidence?: number;
  /** One-line human summary, surfaced in the TUI and exit report. */
  summary?: string;
  /** Arbitrary payload threaded to the next step / surfaced to the caller. */
  data?: unknown;
  /** Present when `status` is driven by a failure. */
  error?: LoopError;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Where a job's code lives: a working directory and (when it is a git repo) the
 * branch checked out there. This is the substrate the commit ledger is written
 * to and read back from. A sequential loop's iterations share one `Workspace`
 * (the ledger accumulates on one branch); concurrency is where workspaces fork
 * into isolated worktrees. Default: the process working directory.
 */
export interface Workspace {
  /** Absolute path to the working tree this job operates in. */
  readonly dir: string;
  /** The branch checked out in `dir`, when known (undefined on detached HEAD). */
  readonly branch?: string;
}

/**
 * Threaded into every `Job`. Carries the engine, the abort signal, the event
 * sink, a mutable scratchpad shared across the run, the workspace the work
 * happens in, and the position in the loop tree (used by the TUI and stats).
 */
export interface JobContext {
  /** Default engine for this run; overridable per-step via `resolveEngine`. */
  readonly engine: Engine;
  /**
   * Resolve an engine for a step. Accepts a registered name, a ready-made
   * `Engine` (bring-your-own provider/framework), or nothing (the run default).
   */
  resolveEngine(ref?: EngineRef): Engine;
  readonly signal: AbortSignal;
  emit(event: LoopEvent): void;
  /** Shared mutable state for the whole run (e.g. accumulating notes). */
  readonly state: Record<string, unknown>;
  /** Where this job's code lives — the working dir and branch (the substrate). */
  readonly workspace: Workspace;
  /** The running environment for this workspace, when one is up (gate target). */
  readonly environment?: EnvHandle;
  /** 1-based iteration index within the enclosing loop; 0 outside a loop. */
  readonly iteration: number;
  /** Nesting depth (root steps are 0). */
  readonly depth: number;
  /** Loop/step names from the root down to here. */
  readonly path: readonly string[];
  /** The previous body outcome in the enclosing loop (used by `review`/gates). */
  readonly lastOutcome?: Outcome;
  /** The most recent failed-review outcome, so a restart can act on it. */
  readonly lastReview?: Outcome;
  /** The run's token budget, when one is set; engine call sites guard on it. */
  readonly budget?: Budget;
  log(message: string, level?: LogLevel): void;
}

export type Job = (ctx: JobContext) => Promise<Outcome>;

export interface ConditionResult {
  met: boolean;
  /** 0..1 when an agent decided this; undefined for deterministic checks. */
  confidence?: number;
  reason: string;
}

/**
 * The single condition primitive. A question answered against the context and
 * the most recent body outcome. Both deterministic checks and agent validators
 * are this same type — `agentCheck(...)` simply returns one.
 */
export type Condition = (
  ctx: JobContext,
  last: Outcome | undefined,
) => Promise<ConditionResult>;

/** A bare deterministic predicate — accepted anywhere a `Condition` is. */
export type RawPredicate = (
  ctx: JobContext,
  last: Outcome | undefined,
) => boolean | Promise<boolean>;

/**
 * What a gate (`start`/`until`/`stopOn`) accepts: one item or many, freely
 * mixing deterministic predicates and agent conditions. Arrays are reduced to
 * the single `Condition` primitive by `toCondition` (default: all must hold;
 * wrap in `any(...)` for or-semantics).
 */
export type ConditionInput = Condition | RawPredicate | ConditionInput[];

export interface RetryPolicy {
  /** On a thrown error in the body: keep looping, or end the loop as failed. */
  onError: 'continue' | 'fail';
  /** Cap on consecutive errored iterations before forcing 'fail'. */
  maxConsecutive?: number;
  backoffMs?: number;
}

export interface LoopConfig {
  name: string;
  /** The work done each iteration. Pass another `loop(...)` to nest. */
  body: Job;
  /** Gate before iterating; one or many checks. Unmet => loop is `aborted`. */
  start?: ConditionInput;
  /** After each body run; one or many checks. Met => stop (then `review`). */
  until?: ConditionInput;
  /** Hard early-exit per iteration; one or many checks. Met => `aborted`. */
  stopOn?: ConditionInput;
  /** Iteration cap. Reached without passing => `exhausted`. */
  max?: number;
  /**
   * Runs when `until` is met. If it returns `pass`, the loop completes.
   * Any other status re-enters the loop — this is the "review fails, run the
   * main loop again" behaviour, and `review` may itself be a `loop(...)`. The
   * failed review outcome is exposed to the next iteration as `ctx.lastReview`.
   */
  review?: Job;
  /**
   * Cap on consecutive failed reviews before giving up with `exhausted`.
   * Bounds the review-restart cycle independently of `max`; strongly advised
   * when `review` is set with no `max` (otherwise a worker/reviewer standoff
   * never terminates). Default: unbounded (relies on `max`).
   */
  maxReviewRestarts?: number;
  /**
   * Record a checkpoint commit when the loop converges — the milestone. A commit
   * is a milestone, not an iteration: iterations accumulate the why in the draft,
   * and `commitJob` composes one structured commit from it on convergence. `true`
   * derives the subject from the converged outcome; pass a `CommitJobConfig` to
   * set the subject/body. Off by default. Finer granularity comes from finer
   * structure (more loops/nodes), not per-iteration commits.
   */
  commit?: boolean | CommitJobConfig;
  /** Delay between iterations (polling intervals). Interruptible by abort. */
  delayMs?: number;
  retry?: RetryPolicy;
  /** Side-effect hook after each iteration (logging, custom stats). */
  onIteration?: (outcome: Outcome, ctx: JobContext) => void | Promise<void>;
  /**
   * Post-action run exactly once when the loop ends, whatever the status
   * (Jenkins `post { always }`). For cleanup, notifications, final logging.
   */
  onComplete?: (outcome: Outcome, ctx: JobContext) => void | Promise<void>;
}

// ── DAG / stages ────────────────────────────────────────────────────────────
// A DAG of jobs is itself a `Job`, so it composes with `loop()` both ways: a
// node can be a loop, and a loop body can be a DAG. This is the "stages" layer,
// generalised — sequential stages, parallel stages, and arbitrary dependencies
// are all expressed as nodes + `needs`.

export interface DagNode {
  job: Job;
  /** Names of nodes that must finish (passing) before this one runs. */
  needs?: string[];
  /** Gate (one or many) — when unmet the node is skipped, not failed. */
  when?: ConditionInput;
  /** A failure here does not fail the DAG, and does not block dependents. */
  optional?: boolean;
  /**
   * Run this node in its own git worktree on a fork branch (branches-as-teams).
   * Concurrent writers then never collide on files or the index, and the node's
   * committed work lands back into the parent branch on pass. Defaults to the
   * DAG's `isolation`. Opt-in: forking a worktree has a real setup cost, and a
   * read-only node never needs it.
   */
  isolate?: boolean;
}

export interface DagConfig {
  name: string;
  /** Node name → a `DagNode`, or a bare `Job` (shorthand for no deps/gates). */
  nodes: Record<string, DagNode | Job>;
  /** Max nodes running at once. Default: unbounded. */
  concurrency?: number;
  /** When a required node fails, abort the rest. Default: true. */
  stopOnError?: boolean;
  /**
   * Default isolation for nodes that do not set `isolate`. `'worktree'` runs each
   * such node in its own worktree + fork branch, landed back on pass. Off by
   * default — the shared workspace.
   */
  isolation?: 'worktree';
  /**
   * Give each ISOLATED node its own environment, brought up when its worktree
   * forks and torn down when it joins — so every branch-team gets its own stage,
   * named by the provider from the workspace branch. Requires isolation; a
   * non-isolated node shares the workspace and gets no per-team env.
   */
  environment?: Environment;
}

/** Per-node disposition within a DAG run. */
export type NodePhase = 'start' | 'skip' | 'done';

// ── Events ──────────────────────────────────────────────────────────────────
// One discriminated union drives streaming, the TUI, the stats collector, and
// the `--json` reporter. Every event carries the loop `path` so consumers can
// place it in the tree.

export type ConditionKind = 'start' | 'until' | 'stopOn';

export type LoopEvent =
  | {
      kind: 'loop:start';
      ts: number;
      path: string[];
      depth: number;
      max?: number;
    }
  | { kind: 'loop:iteration'; ts: number; path: string[]; iteration: number }
  | {
      kind: 'loop:condition';
      ts: number;
      path: string[];
      which: ConditionKind;
      result: ConditionResult;
    }
  | { kind: 'loop:review'; ts: number; path: string[]; outcome: Outcome }
  | {
      kind: 'loop:end';
      ts: number;
      path: string[];
      outcome: Outcome;
      iterations: number;
    }
  | {
      kind: 'dag:start';
      ts: number;
      path: string[];
      depth: number;
      nodes: string[];
    }
  | {
      kind: 'dag:node';
      ts: number;
      path: string[];
      node: string;
      phase: NodePhase;
      outcome?: Outcome;
    }
  | { kind: 'dag:end'; ts: number; path: string[]; outcome: Outcome }
  | { kind: 'job:start'; ts: number; path: string[]; label: string }
  | {
      kind: 'job:end';
      ts: number;
      path: string[];
      label: string;
      outcome: Outcome;
    }
  | { kind: 'engine:text'; ts: number; path: string[]; delta: string }
  | { kind: 'engine:thinking'; ts: number; path: string[]; delta: string }
  | {
      kind: 'engine:tool';
      ts: number;
      path: string[];
      name: string;
      phase: 'use' | 'result';
    }
  | {
      kind: 'engine:usage';
      ts: number;
      path: string[];
      model: string;
      usage: Usage;
    }
  | {
      kind: 'log';
      ts: number;
      path: string[];
      level: LogLevel;
      message: string;
    }
  | {
      kind: 'error';
      ts: number;
      path: string[];
      message: string;
      code: string;
    };

export type LoopEventKind = LoopEvent['kind'];
