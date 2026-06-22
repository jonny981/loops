/**
 * Job builders. A `Job` is the unit of work; these are the common shapes.
 * The agent launch (`agentJob`) is deliberately provider-agnostic: it only
 * ever calls `Engine.run`, so it knows nothing about Claude, the CLI, an SDK,
 * an HTTP API, or any framework — swap the engine and the same job runs.
 */

import type { Outcome, Job, JobContext } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { LoopError } from './errors.ts';

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
  cwd?: string;
  timeoutMs?: number;
  /**
   * Map the agent's raw text into an `Outcome`. Default: `pass`, with the text
   * as the summary. Return `fail` to keep an enclosing loop going.
   */
  outcome?: (text: string, ctx: JobContext) => Outcome | Promise<Outcome>;
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
    const prompt =
      typeof config.prompt === 'function'
        ? await config.prompt(ctx)
        : config.prompt;
    const system =
      typeof config.system === 'function' ? config.system(ctx) : config.system;

    let result;
    try {
      result = await engine.run(
        {
          prompt,
          system,
          model: config.model,
          maxTokens: config.maxTokens,
          allowedTools: config.allowedTools,
          cwd: config.cwd,
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
