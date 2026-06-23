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
  permissionMode?: string;
  engineArg?: string[];
  state?: string;
  budget?: string;
  record?: string;
  checkpoint?: string;
  resume?: string;
  onLimit?: string;
  maxWait?: string;
  json?: boolean;
  tui?: boolean; // commander sets false for --no-tui
}

const ON_LIMIT_VALUES = ['auto', 'wait', 'exit-resume', 'fail'] as const;
type OnLimitValue = (typeof ON_LIMIT_VALUES)[number];

/** The worker prompt comes from --prompt OR --prompt-file (not both). */
function resolvePrompt(flags: RunFlags): string {
  if (flags.promptFile != null && flags.prompt != null) {
    throw new Error('pass either --prompt or --prompt-file, not both');
  }
  if (flags.promptFile != null) {
    const resolved = path.resolve(flags.promptFile);
    if (!fs.existsSync(resolved))
      throw new Error(`prompt file not found: ${flags.promptFile}`);
    return fs.readFileSync(resolved, 'utf8');
  }
  return flags.prompt ?? '';
}

async function loadJob(file: string): Promise<{ job: Job; title: string }> {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `loop file not found: ${file}\n(omit the file argument to use flags mode, or run \`loops run --help\`)`,
    );
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Record<
    string,
    unknown
  >;
  const def = mod.default ?? mod.job ?? mod.loop;
  const title = path.basename(file).replace(/\.(loop\.)?(t|j)sx?$/, '');
  if (typeof def === 'function') return { job: def as Job, title };
  if (def && typeof def === 'object' && 'body' in def)
    return { job: loop(def as LoopConfig), title };
  throw new Error(
    `${file}: default export must be a Job (from loop()/dag()/agentJob()) or a LoopConfig`,
  );
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
      interval:
        flags.interval != null ? parseDuration(flags.interval) : undefined,
      maxTokens: num(flags.maxTokens),
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(
        `invalid flags:\n  - ${e.issues.map((i) => i.message).join('\n  - ')}`,
      );
    }
    throw e;
  }
}

async function execute(
  file: string | undefined,
  flags: RunFlags,
): Promise<void> {
  const { job, title } = file
    ? await loadJob(file)
    : { job: buildFromFlags(flags), title: 'loop' };

  const engineOptions: EngineOptions = {};
  if (flags.defaultModel) engineOptions.defaultModel = flags.defaultModel;
  if (flags.apiKey) engineOptions.apiKey = flags.apiKey;
  if (flags.cliBinary) engineOptions.cliBinary = flags.cliBinary;
  if (flags.permissionMode)
    engineOptions.permissionMode =
      flags.permissionMode as EngineOptions['permissionMode'];
  if (flags.engineArg?.length) engineOptions.cliArgs = flags.engineArg;

  let state: Record<string, unknown> | undefined;
  if (flags.state) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.state);
    } catch (e) {
      throw new Error(
        `--state must be valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `--state must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      );
    }
    state = parsed as Record<string, unknown>;
  }

  let budget: number | undefined;
  if (flags.budget != null) {
    budget = Number(flags.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(
        `--budget must be a positive number of tokens, got "${flags.budget}"`,
      );
    }
  }

  let onLimit: OnLimitValue | undefined;
  if (flags.onLimit != null) {
    if (!ON_LIMIT_VALUES.includes(flags.onLimit as OnLimitValue)) {
      throw new Error(
        `--on-limit must be one of ${ON_LIMIT_VALUES.join(' | ')}, got "${flags.onLimit}"`,
      );
    }
    onLimit = flags.onLimit as OnLimitValue;
  }

  const maxWaitMs =
    flags.maxWait != null ? parseDuration(flags.maxWait) : undefined;

  const mode: 'json' | 'plain' | 'tui' = flags.json
    ? 'json'
    : flags.tui === false || !process.stdout.isTTY
      ? 'plain'
      : 'tui';

  const resumeCommand = buildResumeCommand(file, flags);

  const hub = createHub();
  const signals = installSignalHandlers();
  const runOptions = {
    engine: flags.engine as EngineName | undefined,
    engineOptions,
    signal: signals.controller.signal,
    onEvent: hub.emit,
    state,
    budget,
    recordTo: flags.record,
    checkpoint: flags.checkpoint,
    resumeFrom: flags.resume,
    onLimit,
    maxWaitMs,
    resumeCommand,
  };

  let result;
  if (mode === 'tui') {
    const { render } = await import('ink');
    const { App } = await import('./tui/App.tsx');
    const instance = render(
      <App
        hub={hub}
        title={title}
        onAbort={() => signals.controller.abort()}
      />,
    );
    result = await run(job, runOptions);
    instance.unmount();
    await instance.waitUntilExit().catch(() => {});
    printSummary(result, resumeCommand);
  } else {
    const unsubscribe = hub.subscribe(
      mode === 'json' ? jsonReporter() : plainReporter(),
    );
    result = await run(job, runOptions);
    unsubscribe();
    if (mode !== 'json') printSummary(result, resumeCommand);
  }

  if (result.outcome.status === 'paused') printResumeGuidance(file, flags);

  signals.dispose();
  process.exitCode = exitCodeFor(result.outcome);
}

/**
 * Reconstruct a ready-to-paste resume command from the invocation, when there is
 * something to resume from: a checkpoint path. The resumed run reads warm state
 * from the checkpoint, so it picks up where the limit stopped it. Returns
 * `undefined` when no checkpoint is configured — a run with no checkpoint can
 * still pause cleanly, but it has no warm state to resume.
 */
function buildResumeCommand(
  file: string | undefined,
  flags: RunFlags,
): string | undefined {
  if (!flags.checkpoint) return undefined;
  const parts = ['loops', 'run'];
  if (file) parts.push(quoteArg(file));
  parts.push('--resume', quoteArg(flags.checkpoint));
  // Carry the flags that shape the run so the resume is the same job.
  if (flags.engine) parts.push('--engine', flags.engine);
  if (flags.budget) parts.push('--budget', flags.budget);
  if (flags.onLimit) parts.push('--on-limit', flags.onLimit);
  if (flags.maxWait) parts.push('--max-wait', flags.maxWait);
  if (flags.record) parts.push('--record', quoteArg(flags.record));
  if (flags.checkpoint) parts.push('--checkpoint', quoteArg(flags.checkpoint));
  if (flags.tui === false) parts.push('--no-tui');
  if (flags.json) parts.push('--json');
  return parts.join(' ');
}

/** Shell-quote an argument only when it contains whitespace or quotes. */
function quoteArg(value: string): string {
  return /[\s'"]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

/** Print resume guidance to stderr on a paused run (a TUI-safe channel). */
function printResumeGuidance(file: string | undefined, flags: RunFlags): void {
  const cmd = buildResumeCommand(file, flags);
  if (cmd) {
    process.stderr.write(`\nPaused at a limit. Resume with:\n  ${cmd}\n`);
  } else {
    process.stderr.write(
      '\nPaused at a limit. No checkpoint was configured, so there is no warm ' +
        'state to resume.\nRe-run with --checkpoint <path> to make a pause ' +
        'resumable.\n',
    );
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name('loops')
    .description(
      'Run a prompt/agent in a loop with a fresh context every iteration. A nestable job primitive: loops, DAG stages, agent-validated conditions, review-restart.',
    )
    .version('0.1.0');

  program
    .command('run', { isDefault: true })
    .argument(
      '[file]',
      'a loop-definition file (default-exports a Job); omit to use flags',
    )
    .option('-p, --prompt <text>', 'worker prompt (no-file mode)')
    .option(
      '-f, --prompt-file <path>',
      'read the worker prompt from a file (no-file mode)',
    )
    .option(
      '-e, --engine <name>',
      'default engine: agent-sdk | claude-cli | anthropic-api',
    )
    .option('--default-model <id>', 'fallback model id for engines')
    .option('--worker-model <id>', 'model for the worker job')
    .option(
      '--validator-model <id>',
      'small model for agent-validated conditions',
    )
    .option('--reviewer-model <id>', 'model for the review job')
    .option('-n, --max <n>', 'max iterations')
    .option('-u, --until <question>', 'agent-validated stop condition')
    .option('-t, --threshold <0..1>', 'confidence threshold for --until', '0.8')
    .option('--start <question>', 'agent-validated start gate')
    .option(
      '--review <instructions>',
      'review job; failing it restarts the loop',
    )
    .option(
      '--review-threshold <0..1>',
      'confidence threshold for --review',
      '0.85',
    )
    .option('-i, --interval <dur>', 'delay between iterations (e.g. 30s, 5m)')
    .option('--max-tokens <n>', 'max output tokens per agent turn')
    .option('--api-key <key>', 'Anthropic API key (anthropic-api engine)')
    .option(
      '--cli-binary <path>',
      'path to the claude binary (claude-cli engine)',
    )
    .option(
      '--permission-mode <mode>',
      'tool permission mode for claude-cli/agent-sdk (default | acceptEdits | bypassPermissions | plan | dontAsk | auto)',
    )
    .option(
      '--engine-arg <arg>',
      'extra arg forwarded to the claude-cli engine (repeatable)',
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option('--state <json>', 'seed the shared run state (JSON)')
    .option('--budget <tokens>', 'cap total tokens (input+output) for the run')
    .option('--record <path>', 'append a JSONL run record to this path')
    .option(
      '--checkpoint <path>',
      'snapshot run state to this path at each loop/dag/job boundary',
    )
    .option(
      '--resume <path>',
      'restore run state from a prior --checkpoint file',
    )
    .option(
      '--on-limit <policy>',
      'on a rate/quota/budget limit: auto | wait | exit-resume | fail (default auto)',
    )
    .option(
      '--max-wait <dur>',
      'cap an auto/wait limit-wait (e.g. 5m, 30s); default 5m',
    )
    .option('--json', 'emit NDJSON events to stdout (no TUI)')
    .option('--no-tui', 'plain line output instead of the Ink TUI')
    .action((file: string | undefined, flags: RunFlags) =>
      execute(file, flags),
    );

  await program.parseAsync(argv);
}
