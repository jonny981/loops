/**
 * `loops helm` — the interactive front of the harness. A REPL (or a one-shot
 * message) over a `HelmSession`: the driver's `say` lines and the bridge's
 * observations stream to the terminal; dispatched runs keep going after the
 * REPL exits (they are ordinary supervised runs — `loops list` sees them).
 *
 * Everything model-influenced that reaches the terminal goes through
 * `toLine` per line, same as the other supervision reads.
 */

import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';

import { toLine } from '../runtime/supervisor.ts';
import { truncate } from '../core/text.ts';
import { HelmBridge } from './bridge.ts';
import { HelmSession, type HelmEvent } from './session.ts';
import { helmSystemPrompt } from './system.ts';

export interface HelmCliFlags {
  engine?: string;
  model?: string;
  maxSteps?: string;
  maxRuns?: string;
  runArg?: string[];
  import?: string;
  session?: string;
}

function sanitize(text: string): string {
  return text
    .split('\n')
    .map((line) => toLine(line))
    .join('\n');
}

function printEvent(event: HelmEvent): void {
  switch (event.kind) {
    case 'say':
      process.stdout.write(`${pc.bold('helm ›')} ${sanitize(event.text)}\n`);
      return;
    case 'intent': {
      if (event.intent.action === 'answer') return;
      const { say: _say, rationale: _rationale, action, ...rest } = event.intent;
      const args = Object.entries(rest)
        .map(([k, v]) => `${k}=${truncate(oneLineArg(v), 60)}`)
        .join(' ');
      process.stdout.write(pc.dim(`  → ${action}${args ? ` ${args}` : ''}\n`));
      return;
    }
    case 'observation': {
      const mark = event.observation.ok ? pc.green('·') : pc.red('✗');
      process.stdout.write(
        `  ${mark} ${sanitize(event.observation.summary)}\n`,
      );
      if (event.observation.detail) {
        const clamped = truncate(sanitize(event.observation.detail), 1200);
        process.stdout.write(
          pc.dim(`${clamped.split('\n').map((l) => `    ${l}`).join('\n')}\n`),
        );
      }
      return;
    }
    case 'invalid':
      process.stdout.write(
        pc.yellow(
          `  ! invalid intent: ${toLine(event.error)}${event.willRetry ? ' (asking the driver to correct)' : ''}\n`,
        ),
      );
      return;
    case 'usage':
      process.stdout.write(
        pc.dim(
          `  ${event.model}: ${event.usage.inputTokens}/${event.usage.outputTokens} tok\n`,
        ),
      );
      return;
    case 'turn-end':
      if (event.reason === 'dispatched') {
        process.stdout.write(
          pc.dim(
            '  (dispatched — the run continues in the background; ask for status anytime)\n',
          ),
        );
      } else if (event.reason === 'steps' || event.reason === 'unproductive') {
        process.stdout.write(
          pc.yellow(`  (turn ended: ${event.reason} after ${event.steps} steps)\n`),
        );
      }
      return;
  }
}

function oneLineArg(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\s+/g, ' ');
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runHelmCommand(
  messageParts: string[],
  flags: HelmCliFlags,
): Promise<void> {
  const bridge = new HelmBridge({
    cwd: process.cwd(),
    maxRuns: positiveInt(flags.maxRuns, 8),
    runArgs: flags.runArg ?? [],
  });
  const session = new HelmSession({
    bridge,
    engine: flags.engine ?? 'claude-cli',
    model: flags.model,
    maxSteps: positiveInt(flags.maxSteps, 8),
    system: helmSystemPrompt({ authorImport: flags.import }),
    sessionId: flags.session,
  });

  const turn = async (message: string): Promise<boolean> => {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    let productive = true;
    try {
      for await (const event of session.send(message, controller.signal)) {
        printEvent(event);
        if (event.kind === 'turn-end' && event.reason === 'unproductive') {
          productive = false;
        }
      }
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
    return productive;
  };

  const oneShot = messageParts.join(' ').trim();
  if (oneShot) {
    const productive = await turn(oneShot);
    if (!productive) process.exitCode = 1;
    return;
  }

  process.stdout.write(
    pc.dim(
      `helm session ${session.sessionId} — type a message, or "exit" to leave (dispatched runs keep going)\n`,
    ),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question(pc.bold('you › '));
      } catch {
        break; // closed (Ctrl-D / Ctrl-C at the prompt)
      }
      const message = line.trim();
      if (!message) continue;
      if (message === 'exit' || message === 'quit') break;
      await turn(message);
    }
  } finally {
    rl.close();
  }
}
