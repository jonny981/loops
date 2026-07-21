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
  ProofKind,
  ProofArtifact,
  ProofRecord,
} from './core/types.ts';
export {
  defineParams,
  type ParamDefinitions,
  type ParamSpec,
  type ParamType,
  type RunParams,
} from './core/params.ts';
export {
  defineConfig,
  type LoopsConfig,
  type LoopsRunConfig,
} from './core/config-file.ts';

// Primitives
export { loop } from './core/loop.ts';
export { dag, sequence, parallel } from './core/dag.ts';
export {
  LivePlan,
  livePlan,
  getLivePlan,
  livePlanNames,
  type LivePlanConfig,
  type PlanEdit,
  type PlanEditSource,
  type PlanTemplate,
  type PlanGuard,
  type PlanChange,
} from './core/plan.ts';
export {
  momentumFromEvents,
  momentumLine,
  type MomentumReport,
  type MomentumState,
  type MomentumOptions,
} from './core/momentum.ts';
export {
  requestControl,
  startControlChannel,
  controlPath,
  type ControlCommand,
  type ControlChannel,
} from './runtime/control.ts';
export { mapWithConcurrency } from './core/concurrency.ts';
export {
  pipeline,
  renderPipelineTable,
  type PipelineStage,
} from './core/pipeline.ts';
export { tournament, type TournamentConfig } from './core/tournament.ts';
export {
  agentJob,
  fnJob,
  prove,
  commitJob,
  kickback,
  revisionRequest,
  // The handoff contract: parse a grounded turn's reply into the work (before
  // the marker) and the handoff (after it), the same split the auto-capture
  // and an `outcome` mapper's `parts` argument use.
  parseHandoff,
  HANDOFF_MARK,
  type HandoffParts,
  type AgentJobConfig,
  type AgentRoute,
  type ProofDescriptor,
  type ProofProducer,
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
// The assertion half: turns loops-describe introspection into test assertions
// (a partial shape expectation over `jobMeta`, mismatch => a path-carrying Error)
export {
  assertGraph,
  type GraphShape,
  type GraphNodeShape,
} from './core/assert-graph.ts';

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
// Load a Claude Code agent .md (frontmatter + body) into an AgentDef
export { defineAgentFromMarkdown } from './core/agent-md.ts';

// Human gates — the runtime half of `AgentDef.humanGates`: a job that pauses
// the run (`paused`, exit 75) until a person acknowledges the named gate
// (CLI `--ack <name>`, or a `state` seed under `humanGateKey(name)`)
export {
  humanGate,
  humanGateKey,
  pausedHumanGate,
  type HumanGateConfig,
} from './core/human.ts';

// Git substrate (the convergence ledger)
export {
  isRepo,
  currentBranch,
  gitRoot,
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

// The Forge: the PR host interface (gh-backed by default), and PR jobs that keep
// a PR body a synthesis of the branch so the Ledger survives a squash merge
export {
  isForge,
  GhForge,
  MockForge,
  buildViewArgs,
  buildCreateArgs,
  buildEditArgs,
  buildMergeArgs,
  buildCheckStateArgs,
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
export {
  confidenceCondition,
  confidenceFromText,
  lastDecisionLine,
  lastGateBrief,
  type ConfidenceConditionOptions,
  type LastDecisionLineOptions,
  type LastGateBriefOptions,
} from './core/decision.ts';
export {
  promptBank,
  type PromptBank,
  type PromptBankOptions,
  type PromptVars,
} from './core/prompt-bank.ts';

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

// Engines (the drop-in interface)
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
export { settleOnExit, EXIT_DRAIN_MS } from './engines/settle.ts';
export { EngineRegistry, type EngineFactory } from './engines/registry.ts';
export { MockEngine, mockVerdict, type MockResponder } from './engines/mock.ts';

// Environments (where the code runs — the third provider axis)
export {
  isEnvironment,
  type Environment,
  type EnvHandle,
} from './env/environment.ts';
export { MockEnvironment, type MockEnvOptions } from './env/mock.ts';
// Env-var pinning for a job subtree, distinct from the Environment interface:
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
  readRunProgress,
  runEventsPath,
  runEvidenceIndexPath,
  runSemanticRecordsPath,
  runsHome,
  formatEvent,
  type RunStatus,
  type RunLive,
  type RunProgress,
} from './runtime/supervisor.ts';
export {
  semanticRecordsFromEvent,
  readSemanticRecords,
  formatSemanticRecord,
} from './runtime/semantic.ts';
export {
  SEMANTIC_RECORD_FILTER_KINDS,
  SEMANTIC_RUN_RECORD_KINDS,
  SEMANTIC_RUN_RECORD_SCHEMA_VERSION,
  adaptSemanticRunRecord,
  parseSemanticRunRecord,
  safeParseSemanticRunRecord,
  semanticRunRecordJsonSchema,
  semanticRunRecordSchema,
  type SemanticDecision,
  type SemanticOutcome,
  type SemanticRecordFilterKind,
  type SemanticRecordKind,
  type SemanticRecordOf,
  type SemanticRunRecord,
} from './runtime/semantic-schema.ts';

// Provider resilience — a shared failure vocabulary, a fallback chain that is
// just another Engine, and preflight (one tiny live turn per lane, classified,
// so a dead key or missing CLI surfaces before iteration 1 spends anything).
export {
  classifyEngineFailure,
  LANE_DEAD_FAILURES,
  type EngineFailureKind,
} from './engines/failure.ts';
export {
  fallbackEngine,
  type FallbackOptions,
  type FallbackInfo,
} from './engines/fallback.ts';
export {
  preflight,
  preflightEngine,
  formatPreflight,
  type PreflightResult,
  type PreflightOptions,
} from './engines/preflight.ts';

// Cost accounting — price measured usage with a caller-supplied table (the
// library hardcodes no prices), never silently $0, and an optional
// reconstructed baseline: the same token stream at a ceiling model's rates.
export {
  costReport,
  formatCostReport,
  priceFor,
  type PriceTable,
  type ModelPrice,
  type ModelCost,
  type CostReport,
} from './core/cost.ts';

// Curated grounding — the grounding read graduating from "prepend the recent
// ledger" to "a cheap agent composes the right context": declared sources, a
// curated brief, and (opt-in) the ladder of engine rungs its verdict may pick
// from. All inert unless configured; `--no-curate` / `--no-ladder` are the
// run-level A/B switches.
export {
  readSources,
  curateContext,
  type SourceSpec,
  type SourceText,
  type CurateConfig,
  type CurateVerdict,
  type LadderRung,
} from './core/curate.ts';

// Hardening gates — deterministic conditions that keep a loop honest without
// spending a model call: a monotone metric baseline the agent cannot loosen,
// a declared write scope, and reproducible sampling for expensive judges.
export {
  ratchet,
  writeScope,
  sampled,
  globToRegExp,
  type RatchetOptions,
  type WriteScopeOptions,
  type SampledOptions,
} from './core/guards.ts';

// Helm — the conversational harness over the library: a driver model (any
// Engine) emits structured intents, the bridge executes them against the
// runtime, and the driver eval measures which models can drive the contract.
export {
  parseHelmIntent,
  extractFirstJson,
  helmIntentSchema,
  HelmParseError,
  HelmIntentError,
  HELM_ACTIONS,
  HELM_RECORD_KINDS,
  type HelmIntent,
  type HelmAction,
} from './helm/intent.ts';
export { helmSystemPrompt, type HelmSystemOptions } from './helm/system.ts';
export {
  HelmBridge,
  type HelmBridgeOptions,
  type Observation,
} from './helm/bridge.ts';
export {
  HelmSession,
  type HelmSessionOptions,
  type HelmEvent,
  type TurnEndReason,
} from './helm/session.ts';
export { oracleEngine, oracleResponder, oracleIntent } from './helm/oracle.ts';
export {
  assessReply,
  compositeScore,
  type TaskCase,
  type AttemptDims,
  type Assessment,
} from './helm/score.ts';
export {
  evalDrivers,
  prepareEvalWorkspace,
  renderEvalReport,
  apiSpecifier,
  DRIVER_BATTERY,
  type DriverSpec,
  type EvalAttempt,
  type DriverSummary,
  type EvalReport,
  type EvalOptions,
} from './helm/eval.ts';

import type { Job } from './core/types.ts';

/** Identity helper that pins the type of a default export to `Job`. */
export function defineJob(job: Job): Job {
  return job;
}
