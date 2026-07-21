/**
 * The out-of-process control channel — the registry's write side, and the
 * substrate steering needs (docs/momentum.md). A supervised run polls
 * `~/.loops/runs/<runId>/control.jsonl` for appended commands; another
 * process (`loops control` / `loops steer`, a helm driver, an agent over MCP)
 * appends them. Same design as the rest of supervision: no daemon, no socket,
 * the filesystem is the channel.
 *
 * Three commands:
 *   - `pause` — sets the run's shared pause flag; loops and dags read it at
 *     their safepoints (iteration boundary; before a node starts) and finish
 *     `paused` — the same resumable halt (exit 75) a human gate produces.
 *   - `abort` — aborts the run's root controller, as SIGINT would.
 *   - `steer` — applies an edit batch to a registered `LivePlan` by name.
 *     Acceptance is decided by the plan (the live toposort + the running
 *     dag's guards); accepted edits are emitted by the dag as `dag:edit`
 *     events, refused batches are emitted by the runner with `accepted: false`
 *     and the refusal reason, so the audit trail records both.
 */

import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** Size of a file by path (throws when absent). */
function fstatAtPath(path: string): number {
  return statSync(path).size;
}

import { LoopError } from '../core/errors.ts';
import type { PlanEdit } from '../core/plan.ts';
import { runsHome } from './supervisor.ts';

export interface ControlCommand {
  /** Stamped by the writer; informational. */
  ts?: number;
  cmd: 'pause' | 'abort' | 'steer';
  /** pause/abort: surfaced in the paused summary / log line. */
  reason?: string;
  /** steer: the registered live-plan name. Defaults to the run's only plan. */
  plan?: string;
  /** steer: the edit batch, applied atomically (all-or-nothing). */
  edits?: PlanEdit[];
}

const RUN_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Path to a run's control command stream. */
export function controlPath(runId: string): string {
  return join(runsHome(), runId, 'control.jsonl');
}

/** Append a command for a run — the write side, used from another process. */
export function requestControl(runId: string, command: ControlCommand): void {
  if (!RUN_ID.test(runId))
    throw new LoopError({
      code: 'CONFIG',
      message: `runId must match [a-z0-9][a-z0-9-]*, got "${runId}"`,
    });
  mkdirSync(join(runsHome(), runId), { recursive: true });
  appendFileSync(
    controlPath(runId),
    `${JSON.stringify({ ts: Date.now(), ...command })}\n`,
  );
}

export interface ControlChannel {
  stop(): void;
  /** Read and dispatch any new commands immediately (poll off-schedule). */
  poll(): void;
}

/**
 * Poll a run's control stream and dispatch each appended command once, in
 * order. Byte-offset tailing with torn-line holdback, so a mid-write append
 * never produces a garbled command; an unparseable line is skipped, never
 * fatal. The interval timer is unref'd — the channel never pins the process.
 */
export function startControlChannel(opts: {
  runId: string;
  onCommand: (command: ControlCommand) => void;
  intervalMs?: number;
}): ControlChannel {
  // Commands target a LIVE run: start at the file's current end so commands
  // written before this channel opened are never replayed. Without this, a
  // resumed run would immediately re-execute the very `pause` (or worse,
  // `abort`) that ended its previous life.
  let offset = 0;
  try {
    offset = fstatAtPath(controlPath(opts.runId));
  } catch {
    /* no control file yet: start at 0 */
  }
  let pending = '';
  const poll = () => {
    let chunk: string | undefined;
    try {
      const fd = openSync(controlPath(opts.runId), 'r');
      try {
        const size = fstatSync(fd).size;
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          chunk = buf.toString('utf8');
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return; // no control file yet
    }
    if (!chunk) return;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? ''; // hold a torn tail for the next poll
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const command = JSON.parse(line) as ControlCommand;
        if (
          command &&
          (command.cmd === 'pause' ||
            command.cmd === 'abort' ||
            command.cmd === 'steer')
        )
          opts.onCommand(command);
      } catch {
        /* skip an unparseable line */
      }
    }
  };
  const timer = setInterval(poll, opts.intervalMs ?? 500);
  timer.unref?.();
  return { stop: () => clearInterval(timer), poll };
}
