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
import { readDraft, resetDraft, ensureIgnored, draftPath } from './draft.ts';
import { groundingText } from './ground.ts';

export interface AgentJobConfig {
  label: string;
  /** The prompt, or a function of the context (e.g. include the iteration). */
  prompt: string | ((ctx: JobContext) => string | Promise<string>);
  system?: string | ((ctx: JobContext) => string);
  /** Engine override: a registered name, your own `Engine`, or the default. */
  engine?: EngineRef;
  /** Bare model id — passed straight through to the engine. */
  model?: string;
  maxTokens?: number;
  allowedTools?: string[];
  /** Working dir for the turn. Default: the workspace dir (the worktree). */
  cwd?: string;
  timeoutMs?: number;
  /**
   * Ground the turn in memory before it works: prepend the branch-local ledger
   * (recent committed milestones) and the live draft (this run's accumulated
   * why), and tell the agent where to record its own reasoning. `true` uses
   * defaults; an object tunes the reach. This is how a fresh context stops
   * repeating what earlier iterations already tried.
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
  /** Include the live draft (this run's why-so-far). Default true. */
  includeDraft?: boolean;
  /** Tell the agent to append its reasoning to the draft. Default true. */
  recordInstruction?: boolean;
}

/**
 * Build the grounding preamble: the committed ledger (past milestones), the live
 * draft (this run's why-so-far), and an instruction to record the why — then the
 * caller's prompt. Empty parts are dropped, so a first turn on a fresh branch is
 * just the prompt.
 */
async function withGrounding(
  ctx: JobContext,
  userPrompt: string,
  ground: boolean | GroundConfig,
): Promise<string> {
  const opts: GroundConfig = typeof ground === 'object' ? ground : {};
  const parts: string[] = [];

  const ledger = await groundingText(ctx.workspace, {
    max: opts.max,
    bodyChars: opts.bodyChars,
    signal: ctx.signal,
  });
  if (ledger) parts.push(ledger);

  if (opts.includeDraft !== false) {
    const draft = readDraft(ctx.workspace);
    if (draft)
      parts.push(`## Work in progress this run (the draft — why so far)\n\n${draft}`);
  }

  if (opts.recordInstruction !== false) {
    parts.push(
      `## Record your reasoning\n` +
        `As you work, append the why (intent, alternatives, constraints, what ` +
        `changed) to \`${draftPath(ctx.workspace)}\`. It becomes the commit body ` +
        `at the next milestone.`,
    );
  }

  parts.push(userPrompt);
  return parts.join('\n\n---\n\n');
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
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label: config.label });

    const engine = ctx.resolveEngine(config.engine);
    const userPrompt =
      typeof config.prompt === 'function'
        ? await config.prompt(ctx)
        : config.prompt;
    const prompt = config.ground
      ? await withGrounding(ctx, userPrompt, config.ground)
      : userPrompt;
    const system =
      typeof config.system === 'function' ? config.system(ctx) : config.system;

    let result;
    try {
      assertBudget(ctx); // refuse to spend past the run's token budget
      result = await engine.run(
        {
          prompt,
          system,
          model: config.model,
          maxTokens: config.maxTokens,
          allowedTools: config.allowedTools,
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
        label: config.label,
        outcome,
      });
      return outcome;
    }

    const outcome = config.outcome
      ? await config.outcome(result.text, ctx)
      : TERMINAL(result.text);
    ctx.emit({
      kind: 'job:end',
      ts: Date.now(),
      path,
      label: config.label,
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
   *   2. the workspace draft (the staged commit body agents appended to), else
   *   3. a default composed from the last outcome (the floor).
   * The draft is the trusted source: it captures the why as it happens, across a
   * long unit of work and across fanned-out sub-agents. Set `body` only to
   * override it.
   */
  body?:
    | string
    | ((ctx: JobContext, last: Outcome | undefined) => string | Promise<string>);
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
 * workspace draft (the staged commit body agents appended to as they worked),
 * falling back to the outcome floor — so the rich why survives context decay and
 * fan-out. The draft is cleared once the commit lands. Engine-agnostic; it only
 * touches `ctx.workspace.dir` and git. A non-repo workspace fails loudly (a
 * non-retryable CONFIG error) rather than silently dropping the work's record.
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
      // The way, in precedence order: explicit override, then the draft (the
      // trusted accumulated why), then the outcome floor.
      const body =
        config.body !== undefined
          ? typeof config.body === 'function'
            ? await config.body(ctx, last)
            : config.body
          : readDraft(ctx.workspace) || composeWay(ctx, last);
      if (config.stageAll ?? true) {
        ensureIgnored(ctx.workspace); // never stage the draft
        await stageAll({ cwd, signal: ctx.signal });
      }
      const sha = await commit(
        { subject, body, allowEmpty: config.allowEmpty },
        { cwd, signal: ctx.signal },
      );
      // Crystallise, then reset: the draft's job ends when it becomes a commit.
      if (sha) resetDraft(ctx.workspace);
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
