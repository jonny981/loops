/**
 * Build a child `JobContext` from a parent, overriding only the per-scope
 * fields. One helper shared by `loop()` and `dag()` so the next field added to
 * `JobContext` is threaded in exactly one place.
 */

import type { JobContext, Outcome, Workspace } from './types.ts';
import type { EnvHandle } from '../env/environment.ts';

export interface ContextOverride {
  depth: number;
  path: readonly string[];
  iteration?: number;
  lastOutcome?: Outcome;
  lastReview?: Outcome;
  /** Override the workspace (a worktree fork at a concurrency boundary). */
  workspace?: Workspace;
  /** Override the environment (a per-team env at a concurrency boundary). */
  environment?: EnvHandle;
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
    forge: parent.forge,
    budget: parent.budget,
    onLimit: parent.onLimit,
    maxWaitMs: parent.maxWaitMs,
    resumeCommand: parent.resumeCommand,
    log: parent.log,
    depth: over.depth,
    path: over.path,
    // Inherit the enclosing iteration by default. A `loop` always passes one
    // explicitly; a `dag`/`sequence` does not, so without this a node nested in a
    // loop would reset to 0 — the "Attempt 0" confound where a retry body could not
    // see which attempt it was on. A top-level dag still gets 0 (the root's value).
    iteration: over.iteration ?? parent.iteration,
    lastOutcome: over.lastOutcome,
    lastReview: over.lastReview,
  };
}
