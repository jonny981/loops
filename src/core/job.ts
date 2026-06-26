/**
 * Job builders. A `Job` is the unit of work; these are the common shapes.
 * The agent launch (`agentJob`) is deliberately provider-agnostic: it only
 * ever calls `Engine.run`, so it knows nothing about Claude, the CLI, an SDK,
 * an HTTP API, or any framework — swap the engine and the same job runs.
 */

import type { Outcome, Job, JobContext } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { LoopError } from './errors.ts';
import { assertBudget } from './budget.ts';
import { isRepo, stageAll, commit } from './git.ts';
import {
  appendLedger,
  readLedger,
  readPrompt,
  resetLedger,
  resetPrompt,
  ensureIgnored,
  ledgerPath,
  promptPath,
} from './draft.ts';
import { composeCommitBody } from './consolidate.ts';
import { groundingText, retrieveLedger } from './ground.ts';
import { resolveSystem, type AgentDef } from './agent.ts';

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
  /** Working dir for the turn. Default: the workspace dir (the worktree). */
  cwd?: string;
  timeoutMs?: number;
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
   * as the summary. Return `fail` to keep an enclosing loop going.
   */
  outcome?: (text: string, ctx: JobContext) => Outcome | Promise<Outcome>;
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
  retrieve?: boolean | { candidates?: number; model?: string };
}

/** The "leave memory behind" instruction, naming this workspace's scratch files.
 *  Lean on purpose: it rides on every grounded turn, so it stays a few tight lines —
 *  the binding signals (the commit log, working memory, handoff) carry the content. */
function recordBlock(ctx: JobContext): string {
  return (
    `## Leave memory for the next agent\n` +
    `Two gitignored \`.loops/\` files carry the work forward — write to them as you go:\n` +
    `- \`${ledgerPath(ctx.workspace)}\` — working notes (what you try and find; the harness also auto-records each turn).\n` +
    `- \`${promptPath(ctx.workspace)}\` — the handoff: the why, what you ruled out, the constraints, and what is left. ` +
    `It seeds the next agent's prompt and becomes the commit body, so write it so they don't repeat your dead ends or break your decisions.`
  );
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
): Promise<string> {
  const opts: GroundConfig = typeof ground === 'object' ? ground : {};
  const parts: string[] = [];

  const committed = opts.retrieve
    ? await retrieveLedger(ctx, {
        intent: userPrompt,
        max: opts.max,
        bodyChars: opts.bodyChars,
        candidates:
          typeof opts.retrieve === 'object' ? opts.retrieve.candidates : undefined,
        model:
          typeof opts.retrieve === 'object' ? opts.retrieve.model : undefined,
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

  if (opts.recordInstruction !== false) parts.push(recordBlock(ctx));

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

/** Run one fresh agent turn through whichever engine is selected. */
export function agentJob(config: AgentJobConfig): Job {
  return async (ctx) => {
    const path = [...ctx.path];
    const label = config.label ?? config.agent?.name ?? 'agent';
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });

    const engine = ctx.resolveEngine(config.engine);
    const userPrompt =
      typeof config.prompt === 'function'
        ? await config.prompt(ctx)
        : config.prompt;
    const prompt = config.ground
      ? await withGrounding(ctx, userPrompt, config.ground)
      : userPrompt;
    // System precedence: an explicit `system` overrides the agent's (persona + skills).
    const system =
      config.system !== undefined
        ? typeof config.system === 'function'
          ? config.system(ctx)
          : config.system
        : config.agent
          ? resolveSystem(config.agent)
          : undefined;

    let result;
    const toolUses = new Map<string, number>();
    try {
      assertBudget(ctx); // refuse to spend past the run's token budget
      result = await engine.run(
        {
          prompt,
          system,
          model: config.model ?? config.agent?.model,
          maxTokens: config.maxTokens,
          allowedTools: config.allowedTools ?? config.agent?.tools,
          leaf: config.leaf ?? config.agent?.leaf,
          cwd: config.cwd ?? ctx.workspace.dir,
          timeoutMs: config.timeoutMs,
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
    } catch (e) {
      const error = LoopError.from(e, {
        code: ctx.signal.aborted ? 'ABORTED' : 'ENGINE',
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

    // Auto-capture: when memory is on, the harness records the turn into the
    // working memory itself — the agent's reasoning plus what it did — so the why
    // survives even if a single agent forgets to log it (the unskippable suspenders
    // to the recordInstruction's belt).
    if (config.ground)
      appendLedger(ctx.workspace, {
        label,
        iteration: ctx.iteration,
        text: result.text,
        tools: summariseTools(toolUses),
      });

    const outcome = config.outcome
      ? await config.outcome(result.text, ctx)
      : TERMINAL(result.text);
    ctx.emit({
      kind: 'job:end',
      ts: Date.now(),
      path,
      label,
      outcome,
    });
    return outcome;
  };
}

export interface CommitJobConfig {
  label?: string;
  /** Conventional-commit subject, or a function of context + last outcome. */
  subject:
    | string
    | ((ctx: JobContext, last: Outcome | undefined) => string | Promise<string>);
  /**
   * The "way" — the structured commit body. Precedence when composing it:
   *   1. this `body` (an explicit override — a string or function), else
   *   2. the scratch files: the handoff (`prompt.md`) plus a compacted working log
   *      (`ledger.md`) — the trusted source, capturing the why as it happens across
   *      a long unit of work and across fanned-out sub-agents, else
   *   3. a default composed from the last outcome (the floor).
   * Set `body` only to override the scratch files.
   */
  body?:
    | string
    | ((ctx: JobContext, last: Outcome | undefined) => string | Promise<string>);
  /** Model for the (cheap) ledger-compaction call. A small one is plenty. */
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
 * Commit the workspace — write the "way" (a structured body) welded to the
 * "what" (the staged diff) onto the work branch. This is the loop's memory: the
 * next fresh context reads these commits back. The body is composed from the
 * scratch files (the handoff plus a compacted working log agents accrued as they
 * worked), falling back to the outcome floor — so the rich why survives context
 * decay and fan-out. Both scratch files are cleared once the commit lands.
 * Engine-agnostic; it only touches `ctx.workspace.dir` and git. A non-repo
 * workspace fails loudly (a non-retryable CONFIG error) rather than silently
 * dropping the work's record.
 */
export function commitJob(config: CommitJobConfig): Job {
  return async (ctx) => {
    const label = config.label ?? 'commit';
    const path = [...ctx.path];
    const cwd = ctx.workspace.dir;
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
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
      // The way, in precedence order: explicit override, then the scratch files
      // (handoff + compacted working log, the trusted accumulated why), then the
      // outcome floor.
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
      // Crystallise, then reset: both scratch files' job ends at the commit.
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

/**
 * Build an `Outcome` that sends work back to an earlier dag node — real-team
 * feedback ("marketing found the contract drifted; re-run engineering"). Return
 * it from any job or `agentJob({ outcome })` mapper. The enclosing `dag` re-runs
 * `to` and its dependents with `reason` threaded in as `lastReview`, bounded by
 * `DagConfig.maxKickbacks`. Defaults to a `fail` status, so an unresolved
 * kickback (budget spent) leaves the dag failing honestly; override via `over`
 * (e.g. `{ status: 'pass' }`) when the kicking node's own work is fine and it is
 * only requesting an upstream revision.
 */
export function kickback(
  to: string,
  reason: string,
  over?: Partial<Outcome>,
): Outcome {
  return {
    status: 'fail',
    summary: reason,
    ...over,
    kickback: { to, reason },
  };
}

/** A deterministic step from a plain function — for glue, checks, side effects. */
export function fnJob(
  label: string,
  fn: (ctx: JobContext) => Outcome | Promise<Outcome>,
): Job {
  return async (ctx) => {
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
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
}
