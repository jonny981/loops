/**
 * Build a child `JobContext` from a parent, overriding only the per-scope
 * fields. One helper shared by `loop()` and `dag()` so the next field added to
 * `JobContext` is threaded in exactly one place.
 */

import type { JobContext, Outcome } from './types.ts';

export interface ContextOverride {
  depth: number;
  path: readonly string[];
  iteration?: number;
  lastOutcome?: Outcome;
  lastReview?: Outcome;
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
    budget: parent.budget,
    log: parent.log,
    depth: over.depth,
    path: over.path,
    iteration: over.iteration ?? 0,
    lastOutcome: over.lastOutcome,
    lastReview: over.lastReview,
  };
}
