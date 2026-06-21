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
  status === 'pass' ? pc.green(text)
  : status === 'fail' ? pc.red(text)
  : status === 'exhausted' ? pc.yellow(text)
  : pc.gray(text);

/** Emit each event as one NDJSON line on stdout. */
export function jsonReporter(): Listener {
  return (event: LoopEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Human-readable streaming output. Agent text streams inline; events labelled. */
export function plainReporter(): Listener {
  let streaming = false;
  const endStream = () => {
    if (streaming) {
      process.stdout.write('\n');
      streaming = false;
    }
  };
  return (event: LoopEvent) => {
    switch (event.kind) {
      case 'engine:text':
        process.stdout.write(event.delta);
        streaming = true;
        return;
      case 'loop:start':
        endStream();
        console.log(`${indent(event.path)}${pc.cyan('▸ loop')} ${pc.bold(last(event.path))}${event.max ? pc.gray(` (max ${event.max})`) : ''}`);
        return;
      case 'loop:iteration':
        endStream();
        console.log(`${indent(event.path)}${pc.gray(`  iteration ${event.iteration}`)}`);
        return;
      case 'loop:condition':
        endStream();
        console.log(`${indent(event.path)}  ${pc.magenta(event.which)}: ${event.result.met ? pc.green('met') : pc.gray('not met')} — ${pc.dim(event.result.reason)}`);
        return;
      case 'loop:review':
        endStream();
        console.log(`${indent(event.path)}  ${pc.blue('review')}: ${statusColor(event.outcome.status, event.outcome.status)}${event.outcome.summary ? pc.dim(` — ${event.outcome.summary}`) : ''}`);
        return;
      case 'loop:end':
        endStream();
        console.log(`${indent(event.path)}${pc.cyan('◂ loop')} ${pc.bold(last(event.path))} → ${statusColor(event.outcome.status, event.outcome.status)} ${pc.gray(`(${event.iterations} iter)`)}`);
        return;
      case 'dag:start':
        endStream();
        console.log(`${indent(event.path)}${pc.cyan('▸ dag')} ${pc.bold(last(event.path))} ${pc.gray(`[${event.nodes.join(', ')}]`)}`);
        return;
      case 'dag:node':
        if (event.phase === 'start') return;
        endStream();
        console.log(`${indent(event.path)}  ${pc.gray('node')} ${event.node}: ${event.outcome ? statusColor(event.outcome.status, event.phase === 'skip' ? 'skipped' : event.outcome.status) : event.phase}`);
        return;
      case 'dag:end':
        endStream();
        console.log(`${indent(event.path)}${pc.cyan('◂ dag')} ${pc.bold(last(event.path))} → ${statusColor(event.outcome.status, event.outcome.status)}`);
        return;
      case 'job:start':
        endStream();
        console.log(`${indent(event.path)}  ${pc.gray('•')} ${event.label}`);
        return;
      case 'engine:tool':
        endStream();
        console.log(`${indent(event.path)}    ${pc.dim(`tool ${event.phase}: ${event.name}`)}`);
        return;
      case 'log':
        endStream();
        console.log(`${indent(event.path)}  ${pc.dim(`[${event.level}] ${event.message}`)}`);
        return;
      case 'error':
        endStream();
        console.log(`${indent(event.path)}  ${pc.red(`✗ ${event.code}: ${event.message}`)}`);
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
  console.log(`${pc.bold('Result')}  ${statusColor(outcome.status, outcome.status.toUpperCase())}${outcome.confidence != null ? pc.gray(`  confidence ${outcome.confidence.toFixed(2)}`) : ''}`);
  if (outcome.summary) console.log(`${pc.dim('Summary')} ${outcome.summary}`);

  console.log(line);
  console.log(`${pc.bold('Loops')}`);
  for (const loop of stats.loops) {
    const reviews = loop.reviewsPassed + loop.reviewsFailed;
    console.log(
      `  ${loop.path || '(root)'} — ${loop.iterations} iter` +
        (reviews ? `, reviews ${pc.green(String(loop.reviewsPassed))}/${pc.red(String(loop.reviewsFailed))}` : '') +
        (loop.lastStatus ? ` → ${statusColor(loop.lastStatus, loop.lastStatus)}` : ''),
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
    console.log(pc.dim(`  ${m.model}: ${m.calls} call(s), ${m.inputTokens} in / ${m.outputTokens} out`));
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
