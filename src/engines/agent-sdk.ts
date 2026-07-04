/**
 * Engine adapter: the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 * Each `run` is a fresh `query()`, giving a clean context per loop iteration.
 * Uses the host's Claude Code auth, so it needs no API key.
 */

import pTimeout from 'p-timeout';

// Type-only, so the SDK import stays lazy at runtime. Pinning the hooks value
// to the SDK's own `Options['hooks']` makes an SDK shape drift fail typecheck
// instead of silently at runtime (the options object itself is a cast Record).
import type { Options as SdkOptions } from '@anthropic-ai/claude-agent-sdk';

import {
  SUBAGENT_TOOLS,
  toolPacer,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
  type EngineOptions,
} from './engine.ts';
import { mapMessage, newAccumulator } from './message-map.ts';
import { LoopError } from '../core/errors.ts';
import { scrubCapture } from '../core/redact.ts';

/**
 * Best-effort classification of an Agent SDK error into a provider-limit
 * `LoopError`, or `undefined` to fall through to the generic ENGINE mapping.
 * The SDK exposes limit state in a few shapes (a thrown error message, an
 * `error` field carrying an `SDKAssistantMessageError` string, and a
 * `rate_limit_info.resetsAt` epoch). We read defensively rather than depend on
 * an exact internal shape:
 *   - a rate-limit / overloaded signal → RATE_LIMIT (resets on its own).
 *   - a billing / usage / credits signal → QUOTA. A `resetsAt` (when present)
 *     makes it auto-waitable; otherwise QUOTA has no reset.
 */
function classifySdkLimit(
  error: unknown,
  env?: Record<string, string>,
): LoopError | undefined {
  const err = (error ?? {}) as Record<string, unknown>;
  const tag = typeof err.error === 'string' ? err.error : '';
  // The SDK's message shapes are outside this repo's control and the request's
  // env was handed to its subprocess, so scrub like the sibling CLI engines do.
  const message = scrubCapture(
    error instanceof Error ? error.message : String(error),
    env,
  );
  const haystack = `${tag} ${message}`.toLowerCase();

  const info = (err.rate_limit_info ?? {}) as Record<string, unknown>;
  const resetAt =
    typeof info.resetsAt === 'number'
      ? info.resetsAt
      : typeof info.overageResetsAt === 'number'
        ? info.overageResetsAt
        : undefined;

  const isUsage =
    tag === 'billing_error' ||
    info.errorCode === 'credits_required' ||
    /billing|credit|usage limit|quota/.test(haystack);
  if (isUsage) {
    return new LoopError({
      code: 'QUOTA',
      phase: 'engine',
      message: `agent-sdk usage/billing limit: ${message}`,
      cause: error,
      resetAt,
    });
  }
  const isRate =
    tag === 'rate_limit' ||
    tag === 'overloaded' ||
    /rate limit|rate-limit|too many requests|overloaded/.test(haystack);
  if (isRate) {
    return new LoopError({
      code: 'RATE_LIMIT',
      phase: 'engine',
      message: `agent-sdk rate limited: ${message}`,
      cause: error,
      resetAt,
    });
  }
  return undefined;
}

export class AgentSdkEngine implements Engine {
  readonly name = 'agent-sdk';
  /** One pacer per engine instance, so the interval spans turns, not just one. */
  private readonly pace?: () => Promise<void>;

  constructor(private readonly opts: EngineOptions = {}) {
    if (opts.minToolIntervalMs && opts.minToolIntervalMs > 0)
      this.pace = toolPacer(opts.minToolIntervalMs);
  }

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    // Lazy import so installs/runs that never touch this engine don't pay for it.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const acc = newAccumulator(
      req.model ?? this.opts.defaultModel ?? 'unknown',
    );
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', onAbort, { once: true });

    // Pacing hook only. An empty-object return makes no permission decision,
    // so the SDK's permission model is untouched. PreToolUse callbacks are
    // awaited before each tool executes; that in-process mediation is what
    // makes `minToolIntervalMs` work here and nowhere else.
    const pace = this.pace;
    const hooks: SdkOptions['hooks'] = pace
      ? {
          PreToolUse: [
            {
              hooks: [
                async () => {
                  await pace();
                  return {};
                },
              ],
            },
          ],
        }
      : undefined;

    // The SDK option surface drifts across versions; cast at this boundary.
    const options = {
      model: req.model ?? this.opts.defaultModel,
      systemPrompt: req.system,
      cwd: req.cwd,
      allowedTools: req.allowedTools,
      // A leaf agent may not spawn sub-agents, so disallow the spawn tool.
      disallowedTools: req.leaf ? SUBAGENT_TOOLS : undefined,
      // The SDK's `env` REPLACES the subprocess environment entirely, the
      // opposite of execa's merge semantics, so spread `process.env` under the
      // request's vars to keep merge-over-parent parity with the CLI engines.
      env: req.env ? { ...process.env, ...req.env } : undefined,
      permissionMode: this.opts.permissionMode,
      ...(hooks ? { hooks } : {}),
      includePartialMessages: true,
      abortController: abort,
    } as Record<string, unknown>;

    try {
      const response = query({
        prompt: req.prompt,
        options,
      } as never) as AsyncIterable<unknown>;
      const consume = (async () => {
        for await (const message of response) mapMessage(message, acc, onEvent);
      })();
      await (req.timeoutMs
        ? pTimeout(consume, { milliseconds: req.timeoutMs })
        : consume);
    } catch (e) {
      if (signal.aborted)
        throw new LoopError({
          code: 'ABORTED',
          phase: 'engine',
          message: 'agent-sdk run aborted',
        });
      const limit = classifySdkLimit(e, req.env);
      if (limit) throw limit;
      if (e instanceof LoopError) throw e;
      throw new LoopError({
        code: 'ENGINE',
        phase: 'engine',
        message: scrubCapture(
          e instanceof Error ? e.message : String(e),
          req.env,
        ),
        cause: e,
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    onEvent({ type: 'usage', usage: acc.usage, model: acc.model });
    return {
      text: acc.text,
      usage: acc.usage,
      model: acc.model,
      stopReason: acc.stopReason,
    };
  }
}
