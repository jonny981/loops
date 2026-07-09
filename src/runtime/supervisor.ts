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
 * reads those files. No daemon, no socket: the filesystem is the channel.
 * Liveness is a pid check, so a crashed run is distinguishable from a live one.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  JobMeta,
  LoopEvent,
  Outcome,
  ProofRecord,
} from '../core/types.ts';
import { makeSemanticRecorder } from './semantic.ts';

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

export interface CurrentWork {
  kind: 'job' | 'dag-node';
  path: string[];
  label?: string;
  node?: string;
  startedAt: number;
  timeoutMs?: number;
  deadlineAt?: number;
}

export interface RunLive {
  path: string[];
  iteration: number;
  current?: CurrentWork;
  active?: Record<string, CurrentWork>;
  lastGate?: {
    which: string;
    met: boolean;
    confidence?: number;
    reason: string;
  };
  lastOutcome?: { status: string; summary?: string; late?: boolean };
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
  evidence?: {
    count: number;
    indexPath?: string;
    latest?: ProofRecord;
  };
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
  const semanticPath = join(dir, 'semantic.jsonl');
  const statusPath = join(dir, 'status.json');
  const evidencePath = join(dir, 'evidence.html');
  try {
    writeFileSync(eventsPath, '');
  } catch {
    /* best-effort */
  }
  const semanticSink = makeSemanticRecorder(semanticPath);

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
  const proofs: ProofRecord[] = [];
  const active = new Map<string, CurrentWork>();

  const activeKey = (kind: CurrentWork['kind'], path: readonly string[]) =>
    `${kind}:${path.join('\u0000')}`;
  const refreshCurrent = () => {
    status.live.active = active.size
      ? Object.fromEntries(active.entries())
      : undefined;
    status.live.current = [...active.values()].sort((a, b) => {
      if (a.path.join('\u0000') === b.path.join('\u0000') && a.kind !== b.kind)
        return a.kind === 'job' ? -1 : 1;
      const aDeadline = a.deadlineAt ?? Number.POSITIVE_INFINITY;
      const bDeadline = b.deadlineAt ?? Number.POSITIVE_INFINITY;
      const byDeadline = aDeadline - bDeadline;
      if (byDeadline !== 0) return byDeadline;
      if (a.kind !== b.kind) return a.kind === 'job' ? -1 : 1;
      return b.startedAt - a.startedAt;
    })[0];
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
      semanticSink(event);
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
        if (event.phase === 'start') {
          const work: CurrentWork = {
            kind: 'dag-node',
            path: [...event.path, event.node],
            node: event.node,
            startedAt: event.ts,
            timeoutMs: event.timeoutMs,
            deadlineAt: event.timeoutMs ? event.ts + event.timeoutMs : undefined,
          };
          active.set(activeKey('dag-node', work.path), work);
          refreshCurrent();
        } else {
          active.delete(activeKey('dag-node', [...event.path, event.node]));
          refreshCurrent();
        }
        break;
      case 'job:start': {
        const work: CurrentWork = {
          kind: 'job',
          path: event.path,
          label: event.label,
          startedAt: event.ts,
          timeoutMs: event.timeoutMs,
          deadlineAt: event.timeoutMs ? event.ts + event.timeoutMs : undefined,
        };
        active.set(activeKey('job', [...event.path, event.label]), work);
        refreshCurrent();
        break;
      }
      case 'loop:end':
      case 'dag:end':
      case 'job:end':
        status.live.lastOutcome = {
          status: event.outcome.status,
          summary: event.outcome.summary,
          late: event.outcome.late,
        };
        status.live.path = event.path;
        if (event.kind === 'job:end') {
          active.delete(activeKey('job', [...event.path, event.label]));
          refreshCurrent();
        }
        break;
      case 'engine:usage':
        status.live.usage.inputTokens += event.usage.inputTokens;
        status.live.usage.outputTokens += event.usage.outputTokens;
        status.live.usage.calls += 1;
        break;
      case 'proof': {
        const proof = {
          name: event.name,
          path: event.path,
          artifact: event.artifact,
        };
        proofs.push(proof);
        status.evidence = {
          count: proofs.length,
          indexPath: evidencePath,
          latest: proof,
        };
        break;
      }
    }
    if (!NOISE.has(event.kind)) writeStatus();
  };

  const finish = (outcome: Outcome) => {
    status.status = outcome.status;
    status.endedAt = Date.now();
    status.live.current = undefined;
    status.live.lastOutcome = {
      status: outcome.status,
      summary: outcome.summary,
      late: outcome.late,
    };
    if (proofs.length)
      writeEvidenceIndex(evidencePath, input.title, input.cwd, proofs);
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
  // Reject ids that could traverse outside the registry (`../…`): the id may
  // come from an untrusted caller (an agent over MCP), and every real id
  // matches `newRunId`'s alphabet.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runId)) return undefined;
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

export function runEvidenceIndexPath(runId: string): string {
  return join(runsHome(), runId, 'evidence.html');
}

/**
 * A one-read rollup of where a run is and what (if anything) is holding it:
 * `readRunStatus` plus a digest of the event-stream tail. `blocker` is a
 * heuristic read of that tail, not ground truth. The run only knows its status;
 * the blocker names the most plausible reason it is not moving.
 */
export interface RunProgress {
  runId: string;
  status: RunStatus['status'];
  alive?: boolean;
  title: string;
  /** `live.path` joined with ' / '; '(root)' when the run is at the top. */
  stage: string;
  iteration: number;
  lastGate?: RunLive['lastGate'];
  lastOutcome?: RunLive['lastOutcome'];
  usage: RunLive['usage'];
  current?: RunLive['current'] & {
    elapsedMs: number;
    remainingMs?: number;
  };
  evidence?: RunStatus['evidence'];
  startedAt: number;
  updatedAt: number;
  blocker?: {
    kind: 'gate-failing' | 'limit-pause' | 'human-gate' | 'error';
    detail: string;
  };
  /** The most recent events, rendered through `formatEvent`. */
  recent: string[];
}

/** How far back into events.jsonl the rollup reads (lines, before parsing). */
const PROGRESS_TAIL = 200;
/** Byte window read from the end of events.jsonl. A long run's stream can be
 *  tens of MB and `loops status` reads this on every invocation, so the read
 *  stays O(tail), not O(run). Sized for generous per-line headroom over
 *  `PROGRESS_TAIL` records. */
const PROGRESS_TAIL_BYTES = 256 * 1024;

/** Parse the tail of a run's event stream, skipping unparseable lines so a
 *  torn write never breaks a read. */
function readEventTail(runId: string): LoopEvent[] {
  let raw: string;
  try {
    const fd = openSync(runEventsPath(runId), 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - PROGRESS_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      // A mid-file window opens on a torn line (and possibly a torn UTF-8
      // sequence); drop everything up to the first newline.
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const events: LoopEvent[] = [];
  for (const line of raw.split('\n').slice(-PROGRESS_TAIL)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LoopEvent);
    } catch {
      /* skip an unparseable line */
    }
  }
  return events;
}

/** Scan the tail backwards for the first blocking signal (first match wins). */
function deriveBlocker(
  status: RunStatus['status'],
  events: LoopEvent[],
  live: RunLive,
): RunProgress['blocker'] {
  // A run that ended in success has nothing blocking it, whatever its tail
  // holds (e.g. a recovered mid-run error).
  if (status === 'pass') return undefined;
  // Pause events are hard stops: within one events file a `human:gate` or
  // `limit:pause` means the run is pausing (an acked gate never emits the
  // event, and a resumed run writes a fresh file), so neither is cleared by
  // later events. A pausing dag still appends its in-flight siblings'
  // completions after the pause event. A recovered error is different: any
  // later sign of progress (an iteration, a node, a pass) clears it.
  let progressSince = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'human:gate')
      return { kind: 'human-gate', detail: `${e.name}: ${e.prompt}` };
    if (e.kind === 'limit:pause')
      return { kind: 'limit-pause', detail: e.reason };
    if (e.kind === 'error' && !progressSince)
      return { kind: 'error', detail: e.message };
    if (
      e.kind === 'loop:iteration' ||
      e.kind === 'dag:node' ||
      ((e.kind === 'loop:end' || e.kind === 'dag:end') &&
        e.outcome.status === 'pass')
    )
      progressSince = true;
  }
  if (live.lastGate && live.lastGate.met === false)
    return { kind: 'gate-failing', detail: live.lastGate.reason };
  return undefined;
}

/** Build a `RunProgress` rollup for a run; undefined when the run is unknown. */
export function readRunProgress(
  runId: string,
  opts?: { recent?: number },
): RunProgress | undefined {
  const status = readRunStatus(runId);
  if (!status) return undefined;
  const tail = readEventTail(runId);
  const now = Date.now();
  const current = status.live.current
    ? {
        ...status.live.current,
        elapsedMs: Math.max(0, now - status.live.current.startedAt),
        remainingMs: status.live.current.deadlineAt
          ? Math.max(0, status.live.current.deadlineAt - now)
          : undefined,
      }
    : undefined;
  return {
    runId: status.runId,
    status: status.status,
    alive: status.alive,
    title: status.title,
    stage: status.live.path.length ? status.live.path.join(' / ') : '(root)',
    iteration: status.live.iteration,
    lastGate: status.live.lastGate,
    lastOutcome: status.live.lastOutcome,
    usage: status.live.usage,
    current,
    evidence: status.evidence,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    blocker: deriveBlocker(status.status, tail, status.live),
    recent: tail.slice(-(opts?.recent ?? 10)).map(formatEvent),
  };
}

/** Path to a run's semantic record stream. */
export function runSemanticRecordsPath(runId: string): string {
  return join(runsHome(), runId, 'semantic.jsonl');
}

/** Flatten model-influenced text (gate reasons, outcome summaries, prompts,
 *  error messages) to a single terminal-safe line: control characters could
 *  spoof output lines or carry ANSI/OSC escape sequences. `formatEvent` applies
 *  it to every rendered event, and the CLI applies it to the lines it composes
 *  from `status.json` itself. */
export function toLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** A compact one-line rendering of an event, for `loops tail`/`status`.
 *  Always sanitised (`toLine`): event text quotes judges, agents, and
 *  subprocesses, and the rendering goes straight to a terminal. */
export function formatEvent(event: LoopEvent): string {
  return toLine(renderEvent(event));
}

function renderEvent(event: LoopEvent): string {
  const at = event.path.length ? `${event.path.join(' › ')} ` : '';
  switch (event.kind) {
    case 'runtime:restore':
      return event.reason;
    case 'loop:start':
      return `${at}▸ loop${event.max ? ` (max ${event.max})` : ''}`;
    case 'dag:start':
      return `${at}▸ dag (${event.nodes.length} nodes)`;
    case 'loop:iteration':
      return `${at}· iteration ${event.iteration}`;
    case 'loop:condition':
      return `${at}· ${event.which} ${event.result.met ? 'met' : 'not met'}: ${event.result.reason}`;
    case 'loop:review':
      return `${at}· review: ${event.outcome.status}${event.outcome.late ? ' late' : ''}`;
    case 'loop:end':
      return `${at}◂ ${event.outcome.status}${event.outcome.late ? ' late' : ''} (${event.iterations} iter)`;
    case 'dag:node':
      return `${at}· node ${event.node}: ${event.phase}${event.outcome ? ` (${event.outcome.status}${event.outcome.late ? ' late' : ''})` : ''}`;
    case 'dag:kickback':
      return `${at}↩ kickback ${event.accepted ? 'accepted' : 'rejected'} ${event.from} -> ${event.to}: ${event.reason}${event.note ? ` (${event.note})` : ''}`;
    case 'dag:end':
      return `${at}◂ dag ${event.outcome.status}${event.outcome.late ? ' late' : ''}`;
    case 'job:start':
      return `${at}• ${event.label}`;
    case 'advisor:consult':
      return `${at}◇ advisor ${event.label} #${event.call}: ${event.question}`;
    case 'proof':
      return `${at}◈ proof ${event.name}: ${event.artifact.title ?? event.artifact.path ?? event.artifact.kind}`;
    case 'job:end':
      return `${at}• ${event.label}: ${event.outcome.status}${event.outcome.late ? ' late' : ''}`;
    case 'engine:tool':
      return `${at}  tool ${event.name} ${event.phase}`;
    case 'engine:usage':
      return `${at}  ${event.model}: ${event.usage.inputTokens}/${event.usage.outputTokens} tok`;
    case 'loop:stall':
      return `${at}⏹ stalled after ${event.report.iterations.length} no-progress iterations: ${event.report.reason}`;
    case 'limit:wait':
      return `${at}⏸ limit ${event.code}: waiting ${Math.round(event.waitMs / 1000)}s`;
    case 'limit:pause':
      return `${at}⏸ paused (${event.code}): ${event.reason}`;
    case 'human:gate':
      return `${at}⏸ human gate "${event.name}": ${event.prompt}`;
    case 'log':
      return `${at}${event.message}`;
    case 'error':
      return `${at}✗ ${event.code}: ${event.message}`;
    default:
      return `${at}${event.kind}`;
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function previewData(data: unknown): string {
  let text: string;
  try {
    text =
      typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    text = String(data);
  }
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

function writeEvidenceIndex(
  path: string,
  title: string,
  cwd: string,
  proofs: ProofRecord[],
): void {
  const items = proofs
    .map((proof) => {
      const artifact = proof.artifact;
      const heading = artifact.title ?? proof.name;
      const location = proof.path.length ? proof.path.join(' / ') : '(root)';
      const artifactPath =
        artifact.path && isAbsolute(artifact.path)
          ? artifact.path
          : artifact.path
            ? resolvePath(cwd, artifact.path)
            : undefined;
      const link = artifact.path
        ? `<p><a href="${escapeHtml(artifactPath)}">${escapeHtml(artifact.path)}</a></p>`
        : '';
      const description = artifact.description
        ? `<p>${escapeHtml(artifact.description)}</p>`
        : '';
      const preview =
        artifact.data !== undefined
          ? `<pre>${escapeHtml(previewData(artifact.data))}</pre>`
          : artifact.kind === 'image' && artifactPath
            ? `<img src="${escapeHtml(artifactPath)}" alt="${escapeHtml(heading)}" loading="lazy" />`
            : '';
      return `<article>
  <h2>${escapeHtml(heading)}</h2>
  <p><strong>${escapeHtml(proof.name)}</strong> | ${escapeHtml(artifact.kind)} | ${escapeHtml(location)}</p>
  ${description}
  ${link}
  ${preview}
</article>`;
    })
    .join('\n');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} evidence</title>
  <style>
    body { font: 14px/1.45 system-ui, sans-serif; margin: 32px; max-width: 960px; }
    article { border-top: 1px solid #ddd; padding: 18px 0; }
    h1, h2 { line-height: 1.15; }
    pre { background: #f6f6f6; overflow: auto; padding: 12px; }
    img { max-width: 100%; height: auto; border: 1px solid #ddd; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)} evidence</h1>
  ${items}
</body>
</html>
`;
  try {
    writeFileSync(path, html);
  } catch {
    /* best-effort */
  }
}
