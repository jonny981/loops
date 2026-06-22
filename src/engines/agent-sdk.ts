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
