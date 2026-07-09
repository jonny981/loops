/**
 * Executes a validated `HelmIntent` against the loops runtime and returns a
 * deterministic `Observation` the driver can act on. Two substrates, chosen
 * per action:
 *
 * - `validate` / `author` / `run` / `ack` **spawn the loops bin**: a fresh
 *   process per call means an edited recipe never fights the ESM import
 *   cache, dispatched runs survive the helm exiting (fire-and-poll), and the
 *   driver sees the CLI's fix-oriented errors verbatim.
 * - `status` / `records` read the supervision registry in-process
 *   (`~/.loops/runs`, honoring `LOOPS_HOME`): the filesystem is the channel,
 *   same as `loops list`/`status`/`records`.
 *
 * The bridge never runs free-form shell: the only thing it executes is the
 * loops CLI, against paths contained in its workspace.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isAlive,
  listRuns,
  newRunId,
  readRunProgress,
  readRunStatus,
  type RunProgress,
} from '../runtime/supervisor.ts';
import {
  formatSemanticRecord,
  readSemanticRecords,
} from '../runtime/semantic.ts';
import { truncate } from '../core/text.ts';
import type { HelmAction, HelmIntent } from './intent.ts';

/** What the driver is told after an action executes. `summary` is one line;
 *  `detail` is the evidence channel (clamped when composed into a prompt). */
export interface Observation {
  ok: boolean;
  action: HelmAction;
  summary: string;
  detail?: string;
  data?: unknown;
  /** Set when the action dispatched or resumed a background run. */
  runId?: string;
}

export interface HelmBridgeOptions {
  /** The workspace every file path is contained within. */
  cwd: string;
  /** Path to the loops bin; defaults to this package's `bin/loops.mjs`. */
  bin?: string;
  /** Extra args appended to every dispatched run (e.g. `--engine`, `--permission-mode`). */
  runArgs?: string[];
  /** Extra env for spawned processes, merged over the parent env. */
  env?: Record<string, string>;
  /** Ceiling on runs dispatched through this bridge (default 8). */
  maxRuns?: number;
  /** How long to wait for a dispatched run to register, in ms (default 5000). */
  dispatchWaitMs?: number;
  /** Timeout for synchronous CLI calls (validate), in ms (default 60000). */
  cliTimeoutMs?: number;
}

const DEFAULT_MAX_RUNS = 8;
const DETAIL_MAX = 4000;

function packageBin(): string {
  // Two hops up from src/helm/, one from a flat dist/ chunk; PATH otherwise.
  for (const rel of ['../../bin/loops.mjs', '../bin/loops.mjs']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  return 'loops';
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export class HelmBridge {
  private readonly cwd: string;
  private readonly bin: string;
  private readonly authored = new Set<string>();
  /** Runs dispatched by this bridge: what `ack` needs to respawn one. */
  private readonly runs = new Map<string, { file: string; args: string[] }>();

  constructor(private readonly opts: HelmBridgeOptions) {
    this.cwd = resolve(opts.cwd);
    this.bin = opts.bin ?? packageBin();
  }

  /** Runs dispatched so far (the governor the session surfaces in-context). */
  dispatched(): number {
    return this.runs.size;
  }

  /** How to invoke the loops CLI: through node for a script path, directly
   *  for a PATH binary. */
  private cli(): { command: string; prefix: string[] } {
    return isAbsolute(this.bin)
      ? { command: process.execPath, prefix: [this.bin] }
      : { command: this.bin, prefix: [] };
  }

  async execute(intent: HelmIntent): Promise<Observation> {
    switch (intent.action) {
      case 'answer':
        return { ok: true, action: 'answer', summary: 'answered' };
      case 'done':
        return { ok: true, action: 'done', summary: 'done' };
      case 'author':
        return this.author(intent.file, intent.source);
      case 'validate':
        return this.validate(intent.file);
      case 'run':
        return this.dispatch('run', intent.file, intent.args ?? []);
      case 'status':
        return this.status(intent.runId);
      case 'records':
        return this.records(intent.runId, intent.kind, intent.last);
      case 'ack':
        return this.ack(intent.runId, intent.gate);
      case 'stop_run':
        return this.stop(intent.runId);
    }
  }

  /** Resolve a recipe path inside the workspace, or explain why not. */
  private contain(file: string): { path: string } | { error: string } {
    if (isAbsolute(file) || file.startsWith('~')) {
      return { error: `path must be relative to the workspace, got "${file}"` };
    }
    const resolved = resolve(this.cwd, file);
    const rel = relative(this.cwd, resolved);
    if (rel.startsWith('..') || rel.split(sep).includes('..')) {
      return { error: `path escapes the workspace: "${file}"` };
    }
    return { path: resolved };
  }

  private author(file: string, source: string): Observation {
    const fail = (summary: string): Observation => ({
      ok: false,
      action: 'author',
      summary,
    });
    if (!file.endsWith('.loop.ts')) {
      return fail(`recipe files are named *.loop.ts, got "${file}"`);
    }
    const contained = this.contain(file);
    if ('error' in contained) return fail(contained.error);
    if (existsSync(contained.path) && !this.authored.has(contained.path)) {
      return fail(
        `refusing to overwrite ${file}: it exists and was not authored in this session`,
      );
    }
    try {
      mkdirSync(dirname(contained.path), { recursive: true });
      writeFileSync(contained.path, source);
    } catch (e) {
      return fail(`could not write ${file}: ${message(e)}`);
    }
    this.authored.add(contained.path);
    // Validate immediately: a broken recipe comes back as a fix-oriented
    // observation on the same step, before a run is ever dispatched.
    const validated = this.validate(file);
    return {
      ...validated,
      action: 'author',
      summary: validated.ok
        ? `authored ${file}; it loads`
        : `authored ${file}, but it does not load`,
    };
  }

  private validate(file: string): Observation {
    const contained = this.contain(file);
    if ('error' in contained) {
      return { ok: false, action: 'validate', summary: contained.error };
    }
    if (!existsSync(contained.path)) {
      return {
        ok: false,
        action: 'validate',
        summary: `no such file: ${file} (author it first)`,
      };
    }
    const invoke = this.cli();
    const result = spawnSync(
      invoke.command,
      [...invoke.prefix, 'validate', contained.path],
      {
        cwd: this.cwd,
        env: { ...process.env, ...this.opts.env },
        encoding: 'utf8',
        timeout: this.opts.cliTimeoutMs ?? 60_000,
      },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    const ok = result.status === 0;
    return {
      ok,
      action: 'validate',
      summary: ok ? `${file} loads` : `${file} failed validation`,
      detail: truncate(out, DETAIL_MAX),
    };
  }

  private async dispatch(
    action: 'run' | 'ack',
    file: string,
    args: string[],
    extraArgs: string[] = [],
  ): Promise<Observation> {
    const fail = (summary: string, detail?: string): Observation => ({
      ok: false,
      action,
      summary,
      detail,
    });
    const max = this.opts.maxRuns ?? DEFAULT_MAX_RUNS;
    if (this.runs.size >= max) {
      return fail(
        `run budget spent (${this.runs.size}/${max} dispatched); observe or stop existing runs instead`,
      );
    }
    const contained = this.contain(file);
    if ('error' in contained) return fail(contained.error);
    if (!existsSync(contained.path)) {
      return fail(`no such file: ${file} (author it first)`);
    }
    // The bridge owns supervision and identity; strip any competing flags.
    const owned = new Set(['--supervise', '--run-id', '--tui']);
    const cleanArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (owned.has(arg)) {
        if (arg === '--run-id') i += 1;
        continue;
      }
      cleanArgs.push(arg);
    }
    const runId = newRunId(basename(file).replace(/\.(loop\.)?ts$/, ''));
    const home =
      this.opts.env?.LOOPS_HOME ??
      process.env.LOOPS_HOME ??
      join(process.env.HOME ?? '', '.loops');
    const runDir = join(home, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const logPath = join(runDir, 'spawn.log');
    const log = openSync(logPath, 'a');
    const invoke = this.cli();
    let child;
    try {
      child = spawn(
        invoke.command,
        [
          ...invoke.prefix,
          'run',
          contained.path,
          '--no-tui',
          '--supervise',
          '--run-id',
          runId,
          ...cleanArgs,
          ...extraArgs,
          ...(this.opts.runArgs ?? []),
        ],
        {
          cwd: this.cwd,
          env: { ...process.env, ...this.opts.env },
          detached: true,
          stdio: ['ignore', log, log],
        },
      );
      child.unref();
    } finally {
      closeSync(log);
    }
    this.runs.set(runId, { file, args: cleanArgs });

    // Fire-and-poll, but catch an instant crash (bad flag, missing engine) so
    // the driver gets substantive feedback instead of a dead runId.
    const deadline = Date.now() + (this.opts.dispatchWaitMs ?? 5000);
    let exited: number | undefined;
    child.once('exit', (code) => {
      exited = code ?? 1;
    });
    while (Date.now() < deadline) {
      if (readRunStatus(runId)) {
        return {
          ok: true,
          action,
          runId,
          summary: `dispatched ${runId} (${file}); it runs in the background — poll with status`,
        };
      }
      if (exited !== undefined && exited !== 0) break;
      await sleep(120);
    }
    if (exited !== undefined && exited !== 0) {
      this.runs.delete(runId);
      return fail(
        `dispatch of ${file} exited ${exited} before registering`,
        truncate(tailOf(logPath), 1500),
      );
    }
    return {
      ok: true,
      action,
      runId,
      summary: `dispatched ${runId} (${file}); not yet registered — poll with status`,
    };
  }

  private status(runId?: string): Observation {
    if (runId) {
      const progress = readRunProgress(runId, { recent: 8 });
      if (!progress) {
        return {
          ok: false,
          action: 'status',
          summary: `unknown run "${runId}"`,
        };
      }
      return {
        ok: true,
        action: 'status',
        summary: statusLine(progress),
        detail: truncate(statusDetail(progress), DETAIL_MAX),
        data: progress,
        runId,
      };
    }
    const runs = listRuns().slice(0, 10);
    if (!runs.length) {
      return { ok: true, action: 'status', summary: 'no supervised runs' };
    }
    const lines = runs.map(
      (r) =>
        `${r.runId}  ${r.status}${r.status === 'running' && r.alive === false ? ' (dead)' : ''}  ${r.live.path.join(' / ') || '(root)'}  iter ${r.live.iteration}`,
    );
    return {
      ok: true,
      action: 'status',
      summary: `${runs.length} run(s); most recent: ${runs[0]!.runId} (${runs[0]!.status})`,
      detail: lines.join('\n'),
      data: runs.map((r) => ({ runId: r.runId, status: r.status })),
    };
  }

  private records(
    runId: string,
    kind?: string,
    last?: number,
  ): Observation {
    const all = readSemanticRecords(runId);
    if (!all) {
      return {
        ok: false,
        action: 'records',
        summary: `no semantic records for run "${runId}"`,
      };
    }
    const filtered = kind
      ? kind === 'revision'
        ? all.filter(
            (r) =>
              r.kind === 'revision-emitted' || r.kind === 'revision-routed',
          )
        : all.filter((r) => r.kind === kind)
      : all;
    const shown = filtered.slice(-(last ?? 20));
    return {
      ok: true,
      action: 'records',
      summary: `${filtered.length} record(s)${kind ? ` of kind ${kind}` : ''} for ${runId}${shown.length < filtered.length ? ` (showing last ${shown.length})` : ''}`,
      detail: truncate(shown.map(formatSemanticRecord).join('\n'), DETAIL_MAX),
      data: shown,
      runId,
    };
  }

  private async ack(runId: string, gate: string): Promise<Observation> {
    const known = this.runs.get(runId);
    if (!known) {
      return {
        ok: false,
        action: 'ack',
        summary: `unknown run "${runId}": only a run dispatched in this session can be acked (a human can resume any run with \`loops run <file> --ack ${gate}\`)`,
      };
    }
    const current = readRunStatus(runId);
    if (current && current.status === 'running' && isAlive(current.pid)) {
      return {
        ok: false,
        action: 'ack',
        summary: `${runId} is still running; ack resumes a paused run`,
      };
    }
    const resumed = await this.dispatch('ack', known.file, known.args, [
      '--ack',
      gate,
    ]);
    if (!resumed.ok) return resumed;
    return {
      ...resumed,
      summary: `acked gate "${gate}": resumed ${known.file} as ${resumed.runId} (was ${runId})`,
    };
  }

  private stop(runId: string): Observation {
    const status = readRunStatus(runId);
    if (!status) {
      return { ok: false, action: 'stop_run', summary: `unknown run "${runId}"` };
    }
    if (status.status !== 'running' || !isAlive(status.pid)) {
      return {
        ok: false,
        action: 'stop_run',
        summary: `${runId} is not running (status: ${status.status})`,
      };
    }
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch (e) {
      return {
        ok: false,
        action: 'stop_run',
        summary: `could not stop ${runId}: ${message(e)}`,
      };
    }
    return {
      ok: true,
      action: 'stop_run',
      summary: `sent SIGTERM to ${runId} (pid ${status.pid})`,
      runId,
    };
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tailOf(path: string): string {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.slice(-2000);
  } catch {
    return '';
  }
}

function statusLine(p: RunProgress): string {
  const liveness =
    p.status === 'running' ? (p.alive ? 'running' : 'running (dead process)') : p.status;
  return `${p.runId}: ${liveness}, at ${p.stage}, iteration ${p.iteration}${p.blocker ? ` — blocked: ${p.blocker.kind}` : ''}`;
}

function statusDetail(p: RunProgress): string {
  const lines = [
    `status: ${p.status}${p.alive === false && p.status === 'running' ? ' (process dead)' : ''}`,
    `stage: ${p.stage}  iteration: ${p.iteration}`,
  ];
  if (p.lastGate) {
    lines.push(
      `last gate: ${p.lastGate.which} ${p.lastGate.met ? 'met' : 'not met'}${p.lastGate.confidence != null ? ` (${p.lastGate.confidence})` : ''}: ${p.lastGate.reason}`,
    );
  }
  if (p.lastOutcome) {
    lines.push(
      `last outcome: ${p.lastOutcome.status}${p.lastOutcome.summary ? ` — ${p.lastOutcome.summary}` : ''}`,
    );
  }
  if (p.blocker) lines.push(`blocker: ${p.blocker.kind} — ${p.blocker.detail}`);
  lines.push(
    `usage: ${p.usage.inputTokens}/${p.usage.outputTokens} tokens over ${p.usage.calls} calls`,
  );
  if (p.recent.length) lines.push('recent:', ...p.recent.map((l) => `  ${l}`));
  return lines.join('\n');
}
