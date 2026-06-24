/**
 * Engine adapter: the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 * Each `run` is a fresh `query()` — a clean context per loop iteration, which
 * is the whole point. Uses the host's Claude Code auth, so it needs no API key.
 */

import pTimeout from 'p-timeout';

import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
  EngineOptions,
} from './engine.ts';
import { mapMessage, newAccumulator } from './message-map.ts';
import { LoopError } from '../core/errors.ts';

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
function classifySdkLimit(error: unknown): LoopError | undefined {
  const err = (error ?? {}) as Record<string, unknown>;
  const tag = typeof err.error === 'string' ? err.error : '';
  const message = error instanceof Error ? error.message : String(error);
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
  constructor(private readonly opts: EngineOptions = {}) {}

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

    // The SDK option surface drifts across versions; cast at this boundary.
    const options = {
      model: req.model ?? this.opts.defaultModel,
      systemPrompt: req.system,
      cwd: req.cwd,
      allowedTools: req.allowedTools,
      permissionMode: this.opts.permissionMode,
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
      const limit = classifySdkLimit(e);
      if (limit) throw limit;
      throw LoopError.from(e, { code: 'ENGINE', phase: 'engine' });
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
