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
  LimitPolicy,
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
  Workspace,
} from './core/types.ts';

// Primitives
export { loop } from './core/loop.ts';
export { dag, sequence, parallel } from './core/dag.ts';
export { tournament, type TournamentConfig } from './core/tournament.ts';
export {
  agentJob,
  fnJob,
  commitJob,
  type AgentJobConfig,
  type CommitJobConfig,
  type GroundConfig,
} from './core/job.ts';

// Agent definitions — job-specific agents (persona in markdown, structure in TS)
export {
  defineAgent,
  defineSkill,
  fromFile,
  resolveSystem,
  type AgentDef,
  type Skill,
} from './core/agent.ts';

// Git substrate (the convergence ledger)
export {
  isRepo,
  currentBranch,
  headSha,
  stageAll,
  hasStagedChanges,
  isDirty,
  commit,
  log,
  addWorktree,
  removeWorktree,
  deleteBranch,
  mergeBranch,
  mergeNoCommit,
  conflictedFiles,
  mergeAbort,
  type CommitRecord,
  type CommitInput,
  type LogQuery,
  type WorktreeHandle,
  type MergeResult,
} from './core/git.ts';

// Merge as synthesis (an agent resolves the conflict + writes a unified "way")
export {
  mergeSynthesis,
  type MergeSynthesisConfig,
  type MergeSynthesisResult,
} from './core/merge.ts';

// Worktree isolation as a composable Job wrapper (for dynamic dispatch)
export { isolated, type IsolatedOptions } from './core/isolated.ts';

// The scratch files — two write-ahead buffers: the handoff (`prompt.md`, the
// staged commit body) and working memory (`ledger.md`, the auto-captured turn log)
export {
  appendPrompt,
  readPrompt,
  resetPrompt,
  promptPath,
  appendLedger,
  readLedger,
  resetLedger,
  ledgerPath,
  ensureIgnored,
  type PromptNote,
  type LedgerEntry,
} from './core/draft.ts';

// The read side — grounding the next fresh context in the branch-local commit log
export {
  groundingText,
  retrieveLedger,
  type GroundOptions,
  type RetrieveOptions,
} from './core/ground.ts';

// Consolidation — fold the commit log into a consolidated ledger (the coarse memory),
// and the one-scale-down fold of a run's working log into the commit body
export {
  consolidate,
  consolidateJob,
  compactLedger,
  composeCommitBody,
  type ConsolidateOptions,
  type ConsolidateJobConfig,
  type CompactOptions,
} from './core/consolidate.ts';
export {
  toCondition,
  predicate,
  bodyPassed,
  minConfidence,
  commandSucceeds,
  all,
  any,
  not,
  quorum,
  always,
  never,
  agentCheck,
  gateJob,
  type AgentCheckConfig,
} from './core/condition.ts';
export { LoopError, type LoopErrorCode } from './core/errors.ts';
export { Budget, type BudgetConfig } from './core/budget.ts';

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
export { isEngine, SUBAGENT_TOOLS } from './engines/engine.ts';
export { EngineRegistry, type EngineFactory } from './engines/registry.ts';
export { MockEngine, mockVerdict, type MockResponder } from './engines/mock.ts';

// Environments (where the code runs — the third provider axis)
export {
  isEnvironment,
  type Environment,
  type EnvHandle,
} from './env/environment.ts';
export { MockEnvironment, type MockEnvOptions } from './env/mock.ts';

// Runtime
export {
  run,
  exitCodeFor,
  EXIT_PAUSED,
  type RunOptions,
  type RunResult,
} from './runtime/runner.ts';
export { Stats, type StatsSnapshot } from './core/stats.ts';

import type { Job } from './core/types.ts';

/** Identity helper that pins the type of a default export to `Job`. */
export function defineJob(job: Job): Job {
  return job;
}
