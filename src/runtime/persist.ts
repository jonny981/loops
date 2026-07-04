/**
 * Optional durability for a run. This is not a durable execution engine;
 * mid-graph replay is an orchestration concern (use Temporal/Mastra for that).
 * It does two things:
 *
 *   - `makeRecorder(path)` appends every structured event as one JSON line, a
 *     readable run record. Token-delta noise is excluded.
 *   - `makeCheckpointer(path, state)` snapshots the shared run `state` at each
 *     loop/dag/job boundary. `loadCheckpoint(path)` restores it on the next run.
 *
 * The contract is that the workspace is the state: real progress lives on disk
 * (files, git), and the checkpoint restores the loop's shared scratchpad so a
 * re-run continues rather than starting cold. The body decides what to record in
 * `ctx.state` and how to act on it when resumed.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { LoopEvent } from '../core/types.ts';

/** High-frequency transcript deltas, excluded from the record. */
const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);

/** Event kinds that mark a boundary worth snapshotting state at. */
const CHECKPOINT_AT: ReadonlySet<LoopEvent['kind']> = new Set([
  'loop:iteration',
  'loop:end',
  'dag:end',
  'job:end',
]);

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
}

/** Append-only JSONL event sink. Truncates any existing file at the start. */
export function makeRecorder(path: string): (event: LoopEvent) => void {
  ensureDir(path);
  writeFileSync(path, '');
  return (event) => {
    if (NOISE.has(event.kind)) return;
    try {
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    } catch {
      /* best-effort: a record write must never break the run */
    }
  };
}

/** Snapshot the shared run state at each boundary (latest-wins, overwritten). */
export function makeCheckpointer(
  path: string,
  state: Record<string, unknown>,
): (event: LoopEvent) => void {
  ensureDir(path);
  return (event) => {
    if (!CHECKPOINT_AT.has(event.kind)) return;
    flushCheckpoint(path, state);
  };
}

/**
 * Write the shared run state to a checkpoint file immediately, outside the event
 * stream. Used to guarantee a paused run's state is durable before exit, even if
 * no boundary event flushed it. Best-effort; never throws.
 */
export function flushCheckpoint(
  path: string,
  state: Record<string, unknown>,
): void {
  ensureDir(path);
  try {
    writeFileSync(path, JSON.stringify({ ts: Date.now(), state }, null, 2));
  } catch {
    /* best-effort */
  }
}

/** Restore the shared run state written by a prior `makeCheckpointer`. */
export function loadCheckpoint(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    parsed &&
    typeof parsed === 'object' &&
    'state' in parsed &&
    (parsed as { state: unknown }).state &&
    typeof (parsed as { state: unknown }).state === 'object'
  ) {
    return (parsed as { state: Record<string, unknown> }).state;
  }
  return {};
}
