/**
 * Public API. A loop-definition file imports from here and `export default`s a
 * `Job` (usually a `loop(...)` or `dag(...)`). The CLI runs that default export.
 *
 *   import { loop, agentJob, agentCheck, defineJob } from 'loops';
 *   export default defineJob(loop({ ... }));
 */

// Core types
export type {
  Job,
  JobContext,
  Outcome,
  OutcomeStatus,
  Condition,
  ConditionInput,
  ConditionResult,
  RawPredicate,
  LoopConfig,
  RetryPolicy,
  DagConfig,
  DagNode,
  LoopEvent,
  LogLevel,
} from './core/types.ts';

// Primitives
export { loop } from './core/loop.ts';
export { dag, sequence, parallel } from './core/dag.ts';
export { agentJob, fnJob, type AgentJobConfig } from './core/job.ts';
export {
  toCondition,
  predicate,
  bodyPassed,
  minConfidence,
  all,
  any,
  not,
  always,
  never,
  agentCheck,
  gateJob,
  type AgentCheckConfig,
} from './core/condition.ts';
export { LoopError, type LoopErrorCode } from './core/errors.ts';

// Engines (the drop-in seam)
export type {
  Engine,
  EngineRef,
  EngineName,
  EngineOptions,
  AgentRequest,
  AgentResult,
  EngineStreamEvent,
  Usage,
} from './engines/engine.ts';
export { isEngine } from './engines/engine.ts';
export { EngineRegistry, type EngineFactory } from './engines/registry.ts';
export { MockEngine, mockVerdict, type MockResponder } from './engines/mock.ts';

// Runtime
export { run, exitCodeFor, type RunOptions, type RunResult } from './runtime/runner.ts';
export { Stats, type StatsSnapshot } from './core/stats.ts';

import type { Job } from './core/types.ts';

/** Identity helper that pins the type of a default export to `Job`. */
export function defineJob(job: Job): Job {
  return job;
}
