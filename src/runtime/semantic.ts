import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  normalizeFeedbackSeverity,
  revisionFromOutcome,
} from '../core/feedback.ts';
import type {
  FeedbackActionSeverity,
  FeedbackFinding,
  LoopEvent,
  Outcome,
  RevisionRequest,
} from '../core/types.ts';

export type SemanticDecision = 'accepted' | 'rejected' | 'deferred' | 'escalated';

export type SemanticRunRecord =
  | {
      kind: 'dispatch';
      ts: number;
      path: string[];
      unit: 'job' | 'dag-node';
      label?: string;
      node?: string;
    }
  | {
      kind: 'completion';
      ts: number;
      path: string[];
      unit: 'job' | 'loop' | 'dag';
      label?: string;
      outcome: SemanticOutcome;
      iterations?: number;
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
      kind: 'revision';
      ts: number;
      path: string[];
      sourceEvent: 'job:end' | 'loop:review' | 'dag:kickback';
      revision: RevisionRequest;
    };

export interface SemanticOutcome {
  status: Outcome['status'];
  summary?: string;
  confidence?: number;
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

function revisionRecord(
  event: LoopEvent,
  sourceEvent: 'job:end' | 'loop:review',
  outcome: Outcome,
): SemanticRunRecord[] {
  const revision = revisionFromOutcome(outcome);
  return revision ? [{ kind: 'revision', ts: event.ts, path: event.path, sourceEvent, revision }] : [];
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
      return event.phase === 'start'
        ? [
            {
              kind: 'dispatch',
              ts: event.ts,
              path: [...event.path, event.node],
              unit: 'dag-node',
              node: event.node,
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
        ...revisionRecord(event, 'job:end', event.outcome),
      ];
    case 'loop:review': {
      const revision = revisionFromOutcome(event.outcome);
      return [
        ...(event.outcome.status !== 'pass'
          ? [
              {
                kind: 'surfacing' as const,
                ts: event.ts,
                path: event.path,
                source: 'loop-review' as const,
                decision: 'accepted' as const,
                severity: strongestFinding(revision?.findings),
                reason: revision?.reason ?? event.outcome.summary ?? event.outcome.status,
              },
            ]
          : []),
        ...revisionRecord(event, 'loop:review', event.outcome),
      ];
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
    case 'dag:kickback':
      return [
        {
          kind: 'surfacing',
          ts: event.ts,
          path: event.path,
          source: 'dag-kickback',
          decision: event.accepted ? 'accepted' : 'rejected',
          severity: 'block',
          from: event.from,
          to: event.to,
          reason: event.reason,
          note: event.note,
        },
        {
          kind: 'revision',
          ts: event.ts,
          path: event.path,
          sourceEvent: 'dag:kickback',
          revision: {
            target: event.to,
            reason: event.reason,
            source: event.from,
            rerun: event.accepted ? 'target-and-dependents' : undefined,
          },
        },
      ];
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
    default:
      return [];
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
