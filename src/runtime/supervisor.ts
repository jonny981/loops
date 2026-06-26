/**
 * Out-of-process supervision. A supervised run registers itself under a global
 * registry (`~/.loops/runs/<runId>/`) and writes its live state there as it goes:
 *
 *   - `status.json`: a snapshot rewritten at each boundary: the run's shape (the
 *     static `JobMeta`) plus where it is right now (path, iteration, last gate
 *     verdict and confidence, last outcome, token usage, terminal status at end).
 *   - `events.jsonl`: the event stream appended live (the same record `recordTo`
 *     writes, here automatically and in the registry).
 *
 * A separate process (a human `loops list/status/tail`, or an agent over MCP)
 * reads those files. No daemon, no socket: the filesystem is the channel, which
 * is the same "the workspace is the state" bet the rest of the library makes.
 * Liveness is a pid check, so a crashed run is distinguishable from a live one.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { JobMeta, LoopEvent, Outcome } from '../core/types.ts';

/** High-frequency transcript deltas: kept out of the record, as in `recordTo`. */
const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);

/** The registry root. `LOOPS_HOME` overrides `~/.loops` (used to isolate tests). */
export function runsHome(): string {
  const base = process.env.LOOPS_HOME ?? join(homedir(), '.loops');
  return join(base, 'runs');
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'run'
  );
}

/** A readable, unique run id: a slug of the loop's name plus a short random tail. */
export function newRunId(title: string): string {
  return `${slug(title)}-${randomBytes(3).toString('hex')}`;
}

export interface RunLive {
  path: string[];
  iteration: number;
  lastGate?: {
    which: string;
    met: boolean;
    confidence?: number;
    reason: string;
  };
  lastOutcome?: { status: string; summary?: string };
  usage: { inputTokens: number; outputTokens: number; calls: number };
}

export interface RunStatus {
  runId: string;
  pid: number;
  cwd: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  /** Stored disposition: `running` until the run ends, then the terminal status. */
  status: 'running' | Outcome['status'];
  /** Whether the owning process is still alive: computed on read, not stored. */
  alive?: boolean;
  shape?: JobMeta;
  live: RunLive;
}

export interface Supervisor {
  runId: string;
  dir: string;
  /** Wire into the run's event sinks. */
  sink: (event: LoopEvent) => void;
  /** Record the terminal outcome. */
  finish: (outcome: Outcome) => void;
}

/** Begin supervising a run: create its registry dir and seed `status.json`. */
export function startSupervisor(input: {
  runId: string;
  cwd: string;
  title: string;
  shape?: JobMeta;
}): Supervisor {
  const dir = join(runsHome(), input.runId);
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, 'events.jsonl');
  const statusPath = join(dir, 'status.json');
  try {
    writeFileSync(eventsPath, '');
  } catch {
    /* best-effort */
  }

  const status: RunStatus = {
    runId: input.runId,
    pid: process.pid,
    cwd: input.cwd,
    title: input.title,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    shape: input.shape,
    live: {
      path: [],
      iteration: 0,
      usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    },
  };

  const writeStatus = () => {
    status.updatedAt = Date.now();
    try {
      writeFileSync(statusPath, JSON.stringify(status, null, 2));
    } catch {
      /* best-effort: a status write must never break the run */
    }
  };
  writeStatus();

  const sink = (event: LoopEvent) => {
    if (!NOISE.has(event.kind)) {
      try {
        appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
      } catch {
        /* best-effort */
      }
    }
    switch (event.kind) {
      case 'loop:iteration':
        status.live.path = event.path;
        status.live.iteration = event.iteration;
        break;
      case 'loop:condition':
        status.live.lastGate = {
          which: event.which,
          met: event.result.met,
          confidence: event.result.confidence,
          reason: event.result.reason,
        };
        break;
      case 'dag:node':
        status.live.path = [...event.path, event.node];
        break;
      case 'loop:end':
      case 'dag:end':
      case 'job:end':
        status.live.lastOutcome = {
          status: event.outcome.status,
          summary: event.outcome.summary,
        };
        status.live.path = event.path;
        break;
      case 'engine:usage':
        status.live.usage.inputTokens += event.usage.inputTokens;
        status.live.usage.outputTokens += event.usage.outputTokens;
        status.live.usage.calls += 1;
        break;
    }
    if (!NOISE.has(event.kind)) writeStatus();
  };

  const finish = (outcome: Outcome) => {
    status.status = outcome.status;
    status.endedAt = Date.now();
    status.live.lastOutcome = {
      status: outcome.status,
      summary: outcome.summary,
    };
    writeStatus();
  };

  return { runId: input.runId, dir, sink, finish };
}

// ── Reading side ────────────────────────────────────────────────────────────

/** Whether a pid is a live process (signal 0 probes without delivering). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read one run's status, with `alive` computed from its pid. */
export function readRunStatus(runId: string): RunStatus | undefined {
  try {
    const raw = readFileSync(join(runsHome(), runId, 'status.json'), 'utf8');
    const s = JSON.parse(raw) as RunStatus;
    s.alive = s.status === 'running' ? isAlive(s.pid) : false;
    return s;
  } catch {
    return undefined;
  }
}

/** All known runs, newest first. */
export function listRuns(): RunStatus[] {
  const base = runsHome();
  if (!existsSync(base)) return [];
  const out: RunStatus[] = [];
  for (const id of readdirSync(base)) {
    const s = readRunStatus(id);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Path to a run's appended event stream (for tailing). */
export function runEventsPath(runId: string): string {
  return join(runsHome(), runId, 'events.jsonl');
}

/** A compact one-line rendering of an event, for `loops tail`. */
export function formatEvent(event: LoopEvent): string {
  const at = event.path.length ? `${event.path.join(' › ')} ` : '';
  switch (event.kind) {
    case 'loop:start':
      return `${at}▸ loop${event.max ? ` (max ${event.max})` : ''}`;
    case 'dag:start':
      return `${at}▸ dag (${event.nodes.length} nodes)`;
    case 'loop:iteration':
      return `${at}· iteration ${event.iteration}`;
    case 'loop:condition':
      return `${at}· ${event.which} ${event.result.met ? 'met' : 'not met'}: ${event.result.reason}`;
    case 'loop:review':
      return `${at}· review: ${event.outcome.status}`;
    case 'loop:end':
      return `${at}◂ ${event.outcome.status} (${event.iterations} iter)`;
    case 'dag:node':
      return `${at}· node ${event.node}: ${event.phase}${event.outcome ? ` (${event.outcome.status})` : ''}`;
    case 'dag:end':
      return `${at}◂ dag ${event.outcome.status}`;
    case 'job:start':
      return `${at}• ${event.label}`;
    case 'job:end':
      return `${at}• ${event.label}: ${event.outcome.status}`;
    case 'engine:tool':
      return `${at}  tool ${event.name} ${event.phase}`;
    case 'engine:usage':
      return `${at}  ${event.model}: ${event.usage.inputTokens}/${event.usage.outputTokens} tok`;
    case 'limit:wait':
      return `${at}⏸ limit ${event.code}: waiting ${Math.round(event.waitMs / 1000)}s`;
    case 'limit:pause':
      return `${at}⏸ paused (${event.code}): ${event.reason}`;
    case 'log':
      return `${at}${event.message}`;
    case 'error':
      return `${at}✗ ${event.code}: ${event.message}`;
    default:
      return `${at}${event.kind}`;
  }
}
