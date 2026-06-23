/**
 * Non-TUI output paths: a human-readable line reporter (`--no-tui`, CI logs)
 * and a machine-readable NDJSON reporter (`--json`). Plus the exit summary,
 * shared by every mode.
 */

import pc from 'picocolors';

import type { Listener } from './runtime/hub.ts';
import type { LoopEvent, Outcome } from './core/types.ts';
import type { RunResult } from './runtime/runner.ts';

const indent = (path: string[]) => '  '.repeat(Math.max(0, path.length - 1));
const statusColor = (status: Outcome['status'], text: string): string =>
  status === 'pass'
    ? pc.green(text)
    : status === 'fail'
      ? pc.red(text)
      : status === 'exhausted'
        ? pc.yellow(text)
        : pc.gray(text);

/** Emit each event as one NDJSON line on stdout. */
export function jsonReporter(): Listener {
  return (event: LoopEvent) =>
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Per-loop-path accumulator, so we can print one report line per iteration. */
interface IterAccum {
  iteration: number;
  bodyStatus?: Outcome['status'];
  until?: { met: boolean; reason: string };
  stopOn?: { met: boolean; reason: string };
  review?: { status: Outcome['status']; summary?: string };
  tokensIn: number;
  tokensOut: number;
}

/** Compact a token count, e.g. 1234 → "1.2k". */
const tok = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Human-readable streaming output. Agent text streams inline; events labelled. */
export function plainReporter(): Listener {
  let streaming = false;
  const endStream = () => {
    if (streaming) {
      process.stdout.write('\n');
      streaming = false;
    }
  };

  // Per loop path: the in-flight iteration's accumulating facts. A new
  // `loop:iteration` (or `loop:end`) for that path flushes the previous one.
  const accums = new Map<string, IterAccum>();
  const reportIteration = (key: string, indentPath: string[]): void => {
    const a = accums.get(key);
    if (!a) return;
    accums.delete(key);
    const parts: string[] = [];
    if (a.bodyStatus)
      parts.push(`body=${statusColor(a.bodyStatus, a.bodyStatus)}`);
    if (a.until)
      parts.push(`until=${a.until.met ? pc.green('met') : pc.gray('not met')}`);
    if (a.stopOn?.met) parts.push(`stopOn=${pc.red('met')}`);
    if (a.review) {
      const rv = `review=${statusColor(a.review.status, a.review.status)}`;
      parts.push(
        a.review.summary ? `${rv} ${pc.dim(`(${a.review.summary})`)}` : rv,
      );
    }
    parts.push(`${tok(a.tokensIn)}/${tok(a.tokensOut)} tok`);
    console.log(
      `${indent(indentPath)}  ${pc.gray(`↳ iter ${a.iteration}:`)} ${parts.join(pc.gray(' · '))}`,
    );
  };

  return (event: LoopEvent) => {
    const key = event.path.join(' / ');
    switch (event.kind) {
      case 'engine:text':
        process.stdout.write(event.delta);
        streaming = true;
        return;
      case 'loop:start':
        endStream();
        console.log(
          `${indent(event.path)}${pc.cyan('▸ loop')} ${pc.bold(last(event.path))}${event.max ? pc.gray(` (max ${event.max})`) : ''}`,
        );
        return;
      case 'loop:iteration':
        endStream();
        reportIteration(key, event.path); // flush the previous iteration's report
        accums.set(key, {
          iteration: event.iteration,
          tokensIn: 0,
          tokensOut: 0,
        });
        console.log(
          `${indent(event.path)}${pc.gray(`  iteration ${event.iteration}`)}`,
        );
        return;
      case 'loop:condition': {
        endStream();
        const a = accums.get(key);
        if (a) {
          if (event.which === 'until')
            a.until = { met: event.result.met, reason: event.result.reason };
          else if (event.which === 'stopOn')
            a.stopOn = { met: event.result.met, reason: event.result.reason };
        }
        console.log(
          `${indent(event.path)}  ${pc.magenta(event.which)}: ${event.result.met ? pc.green('met') : pc.gray('not met')} — ${pc.dim(event.result.reason)}`,
        );
        return;
      }
      case 'loop:review': {
        endStream();
        const a = accums.get(key);
        if (a)
          a.review = {
            status: event.outcome.status,
            summary: event.outcome.summary,
          };
        console.log(
          `${indent(event.path)}  ${pc.blue('review')}: ${statusColor(event.outcome.status, event.outcome.status)}${event.outcome.summary ? pc.dim(` — ${event.outcome.summary}`) : ''}`,
        );
        return;
      }
      case 'job:end': {
        // The loop body runs at the loop's own path; record its outcome on the
        // current iteration accumulator for that path.
        const a = accums.get(key);
        if (a) a.bodyStatus = event.outcome.status;
        return;
      }
      case 'engine:usage': {
        const a = accums.get(key);
        if (a) {
          a.tokensIn += event.usage.inputTokens;
          a.tokensOut += event.usage.outputTokens;
        }
        return;
      }
      case 'loop:end':
        endStream();
        reportIteration(key, event.path); // flush the final iteration's report
        console.log(
          `${indent(event.path)}${pc.cyan('◂ loop')} ${pc.bold(last(event.path))} → ${statusColor(event.outcome.status, event.outcome.status)} ${pc.gray(`(${event.iterations} iter)`)}`,
        );
        return;
      case 'dag:start':
        endStream();
        console.log(
          `${indent(event.path)}${pc.cyan('▸ dag')} ${pc.bold(last(event.path))} ${pc.gray(`[${event.nodes.join(', ')}]`)}`,
        );
        return;
      case 'dag:node':
        if (event.phase === 'start') return;
        endStream();
        console.log(
          `${indent(event.path)}  ${pc.gray('node')} ${event.node}: ${event.outcome ? statusColor(event.outcome.status, event.phase === 'skip' ? 'skipped' : event.outcome.status) : event.phase}`,
        );
        return;
      case 'dag:end':
        endStream();
        console.log(
          `${indent(event.path)}${pc.cyan('◂ dag')} ${pc.bold(last(event.path))} → ${statusColor(event.outcome.status, event.outcome.status)}`,
        );
        return;
      case 'job:start':
        endStream();
        console.log(`${indent(event.path)}  ${pc.gray('•')} ${event.label}`);
        return;
      case 'engine:tool':
        endStream();
        console.log(
          `${indent(event.path)}    ${pc.dim(`tool ${event.phase}: ${event.name}`)}`,
        );
        return;
      case 'log':
        endStream();
        console.log(
          `${indent(event.path)}  ${pc.dim(`[${event.level}] ${event.message}`)}`,
        );
        return;
      case 'error':
        endStream();
        console.log(
          `${indent(event.path)}  ${pc.red(`✗ ${event.code}: ${event.message}`)}`,
        );
        return;
      default:
        return;
    }
  };
}

/** The exit summary, printed once at the end in every mode. */
export function printSummary(result: RunResult): void {
  const { outcome, stats } = result;
  const line = pc.dim('─'.repeat(56));
  console.log(`\n${line}`);
  console.log(
    `${pc.bold('Result')}  ${statusColor(outcome.status, outcome.status.toUpperCase())}${outcome.confidence != null ? pc.gray(`  confidence ${outcome.confidence.toFixed(2)}`) : ''}`,
  );
  if (outcome.summary) console.log(`${pc.dim('Summary')} ${outcome.summary}`);

  console.log(line);
  console.log(`${pc.bold('Loops')}`);
  for (const loop of stats.loops) {
    const reviews = loop.reviewsPassed + loop.reviewsFailed;
    console.log(
      `  ${loop.path || '(root)'} — ${loop.iterations} iter` +
        (reviews
          ? `, reviews ${pc.green(String(loop.reviewsPassed))}/${pc.red(String(loop.reviewsFailed))}`
          : '') +
        (loop.lastStatus
          ? ` → ${statusColor(loop.lastStatus, loop.lastStatus)}`
          : ''),
    );
  }
  if (stats.loops.length === 0) console.log(pc.dim('  (none)'));

  console.log(line);
  console.log(
    `${pc.bold('Usage')}  ${stats.agentCalls} agent call(s), ` +
      `${pc.cyan(String(stats.totalInputTokens))} in / ${pc.cyan(String(stats.totalOutputTokens))} out tokens, ` +
      `${(stats.elapsedMs / 1000).toFixed(1)}s`,
  );
  for (const m of stats.models) {
    console.log(
      pc.dim(
        `  ${m.model}: ${m.calls} call(s), ${m.inputTokens} in / ${m.outputTokens} out`,
      ),
    );
  }

  if (result.budget) {
    const b = result.budget;
    const spent =
      b.remaining === 0 ? pc.red(String(b.spent)) : pc.cyan(String(b.spent));
    console.log(
      `${pc.bold('Budget')} ${spent} / ${b.limit} tokens ${pc.gray(`(${b.remaining} remaining)`)}`,
    );
  }

  if (stats.errors.length) {
    console.log(line);
    console.log(`${pc.bold(pc.red('Errors'))} (${stats.errors.length})`);
    for (const e of stats.errors.slice(0, 10)) {
      console.log(pc.red(`  ✗ [${e.code}] ${e.path}: ${e.message}`));
    }
  }
  console.log(line);
}

function last(path: string[]): string {
  return path[path.length - 1] ?? '(root)';
}
