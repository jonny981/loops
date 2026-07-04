/**
 * Engine adapter: the `codex` CLI (GPT-5) as a non-interactive subprocess. A
 * different model behind the same `Engine` interface: point a reviewer at
 * `engine: 'codex'` for a second-model signal, with no bespoke integration.
 * Read-only by default: a report-only reviewer never edits, so the sandbox
 * forbids writes and the run cannot touch the workspace.
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
import { scrubCapture } from '../core/redact.ts';

export function buildCodexArgs(
  req: AgentRequest,
  opts: EngineOptions,
  outFile: string,
): string[] {
  const model = req.model ?? opts.defaultModel;
  const prompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never'];

  if (opts.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-s', 'read-only');
  }

  if (req.cwd) args.push('-C', req.cwd);
  if (model) args.push('-m', model);
  if (opts.cliArgs?.length) args.push(...opts.cliArgs);
  args.push('-o', outFile, prompt);
  return args;
}

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
    const args = buildCodexArgs(req, this.opts, outFile);

    try {
      const sub = await execa(this.opts.cliBinary ?? 'codex', args, {
        stdin: 'ignore', // codex exec stalls on an open stdin
        // execa merges this over `process.env` (`extendEnv` default); undefined
        // is inert, so a request with no env changes nothing.
        env: req.env,
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
          // `scrubCapture` redacts (env values verbatim, then shape patterns,
          // both on the FULL stream, before the cut) so a secret split at the
          // slice boundary cannot survive.
          message: `codex exited ${sub.exitCode ?? '?'}${
            typeof sub.stderr === 'string'
              ? `: ${scrubCapture(sub.stderr, req.env, 300)}`
              : ''
          }`,
        });

      // codex bills a separate (GPT-5) account, so its tokens are out-of-band for
      // the loops token budget; report zero rather than conflate providers.
      const usage = { inputTokens: 0, outputTokens: 0 };
      if (text) onEvent({ type: 'text', delta: text });
      onEvent({ type: 'usage', usage, model: model ?? 'codex' });
      return { text, usage, model: model ?? 'codex', stopReason: 'end_turn' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
