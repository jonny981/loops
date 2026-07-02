/**
 * Build a child `JobContext` from a parent, overriding only the per-scope
 * fields. One helper shared by `loop()` and `dag()` so the next field added to
 * `JobContext` is threaded in exactly one place.
 */

import type {
  ConditionResult,
  GraphPosition,
  JobContext,
  Outcome,
  Workspace,
} from './types.ts';
import type { EnvHandle } from '../env/environment.ts';

export interface ContextOverride {
  depth: number;
  path: readonly string[];
  iteration?: number;
  lastOutcome?: Outcome;
  lastReview?: Outcome;
  lastGate?: ConditionResult;
  /** Override the workspace (a worktree fork at a concurrency boundary). */
  workspace?: Workspace;
  /** Override the environment (a per-team env at a concurrency boundary). */
  environment?: EnvHandle;
  /** Override the pinned env vars (a `withEnv` wrapper layering its overlay). */
  envOverlay?: Record<string, string>;
  /** Override the DAG graph position for a node. */
  graph?: GraphPosition;
}

export function childContext(
  parent: JobContext,
  over: ContextOverride,
): JobContext {
  return {
    engine: parent.engine,
    resolveEngine: parent.resolveEngine,
    signal: parent.signal,
    emit: parent.emit,
    state: parent.state,
    // A child inherits the parent's workspace by default; a concurrency
    // boundary forks it into an isolated worktree by passing `workspace`.
    workspace: over.workspace ?? parent.workspace,
    environment: over.environment ?? parent.environment,
    // Inherited, not override-only: pinning deliberately survives the dag
    // worktree boundary, where a node ctx REPLACES `environment` with a
    // per-team handle — an explicit `withEnv` wins over a per-team stack's vars.
    envOverlay: over.envOverlay ?? parent.envOverlay,
    forge: parent.forge,
    budget: parent.budget,
    onLimit: parent.onLimit,
    maxWaitMs: parent.maxWaitMs,
    resumeCommand: parent.resumeCommand,
    groundDefault: parent.groundDefault,
    log: parent.log,
    depth: over.depth,
    path: over.path,
    graph: over.graph ?? parent.graph,
    // Inherit the enclosing iteration by default. A `loop` always passes one
    // explicitly; a `dag`/`sequence` does not, so without this a node nested in a
    // loop would reset to 0 — the "Attempt 0" confound where a retry body could not
    // see which attempt it was on. A top-level dag still gets 0 (the root's value).
    iteration: over.iteration ?? parent.iteration,
    lastOutcome: over.lastOutcome,
    lastReview: over.lastReview,
    lastGate: over.lastGate,
  };
}
