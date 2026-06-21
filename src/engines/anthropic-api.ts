/**
 * Engine adapter: the raw Anthropic Messages API (`@anthropic-ai/sdk`). Lowest
 * level, token-level streaming, and the cheapest path for small validator
 * models. Transient 429/5xx/connection errors are retried with backoff via
 * `p-retry`; non-retryable errors abort immediately.
 *
 * Needs `ANTHROPIC_API_KEY` (or `EngineOptions.apiKey`). Constructed lazily by
 * the registry, so other engines work without a key present.
 */

import pRetry, { AbortError } from 'p-retry';

import type { AgentRequest, AgentResult, Engine, EngineEventSink, EngineOptions } from './engine.ts';
import { LoopError } from '../core/errors.ts';

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  const name = (error as { name?: string })?.name ?? '';
  return /connection|timeout|socket|network/i.test(name);
}

export class AnthropicApiEngine implements Engine {
  readonly name = 'anthropic-api';
  // Typed loosely to avoid a hard structural dep on the SDK's class shape.
  private clientPromise?: Promise<{ messages: { stream: (...a: unknown[]) => never } }>;

  constructor(private readonly opts: EngineOptions = {}) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import('@anthropic-ai/sdk').then((m) => {
        const Anthropic = m.default;
        const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
        return new Anthropic({ apiKey }) as never;
      });
    }
    return this.clientPromise;
  }

  async run(req: AgentRequest, onEvent: EngineEventSink, signal: AbortSignal): Promise<AgentResult> {
    const client = await this.client();
    const model = req.model ?? this.opts.defaultModel ?? 'claude-haiku-4-5-20251001';
    const maxTokens = req.maxTokens ?? 1024;

    const attempt = async () => {
      try {
        const stream = (client.messages.stream as unknown as (body: unknown, opts: unknown) => {
          on: (event: 'text', cb: (delta: string) => void) => void;
          finalMessage: () => Promise<{
            content: { type: string; text?: string }[];
            usage: { input_tokens: number; output_tokens: number };
            stop_reason: string | null;
          }>;
        })(
          {
            model,
            max_tokens: maxTokens,
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
          },
          { signal },
        );
        stream.on('text', (delta) => onEvent({ type: 'text', delta }));
        return await stream.finalMessage();
      } catch (e) {
        if (signal.aborted || !isRetryable(e)) {
          throw new AbortError(e instanceof Error ? e : new Error(String(e)));
        }
        throw e;
      }
    };

    let message;
    try {
      message = await pRetry(attempt, { retries: 2, minTimeout: 500, factor: 2 });
    } catch (e) {
      if (signal.aborted) throw new LoopError({ code: 'ABORTED', phase: 'engine', message: 'anthropic-api run aborted' });
      throw LoopError.from(e, { code: 'ENGINE', phase: 'engine' });
    }

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    onEvent({ type: 'usage', usage, model });
    return { text, usage, model, stopReason: message.stop_reason ?? undefined, raw: message };
  }
}
