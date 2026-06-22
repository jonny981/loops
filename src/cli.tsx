/**
 * The `loops` CLI. Two ways to define a run:
 *   1. a definition file that default-exports a `Job`  — full power, nesting;
 *   2. flags (`--prompt`, `--until`, `--review`, …)    — the standard loop.
 *
 * Output mode: Ink TUI by default (a TTY), `--no-tui` for line logs, `--json`
 * for an NDJSON event stream. Ctrl-C / `q` aborts cleanly and still summarises.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { Command } from 'commander';
import { z } from 'zod';

import { run, exitCodeFor } from './runtime/runner.ts';
import { createHub } from './runtime/hub.ts';
import { installSignalHandlers } from './runtime/signals.ts';
import { jsonReporter, plainReporter, printSummary } from './reporters.ts';
import { buildJobFromFlags, parseDuration } from './config.ts';
import { loop } from './core/loop.ts';
import type { Job, LoopConfig } from './core/types.ts';
import type { EngineName, EngineOptions } from './engines/engine.ts';

interface RunFlags {
  prompt?: string;
  promptFile?: string;
  engine?: string;
  defaultModel?: string;
  workerModel?: string;
  validatorModel?: string;
  reviewerModel?: string;
  max?: string;
  until?: string;
  threshold?: string;
  start?: string;
  review?: string;
  reviewThreshold?: string;
  interval?: string;
  maxTokens?: string;
  apiKey?: string;
  cliBinary?: string;
  engineArg?: string[];
  state?: string;
  json?: boolean;
  tui?: boolean; // commander sets false for --no-tui
}

/** The worker prompt comes from --prompt OR --prompt-file (not both). */
function resolvePrompt(flags: RunFlags): string {
  if (flags.promptFile != null && flags.prompt != null) {
    throw new Error('pass either --prompt or --prompt-file, not both');
  }
  if (flags.promptFile != null) {
    const resolved = path.resolve(flags.promptFile);
    if (!fs.existsSync(resolved)) throw new Error(`prompt file not found: ${flags.promptFile}`);
    return fs.readFileSync(resolved, 'utf8');
  }
  return flags.prompt ?? '';
}

async function loadJob(file: string): Promise<{ job: Job; title: string }> {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`loop file not found: ${file}\n(omit the file argument to use flags mode, or run \`loops run --help\`)`);
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  const def = mod.default ?? mod.job ?? mod.loop;
  const title = path.basename(file).replace(/\.(loop\.)?(t|j)sx?$/, '');
  if (typeof def === 'function') return { job: def as Job, title };
  if (def && typeof def === 'object' && 'body' in def) return { job: loop(def as LoopConfig), title };
  throw new Error(`${file}: default export must be a Job (from loop()/dag()/agentJob()) or a LoopConfig`);
}

function buildFromFlags(flags: RunFlags): Job {
  const num = (v: string | undefined) => (v == null ? undefined : Number(v));
  const prompt = resolvePrompt(flags); // outside the try so its errors aren't reported as flag-validation
  try {
    // Parsing/validation lives in buildJobFromFlags (single source of truth);
    // we just shape the raw input and translate a Zod failure into a clean error.
    return buildJobFromFlags({
      prompt,
      engine: flags.engine,
      workerModel: flags.workerModel,
      validatorModel: flags.validatorModel,
      reviewerModel: flags.reviewerModel,
      max: num(flags.max),
      untilAgent: flags.until,
      threshold: num(flags.threshold),
      startAgent: flags.start,
      review: flags.review,
      reviewThreshold: num(flags.reviewThreshold),
      interval: flags.interval != null ? parseDuration(flags.interval) : undefined,
      maxTokens: num(flags.maxTokens),
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(`invalid flags:\n  - ${e.issues.map((i) => i.message).join('\n  - ')}`);
    }
    throw e;
  }
}

async function execute(file: string | undefined, flags: RunFlags): Promise<void> {
  const { job, title } = file ? await loadJob(file) : { job: buildFromFlags(flags), title: 'loop' };

  const engineOptions: EngineOptions = {};
  if (flags.defaultModel) engineOptions.defaultModel = flags.defaultModel;
  if (flags.apiKey) engineOptions.apiKey = flags.apiKey;
  if (flags.cliBinary) engineOptions.cliBinary = flags.cliBinary;
  if (flags.engineArg?.length) engineOptions.cliArgs = flags.engineArg;

  let state: Record<string, unknown> | undefined;
  if (flags.state) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.state);
    } catch (e) {
      throw new Error(`--state must be valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`--state must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    state = parsed as Record<string, unknown>;
  }
  const mode: 'json' | 'plain' | 'tui' = flags.json ? 'json' : flags.tui === false || !process.stdout.isTTY ? 'plain' : 'tui';

  const hub = createHub();
  const signals = installSignalHandlers();
  const runOptions = {
    engine: flags.engine as EngineName | undefined,
    engineOptions,
    signal: signals.controller.signal,
    onEvent: hub.emit,
    state,
  };

  let result;
  if (mode === 'tui') {
    const { render } = await import('ink');
    const { App } = await import('./tui/App.tsx');
    const instance = render(<App hub={hub} title={title} onAbort={() => signals.controller.abort()} />);
    result = await run(job, runOptions);
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
    printSummary(result);
  } else {
    const unsubscribe = hub.subscribe(mode === 'json' ? jsonReporter() : plainReporter());
    result = await run(job, runOptions);
    unsubscribe();
    if (mode !== 'json') printSummary(result);
  }

  signals.dispose();
  process.exitCode = exitCodeFor(result.outcome);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name('loops')
    .description('Run a prompt/agent in a loop with a fresh context every iteration. A nestable job primitive: loops, DAG stages, agent-validated conditions, review-restart.')
    .version('0.1.0');

  program
    .command('run', { isDefault: true })
    .argument('[file]', 'a loop-definition file (default-exports a Job); omit to use flags')
    .option('-p, --prompt <text>', 'worker prompt (no-file mode)')
    .option('-f, --prompt-file <path>', 'read the worker prompt from a file (no-file mode)')
    .option('-e, --engine <name>', 'default engine: agent-sdk | claude-cli | anthropic-api')
    .option('--default-model <id>', 'fallback model id for engines')
    .option('--worker-model <id>', 'model for the worker job')
    .option('--validator-model <id>', 'small model for agent-validated conditions')
    .option('--reviewer-model <id>', 'model for the review job')
    .option('-n, --max <n>', 'max iterations')
    .option('-u, --until <question>', 'agent-validated stop condition')
    .option('-t, --threshold <0..1>', 'confidence threshold for --until', '0.8')
    .option('--start <question>', 'agent-validated start gate')
    .option('--review <instructions>', 'review job; failing it restarts the loop')
    .option('--review-threshold <0..1>', 'confidence threshold for --review', '0.85')
    .option('-i, --interval <dur>', 'delay between iterations (e.g. 30s, 5m)')
    .option('--max-tokens <n>', 'max output tokens per agent turn')
    .option('--api-key <key>', 'Anthropic API key (anthropic-api engine)')
    .option('--cli-binary <path>', 'path to the claude binary (claude-cli engine)')
    .option('--engine-arg <arg>', 'extra arg forwarded to the claude-cli engine (repeatable)', (v: string, acc: string[]) => acc.concat(v), [] as string[])
    .option('--state <json>', 'seed the shared run state (JSON)')
    .option('--json', 'emit NDJSON events to stdout (no TUI)')
    .option('--no-tui', 'plain line output instead of the Ink TUI')
    .action((file: string | undefined, flags: RunFlags) => execute(file, flags));

  await program.parseAsync(argv);
}
