/**
 * Job builders. A `Job` is the unit of work; these are the common shapes.
 * The agent launch (`agentJob`) is deliberately provider-agnostic: it only
 * ever calls `Engine.run`, so it knows nothing about Claude, the CLI, an SDK,
 * an HTTP API, or any framework — swap the engine and the same job runs.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type {
  Outcome,
  Job,
  JobContext,
  ProofArtifact,
} from './types.ts';
import { setMeta } from './describe.ts';
import type { AgentResult, EngineRef } from '../engines/engine.ts';
import { resolveEnv } from './env-overlay.ts';
import { LoopError, type LoopErrorCode } from './errors.ts';
import { scrubCapture } from './redact.ts';
import { assertBudget } from './budget.ts';
import { isRepo, stageAll, commit } from './git.ts';
import {
  appendLedger,
  appendPrompt,
  readLedger,
  readPrompt,
  resetLedger,
  resetPrompt,
  ensureIgnored,
} from './draft.ts';
import { composeCommitBody } from './consolidate.ts';
import { groundingText, retrieveLedger } from './ground.ts';
import { agentContract, resolveSystem, type AgentDef } from './agent.ts';
import {
  feedbackBlock,
  graphPositionBlock,
  kickback,
  revisionRequest,
} from './feedback.ts';
import { loopsRequestMeta } from './engine-meta.ts';

export interface AgentJobConfig {
  /** Job label (for events). Defaults to the agent's name, then `'agent'`. */
  label?: string;
  /**
   * A reusable agent definition — supplies `system` (persona + skills), `model`, and
   * `tools` (the job's `system`/`model`/`allowedTools` override it when also set). The
   * persona lives in markdown via `fromFile`; this is the typed wrapper around it.
   */
  agent?: AgentDef;
  /** The prompt, or a function of the context (e.g. include the iteration). */
  prompt: string | ((ctx: JobContext) => string | Promise<string>);
  system?: string | ((ctx: JobContext) => string);
  /** Engine override: a registered name, your own `Engine`, or the default. */
  engine?: EngineRef;
  /** Bare model id — passed straight through to the engine. */
  model?: string;
  maxTokens?: number;
  allowedTools?: string[];
  /**
   * Mark this turn a leaf: forbid spawning sub-agents (the engine disallows the sub-agent
   * tool), so a branch bottoms out here. Falls back to the agent def's `leaf`.
   */
  leaf?: boolean;
  /**
   * Append the current `ctx.lastReview` / revision feedback to the prompt. This
   * keeps implementation agents from having to remember to manually read the
   * runtime feedback channel in every prompt function.
   */
  consumeFeedback?: boolean;
  /**
   * Append a compact DAG-position block: this node, its direct dependencies, and
   * its direct dependents, without handing the agent the whole orchestration graph.
   */
  graphContext?: boolean;
  /** Working dir for the turn. Default: the workspace dir (the worktree). */
  cwd?: string;
  /**
   * Env vars pinned for this leaf's engine subprocess — the most specific
   * layer, over any `withEnv` overlay and the running environment's vars.
   * Engines that spawn no subprocess ignore it.
   */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Extra hard-timeout window after `timeoutMs` for completed final results. */
  timeoutGraceMs?: number;
  /** Fallback route(s) used when the primary engine hits a configured error. */
  fallback?: AgentRoute | AgentRoute[];
  /** Error codes that may spill to `fallback`. Default: RATE_LIMIT and QUOTA. */
  fallbackOn?: LoopErrorCode[];
  /**
   * Ground the turn in memory before it works: prepend the branch-local commit log
   * (recent committed milestones), the live working memory (`ledger.md`) and handoff
   * (`prompt.md`) from this run, and tell the agent where to record its own
   * reasoning. With grounding on, the harness also auto-captures the turn into
   * `ledger.md` afterwards. `true` uses defaults; an object tunes the reach. This is
   * how a fresh context stops repeating what earlier iterations already tried.
   */
  ground?: boolean | GroundConfig;
  /**
   * Map the agent's raw text into an `Outcome`. Default: `pass`, with the text
   * as the summary. Return `fail` to keep an enclosing loop going. `text` is
   * the reply after the capture scrub (injected env values and secret-shaped
   * tokens are redacted — the outcome flows into persisted records), with any
   * handoff block still embedded; `parts` is `parseHandoff(text)` —
   * `parts.work` is the reply with the handoff block stripped, the right input
   * for decision-token parsing (a token restated inside the handoff's sections
   * cannot false-score).
   */
  outcome?: (
    text: string,
    ctx: JobContext,
    parts: HandoffParts,
  ) => Outcome | Promise<Outcome>;
}

export interface AgentRoute {
  engine?: EngineRef;
  model?: string;
  ground?: boolean | GroundConfig;
  timeoutMs?: number;
  timeoutGraceMs?: number;
}

export type ProofDescriptor = ProofArtifact;
export type ProofProducer = (
  ctx: JobContext,
) => ProofDescriptor | Promise<ProofDescriptor>;

/** A grounded turn's reply split at the handoff marker — see `parseHandoff`. */
export interface HandoffParts {
  /** The reply with the handoff block stripped — the working log. */
  work: string;
  /** The handoff block after the marker, when one was written. */
  handoff?: string;
}

export interface GroundConfig {
  /** Max committed milestones to include (newest first). Default 10. */
  max?: number;
  /** Truncate each commit body to this many chars. Default 1200. */
  bodyChars?: number;
  /** Include the live scratch files (this run's working memory + handoff). Default true. */
  includeScratch?: boolean;
  /** Tell the agent to leave memory for the next agent. Default true. */
  recordInstruction?: boolean;
  /**
   * Retrieve relevant commits with a cheap model instead of taking recent-N.
   * Far less noisy when the branch log carries unrelated work (a shared repo).
   * `true` uses defaults; an object tunes the candidate window / selection model.
   */
  retrieve?: boolean | { candidates?: number; engine?: EngineRef; model?: string };
}

/** The marker the agent closes its reply with; the harness parses everything after it
 *  as the handoff. A sentinel in the reply, not a file write, so the memory is captured
 *  from the agent's own words. */
export const HANDOFF_MARK = '===HANDOFF===';

/** The handoff contract appended to a grounded turn. The harness splits the reply at the
 *  marker into the working log (before) and the handoff (after); see `parseHandoff`. */
function recordBlock(): string {
  return (
    `## Before you finish: the handoff\n` +
    `Answer one question for whoever continues this: **what is everything future-you needs ` +
    `to know about this if you lost all memory of it?** The harness keeps your answer as the ` +
    `memory the next agent reads and as the commit body, so carry the WHY, not just the what — ` +
    `write it so they cannot repeat your dead ends or break your decisions.\n` +
    `End your reply with this block (keep the \`${HANDOFF_MARK}\` marker exactly; drop a ` +
    `section only if it truly has nothing):\n\n` +
    `${HANDOFF_MARK}\n` +
    `## Why\n<the problem and the root cause you found>\n` +
    `## What\n<the change you made>\n` +
    `## Alternatives\n<what you ruled out, and why>\n` +
    `## Constraints\n<the invariants and limits that shaped it>\n` +
    `## Next\n<what is left, or what to watch>`
  );
}

/**
 * Parse a grounded turn's reply at the handoff marker (`HANDOFF_MARK`,
 * `===HANDOFF===`): `work` is everything before it (the working log, captured
 * to `ledger.md`), `handoff` everything after (captured to `prompt.md`). The
 * marker must sit on its own line, but matching is lenient to case and internal
 * whitespace (`=== handoff ===` matches), and the scan runs backwards so the
 * LAST marker wins when the reply restates it. No marker → `{ work: text.trim() }`.
 * A marker with nothing after it → `handoff` is `undefined`.
 */
export function parseHandoff(text: string): HandoffParts {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().replace(/\s+/g, '').toUpperCase() === HANDOFF_MARK) {
      return {
        work: lines.slice(0, i).join('\n').trim(),
        handoff: lines.slice(i + 1).join('\n').trim() || undefined,
      };
    }
  }
  return { work: text.trim() };
}

/**
 * Build the grounding preamble: the committed commit log (past milestones), this
 * run's live working memory (`ledger.md`) and handoff (`prompt.md`), and an
 * instruction to leave memory behind — then the caller's prompt. Empty parts are
 * dropped, so a first turn on a fresh branch is just the prompt.
 */
async function withGrounding(
  ctx: JobContext,
  userPrompt: string,
  ground: boolean | GroundConfig,
  routeEngine?: EngineRef,
  routeModel?: string,
): Promise<string> {
  const opts: GroundConfig = typeof ground === 'object' ? ground : {};
  const parts: string[] = [];
  const retrieveConfig =
    typeof opts.retrieve === 'object' ? opts.retrieve : undefined;

  const committed = opts.retrieve
    ? await retrieveLedger(ctx, {
        intent: userPrompt,
        max: opts.max,
        bodyChars: opts.bodyChars,
        candidates: retrieveConfig?.candidates,
        engine: retrieveConfig?.engine ?? routeEngine,
        model: retrieveConfig?.model ?? routeModel,
      })
    : await groundingText(ctx.workspace, {
        max: opts.max,
        bodyChars: opts.bodyChars,
        signal: ctx.signal,
      });
  if (committed) parts.push(committed);

  if (opts.includeScratch !== false) {
    const working = readLedger(ctx.workspace);
    if (working)
      parts.push(
        `## Working memory (this run so far)\n\n` +
          `What earlier turns in this run tried and found — build on it.\n\n${working}`,
      );
    const handoff = readPrompt(ctx.workspace);
    if (handoff)
      parts.push(
        `## Handoff so far (what earlier work distilled for the next agent)\n\n${handoff}`,
      );
  }

  if (opts.recordInstruction !== false) parts.push(recordBlock());

  parts.push(userPrompt);
  return parts.join('\n\n---\n\n');
}

/** Collapse a turn's tool-use counts into compact tokens (`Edit×2`, `Bash`). */
function summariseTools(uses: Map<string, number>): string[] {
  return [...uses].map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
}

const TERMINAL = (text: string): Outcome => ({
  status: 'pass',
  summary: text.trim().slice(0, 280),
  data: text,
});

function withOperationalContext(
  ctx: JobContext,
  userPrompt: string,
  config: Pick<AgentJobConfig, 'consumeFeedback' | 'graphContext'>,
): string {
  const parts = [userPrompt];
  if (config.consumeFeedback && ctx.lastReview) {
    parts.push(feedbackBlock(ctx.lastReview));
  }
  if (config.graphContext && ctx.graph) {
    parts.push(graphPositionBlock(ctx.graph));
  }
  return parts.join('\n\n---\n\n');
}

/** Run one fresh agent turn through whichever engine is selected. */
export function agentJob(config: AgentJobConfig): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    const label = config.label ?? config.agent?.name ?? 'agent';
    // Per-job `ground` wins over the run-level default (`RunOptions.ground`) —
    // including an explicit `false`, which opts this job out. Every consumption
    // below reads this local, never `config.ground`, because a truthiness check
    // on the config alone cannot tell `false` from `undefined`.
    const ground =
      config.ground !== undefined ? config.ground : ctx.groundDefault;
    const defaultTimeoutMs = config.timeoutMs ?? ctx.timeoutMs;
    const defaultTimeoutGraceMs = config.timeoutGraceMs ?? ctx.timeoutGraceMs;
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label,
      timeoutMs: defaultTimeoutMs,
    });

    const userPrompt =
      typeof config.prompt === 'function'
        ? await config.prompt(ctx)
        : config.prompt;
    const contextualPrompt = withOperationalContext(ctx, userPrompt, config);
    // System precedence: an explicit `system` overrides the agent's (persona + skills).
    const system =
      config.system !== undefined
        ? typeof config.system === 'function'
          ? config.system(ctx)
          : config.system
        : config.agent
          ? resolveSystem(config.agent)
          : undefined;

    // Hoisted so the reply scrub below can strike the same injected values the
    // engine subprocess was handed.
    const env = resolveEnv(ctx, config.env);
    const toolUses = new Map<string, number>();
    const fallbacks = config.fallback
      ? Array.isArray(config.fallback)
        ? config.fallback
        : [config.fallback]
      : [];
    const routes: AgentRoute[] = [
      {
        engine: config.engine,
        model: config.model ?? config.agent?.model,
        ground,
        timeoutMs: defaultTimeoutMs,
        timeoutGraceMs: defaultTimeoutGraceMs,
      },
      ...fallbacks,
    ];
    const fallbackOn = new Set<LoopErrorCode>(
      config.fallbackOn ?? ['RATE_LIMIT', 'QUOTA'],
    );
    let result: AgentResult | undefined;
    let successfulGround = ground;
    for (let i = 0; i < routes.length; i += 1) {
      const route = routes[i]!;
      const routeGround = route.ground !== undefined ? route.ground : ground;
      const routeModel = route.model;
      const timeoutMs = route.timeoutMs ?? defaultTimeoutMs;
      const timeoutGraceMs = route.timeoutGraceMs ?? defaultTimeoutGraceMs;
      try {
        assertBudget(ctx); // refuse to spend past the run's token budget
        const prompt = routeGround
          ? await withGrounding(
              ctx,
              contextualPrompt,
              routeGround,
              route.engine ?? config.engine,
              routeModel,
            )
          : contextualPrompt;
        const engine = ctx.resolveEngine(route.engine ?? config.engine);
        result = await engine.run(
          {
            prompt,
            system,
            model: routeModel,
            maxTokens: config.maxTokens,
            allowedTools: config.allowedTools ?? config.agent?.tools,
            leaf: config.leaf ?? config.agent?.leaf,
            cwd: config.cwd ?? ctx.workspace.dir,
            timeoutMs,
            timeoutGraceMs,
            env,
            loops: loopsRequestMeta(ctx, label),
          },
          (e) => {
            const ts = Date.now();
            switch (e.type) {
              case 'text':
                ctx.emit({ kind: 'engine:text', ts, path, delta: e.delta });
                break;
              case 'thinking':
                ctx.emit({ kind: 'engine:thinking', ts, path, delta: e.delta });
                break;
              case 'tool':
                if (e.phase === 'use')
                  toolUses.set(e.name, (toolUses.get(e.name) ?? 0) + 1);
                ctx.emit({
                  kind: 'engine:tool',
                  ts,
                  path,
                  name: e.name,
                  phase: e.phase,
                });
                break;
              case 'usage':
                ctx.emit({
                  kind: 'engine:usage',
                  ts,
                  path,
                  model: e.model,
                  usage: e.usage,
                });
                break;
            }
          },
          ctx.signal,
        );
        successfulGround = routeGround;
        break;
      } catch (e) {
        const error = LoopError.from(e, {
          code: ctx.signal.aborted ? 'ABORTED' : 'ENGINE',
          phase: 'body',
          path: ctx.path,
          iteration: ctx.iteration,
        });
        if (
          i < routes.length - 1 &&
          !ctx.signal.aborted &&
          fallbackOn.has(error.code)
        ) {
          ctx.log(
            `${label} primary route hit ${error.code}; trying fallback route ${i + 2}`,
            'warn',
          );
          continue;
        }
        ctx.emit({
          kind: 'error',
          ts: Date.now(),
          path,
          message: error.message,
          code: error.code,
        });
        const outcome: Outcome = {
          status: ctx.signal.aborted ? 'aborted' : 'fail',
          summary: error.message,
          error,
        };
        ctx.emit({
          kind: 'job:end',
          ts: Date.now(),
          path,
          label,
          outcome,
        });
        return outcome;
      }
    }
    if (!result)
      throw new LoopError({
        code: 'ENGINE',
        phase: 'body',
        message: `${label} produced no engine result`,
      });

    // The reply is the largest capture sink in the library: it becomes the
    // emitted outcome (summary + full data) and from there every persisted
    // record (events.jsonl, status.json, --record files), and via the ledger
    // it reaches commit bodies (persisted in git). An agent handed a pinned
    // credential often echoes it, so the reply gets the same scrub as every
    // other capture path — once, up front, before anything consumes it.
    const text = scrubCapture(result.text, env);

    // Parsed once here; the auto-capture and the `outcome` mapper share it.
    const parts = parseHandoff(text);

    // Auto-capture: when memory is on, the harness records the turn from the agent's
    // own reply, without relying on it writing a side file. The reply is split at the
    // handoff marker: the working log (before) goes to `ledger.md`, the structured
    // handoff (after) to `prompt.md`. With no marker, the whole reply is working log.
    if (successfulGround) {
      appendLedger(ctx.workspace, {
        label,
        iteration: ctx.iteration,
        text: parts.work,
        tools: summariseTools(toolUses),
      });
      if (parts.handoff) appendPrompt(ctx.workspace, parts.handoff);
    }

    const outcome = config.outcome
      ? await config.outcome(text, ctx, parts)
      : TERMINAL(text);
    const finalOutcome = result.late && outcome.late !== true
      ? { ...outcome, late: true }
      : outcome;
    ctx.emit({
      kind: 'job:end',
      ts: Date.now(),
      path,
      label,
      outcome: finalOutcome,
    });
    return finalOutcome;
  };

  return setMeta(job, {
    kind: 'agent',
    name: config.label ?? config.agent?.name ?? 'agent',
    // Build-time shape: only the job's own config is visible here. A run-level
    // default (`RunOptions.ground`) is applied at run time via the context, so
    // it does not show in describe output.
    ground: !!config.ground,
    contract: agentContract(config.agent),
  });
}

export interface CommitJobConfig {
  label?: string;
  /** Conventional-commit subject, or a function of context + last outcome. */
  subject:
    | string
    | ((ctx: JobContext, last: Outcome | undefined) => string | Promise<string>);
  /**
   * The structured commit body ("the way"). Precedence when composing it:
   *   1. this `body` (an explicit override, a string or function), else
   *   2. the scratch files: the handoff (`prompt.md`) plus a compacted working log
   *      (`ledger.md`), which capture the why across a long unit of work and across
   *      fanned-out sub-agents, else
   *   3. a default composed from the last outcome (the floor).
   * Set `body` only to override the scratch files.
   */
  body?:
    | string
    | ((ctx: JobContext, last: Outcome | undefined) => string | Promise<string>);
  /** Model for the (cheap) ledger-compaction call. A cheap one is plenty. */
  compactModel?: string;
  /** Stage every change before committing (default true). */
  stageAll?: boolean;
  /** Commit even with nothing staged (default false → a no-op `pass`). */
  allowEmpty?: boolean;
}

/**
 * Compose the default "way" from an outcome — the deterministic floor that
 * guarantees every iteration leaves a structured trace even when the agent
 * writes nothing itself. Pass `body` to override.
 */
function composeWay(ctx: JobContext, last: Outcome | undefined): string {
  const sections: string[] = [];
  const head: string[] = [];
  if (ctx.iteration) head.push(`iteration: ${ctx.iteration}`);
  if (last?.status) head.push(`status: ${last.status}`);
  if (typeof last?.confidence === 'number')
    head.push(`confidence: ${last.confidence.toFixed(2)}`);
  if (head.length) sections.push(`## Outcome\n${head.join('\n')}`);
  if (last?.summary) sections.push(`## Summary\n${last.summary.trim()}`);
  if (ctx.lastReview?.summary)
    sections.push(`## Next\n${ctx.lastReview.summary.trim()}`);
  return sections.join('\n\n');
}

/**
 * Commit the workspace: write the structured body ("the way") plus the staged
 * diff onto the work branch. This is the loop's memory: the next fresh context
 * reads these commits back. The body is composed from the scratch files (the
 * handoff plus a compacted working log agents accrued as they worked), falling
 * back to the outcome floor, so the why survives context decay and fan-out. Both
 * scratch files are cleared once the commit lands. Engine-agnostic; it only
 * touches `ctx.workspace.dir` and git. A non-repo workspace fails with a
 * non-retryable CONFIG error rather than silently dropping the work's record.
 */
export function commitJob(config: CommitJobConfig): Job {
  return async (ctx) => {
    const label = config.label ?? 'commit';
    const path = [...ctx.path];
    const cwd = ctx.workspace.dir;
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label,
      timeoutMs: ctx.timeoutMs,
    });
    try {
      if (!(await isRepo({ cwd, signal: ctx.signal }))) {
        throw new LoopError({
          code: 'CONFIG',
          message: `commitJob "${label}" requires a git repository (cwd: ${cwd})`,
        });
      }
      const last = ctx.lastOutcome;
      const subject =
        typeof config.subject === 'function'
          ? await config.subject(ctx, last)
          : config.subject;
      // The body, in precedence order: explicit override, then the scratch files
      // (handoff + compacted working log, the accumulated why), then the outcome
      // floor.
      const body =
        config.body !== undefined
          ? typeof config.body === 'function'
            ? await config.body(ctx, last)
            : config.body
          : (await composeCommitBody(ctx, ctx.workspace, {
              model: config.compactModel,
            })) || composeWay(ctx, last);
      if (config.stageAll ?? true) {
        ensureIgnored(ctx.workspace); // never stage the scratch files
        await stageAll({ cwd, signal: ctx.signal });
      }
      const sha = await commit(
        { subject, body, allowEmpty: config.allowEmpty },
        { cwd, signal: ctx.signal },
      );
      // Committed, so reset: both scratch files' job ends at the commit.
      if (sha) {
        resetPrompt(ctx.workspace);
        resetLedger(ctx.workspace);
      }
      const outcome: Outcome = sha
        ? {
            status: 'pass',
            summary: `committed ${sha.slice(0, 7)}: ${subject}`,
            data: { sha },
          }
        : { status: 'pass', summary: 'nothing to commit', data: { sha: null } };
      ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
      return outcome;
    } catch (e) {
      const error = LoopError.from(e, {
        code: 'BODY',
        phase: 'body',
        path: ctx.path,
        iteration: ctx.iteration,
      });
      ctx.emit({
        kind: 'error',
        ts: Date.now(),
        path,
        message: error.message,
        code: error.code,
      });
      const outcome: Outcome = { status: 'fail', summary: error.message, error };
      ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
      return outcome;
    }
  };
}

export { kickback, revisionRequest };

/** A deterministic step from a plain function — for glue, checks, side effects. */
export function fnJob(
  label: string,
  fn: (ctx: JobContext) => Outcome | Promise<Outcome>,
): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label,
      timeoutMs: ctx.timeoutMs,
    });
    let outcome: Outcome;
    try {
      outcome = await fn(ctx);
    } catch (e) {
      const error = LoopError.from(e, {
        code: 'BODY',
        phase: 'body',
        path: ctx.path,
        iteration: ctx.iteration,
      });
      outcome = { status: 'fail', summary: error.message, error };
      ctx.emit({
        kind: 'error',
        ts: Date.now(),
        path,
        message: error.message,
        code: error.code,
      });
    }
    ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
    return outcome;
  };

  return setMeta(job, { kind: 'fn', name: label });
}

function validateProofArtifact(name: string, artifact: ProofArtifact): void {
  if (!artifact || typeof artifact !== 'object') {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" returned no artifact descriptor`,
    });
  }
  if (!['html', 'image', 'markdown', 'table', 'json'].includes(artifact.kind)) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" returned unsupported kind "${String(artifact.kind)}"`,
    });
  }
  const hasPath = typeof artifact.path === 'string' && artifact.path.trim() !== '';
  const hasData = artifact.data !== undefined;
  if (hasPath === hasData) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" must return exactly one of path or data`,
    });
  }
  if (artifact.data !== undefined && !isJsonValue(artifact.data)) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" data must be JSON-serializable`,
    });
  }
  if (artifact.meta !== undefined && !isJsonValue(artifact.meta)) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `prove "${name}" meta must be JSON-serializable`,
    });
  }
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value))
        return value.every((item) => isJsonValue(item, seen));
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.values(value).every((item) => isJsonValue(item, seen));
    default:
      return false;
  }
}

export function prove(name: string, producer: ProofProducer): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    ctx.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label: name,
      timeoutMs: ctx.timeoutMs,
    });
    let outcome: Outcome;
    try {
      const artifact = await producer(ctx);
      validateProofArtifact(name, artifact);
      if (artifact.path) {
        const artifactPath = isAbsolute(artifact.path)
          ? artifact.path
          : resolve(ctx.workspace.dir, artifact.path);
        if (!existsSync(artifactPath)) {
          throw new LoopError({
            code: 'VALIDATION',
            message: `prove "${name}" path does not exist: ${artifact.path}`,
          });
        }
      }
      ctx.emit({ kind: 'proof', ts: Date.now(), path, name, artifact });
      outcome = {
        status: 'pass',
        summary: `proof registered: ${artifact.title ?? name}`,
        data: { proof: artifact },
      };
    } catch (e) {
      const error = LoopError.from(e, {
        code: 'VALIDATION',
        phase: 'body',
        path,
        iteration: ctx.iteration,
      });
      outcome = { status: 'fail', summary: error.message, error };
      ctx.emit({
        kind: 'error',
        ts: Date.now(),
        path,
        message: error.message,
        code: error.code,
      });
    }
    ctx.emit({ kind: 'job:end', ts: Date.now(), path, label: name, outcome });
    return outcome;
  };

  return setMeta(job, { kind: 'prove', name });
}
