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
import { z } from 'zod';

import type {
  CheckpointControl,
  CheckpointDagNode,
  LoopEvent,
  Outcome,
} from '../core/types.ts';

/** High-frequency transcript deltas, excluded from the record. */
const NOISE: ReadonlySet<LoopEvent['kind']> = new Set([
  'engine:text',
  'engine:thinking',
]);

/** Event kinds that mark a boundary worth snapshotting state at. */
const CHECKPOINT_AT: ReadonlySet<LoopEvent['kind']> = new Set([
  'loop:iteration',
  'loop:end',
  'dag:node',
  'dag:end',
  'job:end',
]);

const MAX_CHECKPOINT_DIAGNOSTICS = 8;
const MAX_CHECKPOINT_DIAGNOSTIC_PATH_CHARS = 240;
const MAX_CHECKPOINT_DIAGNOSTIC_REASON_CHARS = 160;

const checkpointFeedbackDecisionSchema = z.enum([
  'accepted',
  'rejected',
  'deferred',
  'escalated',
]);
const checkpointFeedbackFindingSchema = z
  .object({
    reviewer: z.string().optional(),
    severity: z
      .enum([
        'block',
        'should-fix',
        'nice-to-have',
        'approve',
        'blocking',
        'advisory',
      ])
      .optional(),
    decision: checkpointFeedbackDecisionSchema.optional(),
    scope: z.string().optional(),
    evidence: z.string(),
    recommendation: z.string().optional(),
  })
  .passthrough();
const checkpointRevisionSchema = z
  .object({
    target: z.string().optional(),
    reason: z.string(),
    findings: z.array(checkpointFeedbackFindingSchema).optional(),
    rerun: z.literal('target-and-dependents').optional(),
    source: z.string().optional(),
    decision: checkpointFeedbackDecisionSchema.optional(),
  })
  .passthrough();
const checkpointStallSchema = z
  .object({
    window: z.number(),
    iterations: z.array(z.number()),
    reason: z.string(),
    evidence: z.array(z.string()),
  })
  .passthrough();
const checkpointOutcomeSchema = z
  .object({
    status: z.enum(['pass', 'fail', 'aborted', 'exhausted', 'paused']),
    confidence: z.number().min(0).max(1).optional(),
    late: z.boolean().optional(),
    summary: z.string().optional(),
    data: z.unknown().optional(),
    error: z.never().optional(),
    stall: checkpointStallSchema.optional(),
    revision: checkpointRevisionSchema.optional(),
  })
  .passthrough();

interface RecorderOptions {
  thin?: boolean;
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
}

/** Append-only JSONL event sink. Truncates any existing file at the start. */
export function makeRecorder(
  path: string,
  options: RecorderOptions = {},
): (event: LoopEvent) => void {
  ensureDir(path);
  writeFileSync(path, '');
  return (event) => {
    if (NOISE.has(event.kind)) return;
    try {
      appendFileSync(
        path,
        `${JSON.stringify(options.thin ? thinEvent(event) : event)}\n`,
      );
    } catch {
      /* best-effort: a record write must never break the run */
    }
  };
}

function thinEvent(event: LoopEvent): unknown {
  switch (event.kind) {
    case 'job:end':
      return { ...event, outcome: thinOutcome(event.outcome) };
    case 'loop:end':
      return { ...event, outcome: thinOutcome(event.outcome) };
    case 'loop:review':
      return { ...event, outcome: thinOutcome(event.outcome) };
    case 'dag:end':
      return { ...event, outcome: thinOutcome(event.outcome) };
    case 'dag:node':
      return event.outcome
        ? { ...event, outcome: thinOutcome(event.outcome) }
        : event;
    case 'proof':
      return { ...event, artifact: thinProofArtifact(event.artifact) };
    case 'loop:condition':
    case 'condition:result':
      return {
        ...event,
        result: event.result.output === undefined
          ? event.result
          : { ...event.result, output: '[omitted from auto record]' },
      };
    default:
      return event;
  }
}

function thinOutcome(outcome: Outcome): Outcome {
  const thin: Outcome = {
    status: outcome.status,
  };
  if (outcome.confidence !== undefined) thin.confidence = outcome.confidence;
  if (outcome.late !== undefined) thin.late = outcome.late;
  if (outcome.summary !== undefined) thin.summary = outcome.summary;
  if (outcome.error !== undefined) thin.error = outcome.error;
  if (outcome.stall !== undefined) thin.stall = outcome.stall;
  if (outcome.revision !== undefined) thin.revision = outcome.revision;
  return thin;
}

function thinProofArtifact(
  artifact: Extract<LoopEvent, { kind: 'proof' }>['artifact'],
): Extract<LoopEvent, { kind: 'proof' }>['artifact'] {
  if (artifact.data === undefined) return artifact;
  const { data: _data, ...rest } = artifact;
  return rest;
}

/** Snapshot the shared run state at each boundary (latest-wins, overwritten). */
export function makeCheckpointer(
  path: string,
  state: Record<string, unknown>,
  control?: CheckpointControl,
): (event: LoopEvent) => void {
  ensureDir(path);
  return (event) => {
    if (!CHECKPOINT_AT.has(event.kind)) return;
    flushCheckpoint(path, state, control);
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
  control?: CheckpointControl,
  workspaceFingerprint?: string,
): void {
  ensureDir(path);
  try {
    const payload = toJsonSafe({
      ts: Date.now(),
      state,
      dags: control?.dags,
      workspaceFingerprint,
    });
    writeFileSync(
      path,
      JSON.stringify(payload, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

function toJsonSafe(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'object': {
      if (ancestors.has(value)) return undefined;
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((item) => toJsonSafe(item, ancestors));
        }
        if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
        return Object.fromEntries(
          Object.entries(value)
            .map(
              ([key, item]) => [key, toJsonSafe(item, ancestors)] as const,
            )
            .filter(([, item]) => item !== undefined),
        );
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      return undefined;
  }
}

export interface CheckpointDiagnostic {
  path: string;
  reason: string;
}

export interface CheckpointDiagnostics {
  skippedEntries: number;
  entries: CheckpointDiagnostic[];
}

export interface CheckpointEnvelope {
  state: Record<string, unknown>;
  control: CheckpointControl;
  workspaceFingerprint?: string;
  workspaceFingerprintValid: boolean;
  diagnostics: CheckpointDiagnostics;
}

export function loadCheckpointEnvelope(path: string): CheckpointEnvelope {
  const diagnostics: CheckpointDiagnostics = { skippedEntries: 0, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    addCheckpointDiagnostic(
      diagnostics,
      'checkpoint',
      `invalid JSON: ${error.message}`,
    );
    return checkpointEnvelope({}, {}, undefined, true, diagnostics);
  }

  if (!isPlainRecord(parsed)) {
    addCheckpointDiagnostic(diagnostics, 'checkpoint', 'expected an object');
    return checkpointEnvelope({}, {}, undefined, true, diagnostics);
  }

  let state: Record<string, unknown> = {};
  if (parsed.state !== undefined) {
    if (isPlainRecord(parsed.state)) state = parsed.state;
    else
      addCheckpointDiagnostic(diagnostics, 'state', 'expected an object');
  }

  const dags = parseCheckpointDags(parsed.dags, diagnostics);
  let workspaceFingerprint: string | undefined;
  let workspaceFingerprintValid = true;
  if (parsed.workspaceFingerprint !== undefined) {
    if (typeof parsed.workspaceFingerprint === 'string')
      workspaceFingerprint = parsed.workspaceFingerprint;
    else {
      workspaceFingerprintValid = false;
      addCheckpointDiagnostic(
        diagnostics,
        'workspaceFingerprint',
        'expected a string',
      );
    }
  }

  return checkpointEnvelope(
    state,
    dags,
    workspaceFingerprint,
    workspaceFingerprintValid,
    diagnostics,
  );
}

function checkpointEnvelope(
  state: Record<string, unknown>,
  dags: CheckpointControl['dags'],
  workspaceFingerprint: string | undefined,
  workspaceFingerprintValid: boolean,
  diagnostics: CheckpointDiagnostics,
): CheckpointEnvelope {
  return {
    state,
    control: {
      resumeDags: cloneCheckpointDags(dags),
      dags: cloneCheckpointDags(dags),
    },
    workspaceFingerprint,
    workspaceFingerprintValid,
    diagnostics,
  };
}

function parseCheckpointDags(
  value: unknown,
  diagnostics: CheckpointDiagnostics,
): CheckpointControl['dags'] {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    addCheckpointDiagnostic(diagnostics, 'dags', 'expected an object');
    return {};
  }

  const dags: CheckpointControl['dags'] = Object.create(null);
  for (const [dagName, dagValue] of Object.entries(value)) {
    const dagPath = `dags[${JSON.stringify(dagName)}]`;
    if (!isPlainRecord(dagValue) || !isPlainRecord(dagValue.nodes)) {
      addCheckpointDiagnostic(
        diagnostics,
        dagPath,
        'expected an object with a nodes object',
      );
      continue;
    }

    const nodes: Record<string, CheckpointDagNode> = Object.create(null);
    for (const [nodeName, nodeValue] of Object.entries(dagValue.nodes)) {
      const nodePath = `${dagPath}.nodes[${JSON.stringify(nodeName)}]`;
      if (!isPlainRecord(nodeValue)) {
        addCheckpointDiagnostic(diagnostics, nodePath, 'expected an object');
        continue;
      }
      if (nodeValue.phase !== 'done' && nodeValue.phase !== 'skip') {
        addCheckpointDiagnostic(
          diagnostics,
          `${nodePath}.phase`,
          'expected "done" or "skip"',
        );
        continue;
      }
      const outcome = parseCheckpointOutcome(
        nodeValue.outcome,
        `${nodePath}.outcome`,
        diagnostics,
      );
      if (!outcome) continue;
      if (
        nodeValue.attempt !== undefined &&
        (typeof nodeValue.attempt !== 'number' ||
          !Number.isFinite(nodeValue.attempt))
      ) {
        addCheckpointDiagnostic(
          diagnostics,
          `${nodePath}.attempt`,
          'expected a finite number',
        );
        continue;
      }

      nodes[nodeName] = {
        phase: nodeValue.phase,
        outcome,
        ...(nodeValue.attempt === undefined
          ? {}
          : { attempt: nodeValue.attempt as number }),
      };
    }
    dags[dagName] = { nodes };
  }
  return dags;
}

function parseCheckpointOutcome(
  value: unknown,
  path: string,
  diagnostics: CheckpointDiagnostics,
): Outcome | undefined {
  const parsed = checkpointOutcomeSchema.safeParse(value);
  if (parsed.success) return parsed.data as Outcome;
  const issue = parsed.error.issues[0]!;
  addCheckpointDiagnostic(
    diagnostics,
    issue.path.reduce<string>(
      (issuePath, part) =>
        typeof part === 'number'
          ? `${issuePath}[${part}]`
          : `${issuePath}.${String(part)}`,
      path,
    ),
    issue.message,
  );
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function addCheckpointDiagnostic(
  diagnostics: CheckpointDiagnostics,
  path: string,
  reason: string,
): void {
  diagnostics.skippedEntries += 1;
  if (diagnostics.entries.length >= MAX_CHECKPOINT_DIAGNOSTICS) return;
  diagnostics.entries.push({
    path: boundText(path, MAX_CHECKPOINT_DIAGNOSTIC_PATH_CHARS),
    reason: boundText(reason, MAX_CHECKPOINT_DIAGNOSTIC_REASON_CHARS),
  });
}

function boundText(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars - 3)}...`;
}

function cloneCheckpointDags(
  dags: CheckpointControl['dags'],
): CheckpointControl['dags'] {
  return Object.fromEntries(
    Object.entries(dags).map(([name, dag]) => [
      name,
      {
        nodes: Object.fromEntries(
          Object.entries(dag.nodes).map(([node, record]) => [
            node,
            { ...record },
          ]),
        ),
      },
    ]),
  );
}

/** Restore the shared run state written by a prior `makeCheckpointer`. */
export function loadCheckpoint(path: string): Record<string, unknown> {
  return loadCheckpointEnvelope(path).state;
}
