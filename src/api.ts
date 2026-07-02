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
  JobMeta,
  JobContext,
  Outcome,
  OutcomeStatus,
  FeedbackActionSeverity,
  FeedbackDecision,
  FeedbackFinding,
  FeedbackSeverity,
  RevisionRequest,
  RevisionRerun,
  GraphPosition,
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
export {
  pipeline,
  renderPipelineTable,
  type PipelineStage,
} from './core/pipeline.ts';
export { tournament, type TournamentConfig } from './core/tournament.ts';
export {
  agentJob,
  fnJob,
  commitJob,
  kickback,
  revisionRequest,
  type AgentJobConfig,
  type CommitJobConfig,
  type GroundConfig,
} from './core/job.ts';
export {
  reviewPanel,
  reviewContext,
  feedbackBlock,
  graphPositionBlock,
  normalizeFeedbackSeverity,
  isRequiredFeedbackSeverity,
  revisionFromOutcome,
  type ReviewPanelConfig,
  type ReviewContextConfig,
  type RevisionRequestInput,
} from './core/feedback.ts';

// Job introspection — read a loop's shape without running it (powers `loops
// validate` / `loops describe`, and lets an agent inspect what it authored)
export { jobMeta, renderPlan, describeConditions } from './core/describe.ts';

// Agent definitions — job-specific agents (persona in markdown, structure in TS)
export {
  agentContract,
  defineAgent,
  defineSkill,
  fromFile,
  resolveSystem,
  type AgentContractSummary,
  type AgentDef,
  type AgentFailureMode,
  type AgentHumanGate,
  type AgentOutputContract,
  type AgentSkillRef,
  type AgentTier,
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
  push,
  addWorktree,
  removeWorktree,
  deleteBranch,
  mergeBranch,
  mergeNoCommit,
  conflictedFiles,
  mergeAbort,
  workspaceFingerprint,
  type CommitRecord,
  type CommitInput,
  type LogQuery,
  type PushOptions,
  type PushResult,
  type WorktreeHandle,
  type MergeResult,
} from './core/git.ts';

// Merge as synthesis (an agent resolves the conflict + writes a unified "way")
export {
  mergeSynthesis,
  type MergeSynthesisConfig,
  type MergeSynthesisResult,
} from './core/merge.ts';

// The Forge — the PR host seam (gh-backed by default), and PR jobs that keep a
// PR body a faithful synthesis of the branch so the Ledger survives a squash merge
export {
  isForge,
  GhForge,
  MockForge,
  buildViewArgs,
  buildCreateArgs,
  buildEditArgs,
  buildMergeArgs,
  buildChecksArgs,
  type Forge,
  type PrRef,
  type PrInput,
  type PrPatch,
  type MergeOptions,
  type ForgeOpts,
  type MockForgeOptions,
} from './core/forge.ts';
export {
  pushJob,
  pullRequestJob,
  mergeJob,
  type PushJobConfig,
  type PullRequestJobConfig,
  type MergeJobConfig,
} from './core/pr.ts';

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
  forgeChecks,
  agentCheck,
  gateJob,
  type AgentCheckConfig,
} from './core/condition.ts';
// No-progress (stall) detection — the third hard stop, alongside `max` and
// `budget`. Configured per-loop via `LoopConfig.noProgress`; exported so a
// custom harness can drive the same tracker.
export {
  ProgressTracker,
  resolveNoProgress,
  type NoProgressConfig,
  type NoProgressInput,
  type ProgressSample,
  type StallReport,
} from './core/progress.ts';
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
// Env-var pinning for a job subtree — distinct from the Environment seam:
// `withEnv` pins vars over a scope; an Environment brings a stack up and owns
// its lifecycle (an overlay has no `down()`)
export { withEnv } from './core/env-overlay.ts';

// Runtime
export {
  run,
  exitCodeFor,
  EXIT_PAUSED,
  type RunOptions,
  type RunResult,
} from './runtime/runner.ts';
export { Stats, type StatsSnapshot } from './core/stats.ts';

// Supervision — observe a supervised run from another process. The registry is
// files (~/.loops/runs), so these are the read side a `loops list`/`status`/`tail`
// (or an MCP server) builds on. A run opts in with `RunOptions.supervise`.
export {
  listRuns,
  readRunStatus,
  runEventsPath,
  runSemanticRecordsPath,
  runsHome,
  formatEvent,
  type RunStatus,
  type RunLive,
} from './runtime/supervisor.ts';
export {
  semanticRecordsFromEvent,
  type SemanticDecision,
  type SemanticOutcome,
  type SemanticRunRecord,
} from './runtime/semantic.ts';

import type { Job } from './core/types.ts';

/** Identity helper that pins the type of a default export to `Job`. */
export function defineJob(job: Job): Job {
  return job;
}
