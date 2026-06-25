/**
 * Engine adapter: the `codex` CLI (GPT-5) as a non-interactive subprocess. The
 * point is a genuinely DIFFERENT model behind the same `Engine` seam — point any
 * reviewer at `engine: 'codex'` for a second-model adversarial signal, with no
 * bespoke integration. Read-only by default: a report-only reviewer never edits,
 * so the sandbox forbids writes and the run cannot touch the workspace.
 *
 * `codex exec` is non-interactive but blocks on an open stdin, so stdin is always
 * ignored; the final assistant message is captured via `-o <file>` rather than
 * scraped from the event stream.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
  EngineOptions,
} from './engine.ts';
import { LoopError } from '../core/errors.ts';

export class CodexEngine implements Engine {
  readonly name = 'codex';
  constructor(private readonly opts: EngineOptions = {}) {}

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const model = req.model ?? this.opts.defaultModel;
    const dir = mkdtempSync(join(tmpdir(), 'loops-codex-'));
    const outFile = join(dir, 'last.txt');
    // codex exec has no system-prompt flag; fold any system text into the prompt.
    const prompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
    const args = ['exec', '--ephemeral', '-s', 'read-only', '--skip-git-repo-check'];
    if (req.cwd) args.push('-C', req.cwd);
    if (model) args.push('-m', model);
    args.push('-o', outFile, prompt);

    try {
      const sub = await execa(this.opts.cliBinary ?? 'codex', args, {
        stdin: 'ignore', // codex exec stalls on an open stdin
        cancelSignal: signal,
        forceKillAfterDelay: 5000,
        reject: false,
        timeout: req.timeoutMs,
      });
      if (signal.aborted)
        throw new LoopError({ code: 'ABORTED', phase: 'engine', message: 'codex run aborted' });

      let text = '';
      try {
        text = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* no final message written */
      }
      if (!text && sub.failed)
        throw new LoopError({
          code: sub.timedOut ? 'TIMEOUT' : 'ENGINE',
          phase: 'engine',
          message: `codex exited ${sub.exitCode ?? '?'}${
            typeof sub.stderr === 'string' ? `: ${sub.stderr.slice(0, 300)}` : ''
          }`,
        });

      // codex bills a separate (GPT-5) account, so its tokens are out-of-band for
      // the loops token budget — report zero rather than conflate providers.
      const usage = { inputTokens: 0, outputTokens: 0 };
      if (text) onEvent({ type: 'text', delta: text });
      onEvent({ type: 'usage', usage, model: model ?? 'codex' });
      return { text, usage, model: model ?? 'codex', stopReason: 'end_turn' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
