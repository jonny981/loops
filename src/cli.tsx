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
import { jobMeta, renderPlan } from './core/describe.ts';
import {
  listRuns,
  readRunStatus,
  runEventsPath,
  runSemanticRecordsPath,
  runsHome,
  formatEvent,
} from './runtime/supervisor.ts';
import type { SemanticRunRecord } from './runtime/semantic.ts';
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
  supervise?: boolean;
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
  // The bin registers tsx's loader globally, so this plain import transforms a
  // `.loop.ts` wherever it lives — inside this package or in a consumer repo that
  // has `loops` installed. (A scoped `tsImport` only covers this package's tree,
  // which is why an out-of-tree recipe used to die on `Unexpected token 'export'`.)
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const esmHint =
      /ES Module|import statement outside a module|ERR_REQUIRE_ESM/i.test(detail)
        ? `\n  hint: the recipe's folder is not an ES module scope. Add a package.json ` +
          `with {"type":"module"} next to it (repos that use loops as a submodule already have this).`
        : '';
    throw new Error(
      `failed to load loop file ${file}:\n  ${detail}${esmHint}\n` +
        `(the file is imported and run like \`node <file>\`; fix the error above, or ` +
        `run \`loops validate ${file}\` to check it without executing)`,
    );
  }
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
    supervise: flags.supervise,
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

/** Compact relative age, e.g. `8s`, `5m`, `2h`, `3d`. */
function relAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function readSemanticRecords(runId: string): SemanticRunRecord[] | undefined {
  const path = runSemanticRecordsPath(runId);
  if (!fs.existsSync(path)) return undefined;
  const raw = fs.readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  const records: SemanticRunRecord[] = [];
  for (const line of raw.split('\n')) {
    try {
      records.push(JSON.parse(line) as SemanticRunRecord);
    } catch {
      /* skip an unparseable line */
    }
  }
  return records;
}

function parsePositiveIntFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseSinceFlag(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--since must be epoch ms or an ISO timestamp, got "${value}"`);
  }
  return parsed;
}

function normalizeRecordPath(value: string): string {
  return value
    .split(/[\/›>]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

function matchesRecordPath(record: SemanticRunRecord, prefix: string): boolean {
  const path = record.path.join('/');
  return path === prefix || path.startsWith(`${prefix}/`);
}

function formatSemanticRecord(record: SemanticRunRecord): string {
  const at = record.path.length ? `${record.path.join(' › ')} ` : '';
  switch (record.kind) {
    case 'dispatch':
      return `${at}dispatch ${record.unit}${record.label ? ` ${record.label}` : ''}${record.node ? ` ${record.node}` : ''}`;
    case 'completion':
      return `${at}completion ${record.unit}${record.label ? ` ${record.label}` : ''}: ${record.outcome.status}${record.outcome.summary ? ` — ${record.outcome.summary}` : ''}`;
    case 'surfacing':
      return `${at}surfacing ${record.source} ${record.decision}${record.severity ? ` [${record.severity}]` : ''}: ${record.reason}`;
    case 'revision-emitted':
      return `${at}revision emitted ${record.sourceEvent}${record.revision.target ? ` -> ${record.revision.target}` : ''}: ${record.revision.reason}`;
    case 'revision-routed':
      return `${at}revision routed ${record.sourceEvent} ${record.decision}${record.revision.target ? ` -> ${record.revision.target}` : ''}: ${record.revision.reason}`;
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
    .option(
      '--supervise',
      'register this run in ~/.loops/runs so `loops list`/`status`/`tail` can observe it from another process',
    )
    .action((file: string | undefined, flags: RunFlags) =>
      execute(file, flags),
    );

  program
    .command('validate')
    .argument('<file>', 'a loop-definition file to check')
    .description(
      'load a .loop.ts and print its shape without running it: the cheap, no-model pre-flight an agent runs before `loops run`',
    )
    .option('--json', 'emit JSON with the loaded job shape')
    .action(async (file: string, flags: { json?: boolean }) => {
      // loadJob imports + constructs the Job (so it catches syntax, import,
      // transform, and bad-export errors) but never calls run(), so no agent
      // turns fire. A failure throws the same agent-grade error `run` would,
      // and the top-level handler reports it with exit code 1.
      const { job } = await loadJob(file);
      const shape = jobMeta(job);
      if (flags.json) {
        process.stdout.write(
          `${JSON.stringify({ file, ok: true, executed: false, shape }, null, 2)}\n`,
        );
        return;
      }
      const plan = renderPlan(shape);
      process.stdout.write(
        `✓ ${file} loads (not executed)\n${plan.map((l) => `  ${l}`).join('\n')}\n`,
      );
    });

  program
    .command('describe')
    .argument('<file>', 'a loop-definition file')
    .description(
      "print a loop's shape (its gate, body, and dag nodes) without running it",
    )
    .option('--json', 'emit the job shape as JSON')
    .action(async (file: string, flags: { json?: boolean }) => {
      const { job } = await loadJob(file);
      const shape = jobMeta(job);
      process.stdout.write(
        flags.json
          ? `${JSON.stringify(shape, null, 2)}\n`
          : `${renderPlan(shape).join('\n')}\n`,
      );
    });

  // ── Supervision: observe a run from another process (the registry is files) ──

  program
    .command('list')
    .alias('ls')
    .description('list supervised runs (start one with `loops run --supervise`)')
    .action(() => {
      const runs = listRuns();
      if (!runs.length) {
        process.stdout.write(
          `no supervised runs in ${runsHome()}\n(start one with: loops run --supervise <file>)\n`,
        );
        return;
      }
      for (const r of runs) {
        const state =
          r.status === 'running' ? (r.alive ? 'running' : 'dead') : r.status;
        const age = relAge(Date.now() - (r.endedAt ?? r.updatedAt));
        process.stdout.write(
          `${r.runId.padEnd(26)}  ${state.padEnd(9)}  iter ${String(r.live.iteration).padStart(3)}  ${age.padStart(4)}  ${r.title}\n`,
        );
      }
    });

  program
    .command('status')
    .argument('<runId>', 'a run id from `loops list`')
    .description("show a supervised run's live state and shape")
    .action((runId: string) => {
      const r = readRunStatus(runId);
      if (!r) {
        process.stderr.write(`no run "${runId}" in ${runsHome()}\n`);
        process.exitCode = 1;
        return;
      }
      const state =
        r.status === 'running'
          ? r.alive
            ? 'running'
            : 'dead (process gone)'
          : r.status;
      const g = r.live.lastGate;
      const o = r.live.lastOutcome;
      const lines = [
        `${r.runId}  [${state}]`,
        `  title:   ${r.title}`,
        `  cwd:     ${r.cwd}`,
        `  pid:     ${r.pid}`,
        r.live.iteration
          ? `  at:      ${r.live.path.join(' › ')} (iteration ${r.live.iteration})`
          : '',
        g
          ? `  gate:    ${g.which} ${g.met ? 'met' : 'not met'}${g.confidence != null ? ` @ ${g.confidence.toFixed(2)}` : ''}: ${g.reason}`
          : '',
        o ? `  last:    ${o.status}${o.summary ? `: ${o.summary}` : ''}` : '',
        `  tokens:  ${r.live.usage.inputTokens} in / ${r.live.usage.outputTokens} out (${r.live.usage.calls} calls)`,
      ].filter(Boolean);
      process.stdout.write(`${lines.join('\n')}\n`);
      if (r.shape)
        process.stdout.write(
          `\n  shape:\n${renderPlan(r.shape)
            .map((l) => `    ${l}`)
            .join('\n')}\n`,
        );
    });

  program
    .command('tail')
    .argument('<runId>', 'a run id from `loops list`')
    .description("stream a supervised run's events live (Ctrl-C to stop)")
    .action(async (runId: string) => {
      const path = runEventsPath(runId);
      if (!fs.existsSync(path)) {
        process.stderr.write(`no run "${runId}" in ${runsHome()}\n`);
        process.exitCode = 1;
        return;
      }
      let offset = 0;
      let stop = false;
      const onSig = () => {
        stop = true;
      };
      process.once('SIGINT', onSig);
      for (;;) {
        const buf = fs.readFileSync(path, 'utf8');
        if (buf.length > offset) {
          // Only consume up to the last newline, so a torn read never drops a line.
          const chunk = buf.slice(offset);
          const lastNl = chunk.lastIndexOf('\n');
          if (lastNl >= 0) {
            offset += lastNl + 1;
            for (const line of chunk.slice(0, lastNl).split('\n')) {
              if (!line.trim()) continue;
              try {
                process.stdout.write(`${formatEvent(JSON.parse(line))}\n`);
              } catch {
                /* skip an unparseable line */
              }
            }
          }
        }
        if (stop) break;
        const st = readRunStatus(runId);
        if (st && st.status !== 'running') {
          process.stdout.write(`◂ ${st.status}\n`);
          break;
        }
        if (st && !st.alive) {
          process.stdout.write('◂ process gone (no terminal status)\n');
          break;
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      process.removeListener('SIGINT', onSig);
    });

  program
    .command('records')
    .argument('<runId>', 'a run id from `loops list`')
    .description("show a supervised run's semantic records")
    .option(
      '--kind <kind>',
      'filter by record kind: dispatch | completion | surfacing | revision-emitted | revision-routed | revision',
    )
    .option('--path <path>', 'filter by slash-separated record path prefix')
    .option('--since <time>', 'show records at or after an epoch ms or ISO timestamp')
    .option('--last <n>', 'show only the last n matching records')
    .option('--json', 'emit matching semantic records as JSONL')
    .action((runId: string, flags: { kind?: string; path?: string; since?: string; last?: string; json?: boolean }) => {
      const records = readSemanticRecords(runId);
      if (!records) {
        process.stderr.write(`no semantic records for run "${runId}" in ${runsHome()}\n`);
        process.exitCode = 1;
        return;
      }
      const kinds = new Set<SemanticRunRecord['kind']>([
        'dispatch',
        'completion',
        'surfacing',
        'revision-emitted',
        'revision-routed',
      ]);
      const validKinds = [...kinds, 'revision'];
      if (flags.kind && !validKinds.includes(flags.kind)) {
        process.stderr.write(
          `--kind must be one of ${validKinds.join(' | ')}, got "${flags.kind}"\n`,
        );
        process.exitCode = 1;
        return;
      }
      let pathPrefix: string | undefined;
      if (flags.path != null) {
        pathPrefix = normalizeRecordPath(flags.path);
        if (!pathPrefix) {
          process.stderr.write('--path must contain at least one path segment\n');
          process.exitCode = 1;
          return;
        }
      }
      let since: number | undefined;
      let last: number | undefined;
      try {
        if (flags.since != null) since = parseSinceFlag(flags.since);
        if (flags.last != null) last = parsePositiveIntFlag(flags.last, '--last');
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
        return;
      }
      let filtered = flags.kind
        ? flags.kind === 'revision'
          ? records.filter(
              (r) => r.kind === 'revision-emitted' || r.kind === 'revision-routed',
            )
          : records.filter((r) => r.kind === flags.kind)
        : records;
      if (pathPrefix) filtered = filtered.filter((r) => matchesRecordPath(r, pathPrefix));
      if (since != null) filtered = filtered.filter((r) => r.ts >= since);
      if (last != null) filtered = filtered.slice(-last);
      if (flags.json) {
        for (const record of filtered) {
          process.stdout.write(`${JSON.stringify(record)}\n`);
        }
        return;
      }
      for (const record of filtered) {
        process.stdout.write(`${formatSemanticRecord(record)}\n`);
      }
    });

  await program.parseAsync(argv);
}
