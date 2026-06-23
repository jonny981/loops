/**
 * Engine adapter: the `claude` CLI as a subprocess. A fresh process per call =
 * a fresh context. Robust spawning + abort + timeout via `execa`; output is the
 * same stream-json schema the Agent SDK emits, so we reuse `mapMessage`.
 */

import { execa } from 'execa';
import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
  EngineOptions,
} from './engine.ts';
import { mapMessage, newAccumulator } from './message-map.ts';
import { LoopError } from '../core/errors.ts';
import { redactSecrets } from '../core/redact.ts';

/**
 * Build the `claude` argv for one run. Extracted (and exported) so the flag
 * wiring — model, system prompt, tool allowlist, permission mode, the `--`
 * argument-smuggling guard — is unit-testable without spawning a process.
 */
export function buildClaudeArgs(
  req: AgentRequest,
  opts: EngineOptions,
): string[] {
  const model = req.model ?? opts.defaultModel;
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', model);
  if (req.system) args.push('--append-system-prompt', req.system);
  if (req.allowedTools?.length)
    args.push('--allowedTools', req.allowedTools.join(','));
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.cliArgs?.length) args.push(...opts.cliArgs);
  // `--` ends option parsing so a prompt starting with `-` can't be
  // mis-interpreted by `claude` as a flag (argument smuggling).
  args.push('--', req.prompt);
  return args;
}

export class ClaudeCliEngine implements Engine {
  readonly name = 'claude-cli';
  constructor(private readonly opts: EngineOptions = {}) {}

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const bin = this.opts.cliBinary ?? 'claude';
    const model = req.model ?? this.opts.defaultModel;
    const args = buildClaudeArgs(req, this.opts);

    const acc = newAccumulator(model ?? 'claude-cli');
    // Buffered (default) so `stderr` is a string for error messages; we still
    // attach a `data` listener to stream stdout line-by-line as it arrives.
    const sub = execa(bin, args, {
      cwd: req.cwd,
      cancelSignal: signal,
      // The prompt is passed as an argument, not piped — don't let `claude -p`
      // stall waiting on stdin.
      stdin: 'ignore',
      // If the child ignores the SIGTERM from an abort/timeout, escalate to
      // SIGKILL so a wedged subprocess can't make Ctrl-C hang.
      forceKillAfterDelay: 5000,
      reject: false,
      timeout: req.timeoutMs,
      stripFinalNewline: false,
    });

    let buffer = '';
    const flush = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        mapMessage(JSON.parse(trimmed), acc, onEvent);
      } catch {
        /* ignore non-JSON banner lines */
      }
    };
    sub.stdout?.setEncoding('utf8');
    sub.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        flush(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });

    const result = await sub;
    if (buffer) flush(buffer);

    if (signal.aborted)
      throw new LoopError({
        code: 'ABORTED',
        phase: 'engine',
        message: 'claude-cli run aborted',
      });
    if (result.failed) {
      // The child's stderr is outside our control and may echo credentials on
      // an auth failure — redact before it lands in events/logs/the summary.
      const stderr =
        typeof result.stderr === 'string'
          ? redactSecrets(result.stderr.slice(0, 400))
          : '';
      throw new LoopError({
        code: result.timedOut ? 'TIMEOUT' : 'ENGINE',
        phase: 'engine',
        message: `claude exited ${result.exitCode ?? '?'}${stderr ? `: ${stderr}` : ''}`,
      });
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
