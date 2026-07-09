import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { runSemanticRecordsPath } from './supervisor.ts';

import {
  normalizeFeedbackSeverity,
  revisionFromOutcome,
} from '../core/feedback.ts';
import type {
  FeedbackActionSeverity,
  FeedbackDecision,
  FeedbackFinding,
  LoopEvent,
  Outcome,
  ProofArtifact,
  RevisionRequest,
} from '../core/types.ts';

export type SemanticDecision = FeedbackDecision;

export type SemanticRunRecord =
  | {
      kind: 'dispatch';
      ts: number;
      path: string[];
      unit: 'job' | 'dag-node';
      label?: string;
      node?: string;
      /** Present for a dag-node: which run this is (1-based; +1 per kickback re-run). */
      attempt?: number;
    }
  | {
      kind: 'completion';
      ts: number;
      path: string[];
      unit: 'job' | 'loop' | 'dag' | 'dag-node';
      label?: string;
      outcome: SemanticOutcome;
      iterations?: number;
      /** Present for a dag-node: which run this completion is for. */
      attempt?: number;
    }
  | {
      kind: 'surfacing';
      ts: number;
      path: string[];
      source: 'loop-review' | 'dag-kickback';
      decision: SemanticDecision;
      severity?: FeedbackActionSeverity;
      from?: string;
      to?: string;
      reason: string;
      note?: string;
    }
  | {
      kind: 'revision-emitted';
      ts: number;
      path: string[];
      sourceEvent: 'job:end';
      revision: RevisionRequest;
    }
  | {
      kind: 'revision-routed';
      ts: number;
      path: string[];
      sourceEvent: 'loop:review' | 'dag:kickback';
      decision: SemanticDecision;
      revision: RevisionRequest;
    }
  | {
      kind: 'proof';
      ts: number;
      path: string[];
      name: string;
      artifact: ProofArtifact;
    };

export interface SemanticOutcome {
  status: Outcome['status'];
  summary?: string;
  confidence?: number;
  late?: true;
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
}

function outcomeSummary(outcome: Outcome): SemanticOutcome {
  return {
    status: outcome.status,
    summary: outcome.summary,
    confidence: outcome.confidence,
    ...(outcome.late ? { late: true } : {}),
  };
}

function strongestFinding(
  findings: FeedbackFinding[] | undefined,
): FeedbackActionSeverity | undefined {
  if (!findings?.length) return undefined;
  const severities = findings.map((f) => normalizeFeedbackSeverity(f.severity));
  if (severities.includes('block')) return 'block';
  if (severities.includes('should-fix')) return 'should-fix';
  if (severities.includes('nice-to-have')) return 'nice-to-have';
  if (severities.includes('approve')) return 'approve';
  return undefined;
}

function emittedRevisionRecord(
  event: LoopEvent,
  outcome: Outcome,
): SemanticRunRecord[] {
  const revision = revisionFromOutcome(outcome);
  return revision
    ? [
        {
          kind: 'revision-emitted',
          ts: event.ts,
          path: event.path,
          sourceEvent: 'job:end',
          revision,
        },
      ]
    : [];
}

export function semanticRecordsFromEvent(event: LoopEvent): SemanticRunRecord[] {
  switch (event.kind) {
    case 'job:start':
      return [
        {
          kind: 'dispatch',
          ts: event.ts,
          path: event.path,
          unit: 'job',
          label: event.label,
        },
      ];
    case 'dag:node':
      if (event.phase === 'start')
        return [
          {
            kind: 'dispatch',
            ts: event.ts,
            path: [...event.path, event.node],
            unit: 'dag-node',
            node: event.node,
            attempt: event.attempt,
          },
        ];
      // 'done' or 'skip': the node-boundary completion. This is the ONLY
      // completion for a bare-function node or a skipped node (neither emits its
      // own job:end). A job/loop node also emits its own unit-'job'/'loop'
      // completion; the `unit` field tells the two apart, so filtering on
      // unit:'dag-node' gives one clean lifecycle per node of every type.
      return event.outcome
        ? [
            {
              kind: 'completion',
              ts: event.ts,
              path: [...event.path, event.node],
              unit: 'dag-node',
              label: event.node,
              outcome: outcomeSummary(event.outcome),
              attempt: event.attempt,
            },
          ]
        : [];
    case 'job:end':
      return [
        {
          kind: 'completion',
          ts: event.ts,
          path: event.path,
          unit: 'job',
          label: event.label,
          outcome: outcomeSummary(event.outcome),
        },
        ...emittedRevisionRecord(event, event.outcome),
      ];
    case 'loop:review': {
      if (event.outcome.status === 'pass') return [];
      const revision = revisionFromOutcome(event.outcome);
      // The loop stamps `accepted` = it will re-enter to act on this review; a
      // review that exhausted its iterations / maxReviewRestarts is `rejected`
      // (the findings were dropped, not applied). An omitted bit is treated as
      // accepted so a synthetic event without it degrades to the old behaviour.
      const decision: SemanticDecision =
        event.accepted === false ? 'rejected' : 'accepted';
      const records: SemanticRunRecord[] = [
        {
          kind: 'surfacing',
          ts: event.ts,
          path: event.path,
          source: 'loop-review',
          decision,
          severity: strongestFinding(revision?.findings),
          reason:
            revision?.reason ?? event.outcome.summary ?? event.outcome.status,
        },
      ];
      if (revision) {
        records.push({
          kind: 'revision-routed',
          ts: event.ts,
          path: event.path,
          sourceEvent: 'loop:review',
          decision,
          revision,
        });
      }
      return records;
    }
    case 'loop:end':
      return [
        {
          kind: 'completion',
          ts: event.ts,
          path: event.path,
          unit: 'loop',
          outcome: outcomeSummary(event.outcome),
          iterations: event.iterations,
        },
      ];
    case 'dag:kickback': {
      // Stamp the routing records at the target node's path (not the dag's), so a
      // node-scoped `--path <node>` filter returns the routed half of a revision
      // alongside the `revision-emitted` half (which rides the emitting node's
      // job:end at its own path). Otherwise the two halves live under different
      // prefixes and a per-node query silently drops the routed one.
      const at = [...event.path, event.to];
      const decision: SemanticDecision = event.accepted ? 'accepted' : 'rejected';
      return [
        {
          kind: 'surfacing',
          ts: event.ts,
          path: at,
          source: 'dag-kickback',
          decision,
          severity: 'block',
          from: event.from,
          to: event.to,
          reason: event.reason,
          note: event.note,
        },
        {
          kind: 'revision-routed',
          ts: event.ts,
          path: at,
          sourceEvent: 'dag:kickback',
          decision,
          revision: {
            target: event.to,
            reason: event.reason,
            source: event.from,
            rerun: event.accepted ? 'target-and-dependents' : undefined,
          },
        },
      ];
    }
    case 'dag:end':
      return [
        {
          kind: 'completion',
          ts: event.ts,
          path: event.path,
          unit: 'dag',
          outcome: outcomeSummary(event.outcome),
        },
      ];
    case 'proof':
      return [
        {
          kind: 'proof',
          ts: event.ts,
          path: event.path,
          name: event.name,
          artifact: event.artifact,
        },
      ];
    default:
      return [];
  }
}

/** Read a supervised run's semantic record stream; undefined when the run has
 *  none. Skips unparseable lines so a torn write never breaks a read. */
export function readSemanticRecords(
  runId: string,
): SemanticRunRecord[] | undefined {
  const path = runSemanticRecordsPath(runId);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8').trim();
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

/** A compact one-line rendering of a semantic record, for `loops records` and
 *  the helm's observation channel. Callers sanitise for terminals (`toLine`). */
export function formatSemanticRecord(record: SemanticRunRecord): string {
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
    case 'proof':
      return `${at}proof ${record.name}: ${record.artifact.title ?? record.artifact.path ?? record.artifact.kind}`;
  }
}

/** Append-only semantic JSONL sink. Truncates any existing file at the start. */
export function makeSemanticRecorder(path: string): (event: LoopEvent) => void {
  try {
    ensureDir(path);
    writeFileSync(path, '');
  } catch {
    return () => {};
  }
  return (event) => {
    const records = semanticRecordsFromEvent(event);
    if (!records.length) return;
    try {
      for (const record of records) {
        appendFileSync(path, `${JSON.stringify(record)}\n`);
      }
    } catch {
      /* best-effort: semantic records must never break the run */
    }
  };
}
