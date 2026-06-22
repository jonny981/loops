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

import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
  EngineOptions,
} from './engine.ts';
import { LoopError } from '../core/errors.ts';

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  const name = (error as { name?: string })?.name ?? '';
  return /connection|timeout|socket|network/i.test(name);
}

/** The slice of the Anthropic SDK this adapter actually consumes. */
interface FinalMessage {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
}
interface MessageStreamLike {
  on(event: 'text', cb: (delta: string) => void): void;
  finalMessage(): Promise<FinalMessage>;
}
interface MessagesClientLike {
  messages: {
    stream(body: unknown, opts?: { signal?: AbortSignal }): MessageStreamLike;
  };
}

export class AnthropicApiEngine implements Engine {
  readonly name = 'anthropic-api';
  private clientPromise?: Promise<MessagesClientLike>;

  constructor(private readonly opts: EngineOptions = {}) {}

  private async client(): Promise<MessagesClientLike> {
    if (!this.clientPromise) {
      const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // Fail fast with an actionable, non-retryable error instead of leaking
        // the SDK's internal "could not resolve authentication method" message.
        throw new LoopError({
          code: 'CONFIG',
          phase: 'engine',
          retryable: false,
          message:
            'the anthropic-api engine needs an API key — set ANTHROPIC_API_KEY or pass --api-key (or use the agent-sdk / claude-cli engine, which use host Claude auth)',
        });
      }
      this.clientPromise = import('@anthropic-ai/sdk').then(
        // One honest cast at the boundary to the structural shape we consume.
        (m) => new m.default({ apiKey }) as unknown as MessagesClientLike,
      );
    }
    return this.clientPromise;
  }

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const client = await this.client();
    const model =
      req.model ?? this.opts.defaultModel ?? 'claude-haiku-4-5-20251001';
    const maxTokens = req.maxTokens ?? 1024;

    const attempt = async (): Promise<FinalMessage> => {
      try {
        const stream = client.messages.stream(
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
      message = await pRetry(attempt, {
        retries: 2,
        minTimeout: 500,
        factor: 2,
      });
    } catch (e) {
      if (signal.aborted)
        throw new LoopError({
          code: 'ABORTED',
          phase: 'engine',
          message: 'anthropic-api run aborted',
        });
      throw LoopError.from(e, { code: 'ENGINE', phase: 'engine' });
    }

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
    onEvent({ type: 'usage', usage, model });
    return {
      text,
      usage,
      model,
      stopReason: message.stop_reason ?? undefined,
      raw: message,
    };
  }
}
