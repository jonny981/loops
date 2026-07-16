import {
  appendFileSync,
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
  FeedbackFinding,
  LoopEvent,
  Outcome,
} from '../core/types.ts';
import {
  SEMANTIC_RUN_RECORD_SCHEMA_VERSION,
  adaptSemanticRunRecord,
  safeParseSemanticRunRecord,
} from './semantic-schema.ts';
import type {
  SemanticDecision,
  SemanticOutcome,
  SemanticRunRecord,
} from './semantic-schema.ts';

export type {
  SemanticDecision,
  SemanticOutcome,
  SemanticRunRecord,
} from './semantic-schema.ts';

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

function recordBase(
  event: LoopEvent,
  runId?: string,
  path: string[] = event.path,
) {
  return {
    schemaVersion: SEMANTIC_RUN_RECORD_SCHEMA_VERSION,
    ...(runId ? { runId } : {}),
    ts: event.ts,
    path,
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
  runId?: string,
): SemanticRunRecord[] {
  const revision = revisionFromOutcome(outcome);
  return revision
    ? [
        {
          ...recordBase(event, runId),
          kind: 'revision-emitted',
          sourceEvent: 'job:end',
          revision,
        },
      ]
    : [];
}

export function semanticRecordsFromEvent(
  event: LoopEvent,
  runId?: string,
): SemanticRunRecord[] {
  if (runId !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(runId))
    throw new TypeError(`invalid semantic record runId: ${runId}`);
  switch (event.kind) {
    case 'runtime:restore':
      if (event.decision === 'restored') {
        if (event.restoredNodes <= 0)
          throw new TypeError('restored checkpoint must contain at least one node');
        // Semantic record v1 cannot represent a restored changed workspace.
        // Omit the transition rather than emit an invalid or misleading record.
        if (event.fingerprint === 'changed') return [];
        return [
          {
            ...recordBase(event, runId),
            kind: 'lifecycle-transition',
            unit: 'run',
            from: 'paused',
            to: 'running',
            reason: event.reason,
            checkpoint: {
              path: event.checkpoint,
              decision: event.decision,
              restoredNodes: event.restoredNodes,
              totalNodes: event.totalNodes,
              fingerprint: event.fingerprint,
            },
          },
        ];
      }
      return [
        {
          ...recordBase(event, runId),
          kind: 'lifecycle-transition',
          unit: 'run',
          from: 'paused',
          to: 'running',
          reason: event.reason,
          checkpoint: {
            path: event.checkpoint,
            decision: event.decision,
            restoredNodes: event.restoredNodes,
            totalNodes: event.totalNodes,
            fingerprint: event.fingerprint,
          },
        },
      ];
    case 'loop:condition':
      return [
        {
          ...recordBase(event, runId),
          kind: 'gate-verdict',
          gate: event.which,
          iteration: event.iteration ?? 0,
          met: event.result.met,
          reason: event.result.reason,
          confidence: event.result.confidence,
          output: event.result.output,
        },
      ];
    case 'condition:result':
      return [
        {
          ...recordBase(event, runId),
          kind: 'gate-verdict',
          gate: event.label,
          iteration: event.iteration,
          met: event.result.met,
          reason: event.result.reason,
          confidence: event.result.confidence,
          output: event.result.output,
        },
      ];
    case 'job:start':
      return [
        {
          ...recordBase(event, runId),
          kind: 'dispatch',
          unit: 'job',
          label: event.label,
        },
      ];
    case 'dag:node':
      if (event.phase === 'start')
        return [
          {
            ...recordBase(event, runId, [...event.path, event.node]),
            kind: 'dispatch',
            unit: 'dag-node',
            node: event.node,
            attempt: event.attempt ?? 1,
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
              ...recordBase(event, runId, [...event.path, event.node]),
              kind: 'completion',
              unit: 'dag-node',
              label: event.node,
              outcome: outcomeSummary(event.outcome),
              attempt: event.attempt ?? 1,
            },
          ]
        : [];
    case 'job:end':
      return [
        {
          ...recordBase(event, runId),
          kind: 'completion',
          unit: 'job',
          label: event.label,
          outcome: outcomeSummary(event.outcome),
        },
        ...emittedRevisionRecord(event, event.outcome, runId),
      ];
    case 'advisor:consult':
      return [
        {
          ...recordBase(event, runId),
          kind: 'advisor-consult',
          label: event.label,
          call: event.call,
          question: event.question,
          reply: event.reply,
          model: event.model,
        },
      ];
    case 'human:gate':
      return [
        {
          ...recordBase(event, runId),
          kind: 'lifecycle-transition',
          unit: 'job',
          from: 'running',
          to: 'paused',
          reason: event.prompt,
          resumeCommand: event.resumeCommand,
          acknowledgement: {
            name: event.name,
            prompt: event.prompt,
          },
        },
      ];
    case 'limit:pause':
      return [
        {
          ...recordBase(event, runId),
          kind: 'lifecycle-transition',
          unit: 'loop',
          from: 'running',
          to: 'paused',
          reason: event.reason,
          resumeCommand: event.resumeCommand,
          metadata: { code: event.code },
        },
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
          ...recordBase(event, runId),
          kind: 'surfacing',
          source: 'loop-review',
          decision,
          severity: strongestFinding(revision?.findings),
          reason:
            revision?.reason ?? event.outcome.summary ?? event.outcome.status,
        },
      ];
      if (revision) {
        records.push({
          ...recordBase(event, runId),
          kind: 'revision-routed',
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
          ...recordBase(event, runId),
          kind: 'completion',
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
          ...recordBase(event, runId, at),
          kind: 'surfacing',
          source: 'dag-kickback',
          decision,
          severity: 'block',
          from: event.from,
          to: event.to,
          reason: event.reason,
          note: event.note,
        },
        {
          ...recordBase(event, runId, at),
          kind: 'revision-routed',
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
          ...recordBase(event, runId),
          kind: 'completion',
          unit: 'dag',
          outcome: outcomeSummary(event.outcome),
        },
      ];
    case 'proof':
      return [
        {
          ...recordBase(event, runId),
          kind: 'proof',
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runId)) return undefined;
  const path = runSemanticRecordsPath(runId);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!raw) return [];
  const records: SemanticRunRecord[] = [];
  for (const line of raw.split('\n')) {
    try {
      records.push(adaptSemanticRunRecord(JSON.parse(line), runId));
    } catch {
      /* skip a torn or schema-invalid line */
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
      return record.unit === 'job'
        ? `${at}dispatch job ${record.label}`
        : `${at}dispatch dag-node ${record.node}`;
    case 'completion':
      return `${at}completion ${record.unit}${'label' in record ? ` ${record.label}` : ''}: ${record.outcome.status}${record.outcome.summary ? ` — ${record.outcome.summary}` : ''}`;
    case 'surfacing':
      return `${at}surfacing ${record.source} ${record.decision}${record.severity ? ` [${record.severity}]` : ''}: ${record.reason}`;
    case 'revision-emitted':
      return `${at}revision emitted ${record.sourceEvent}${record.revision.target ? ` -> ${record.revision.target}` : ''}: ${record.revision.reason}`;
    case 'revision-routed':
      return `${at}revision routed ${record.sourceEvent} ${record.decision}${record.revision.target ? ` -> ${record.revision.target}` : ''}: ${record.revision.reason}`;
    case 'proof':
      return `${at}proof ${record.name}: ${record.artifact.title ?? record.artifact.path ?? record.artifact.kind}`;
    case 'advisor-consult':
      return `${at}advisor ${record.label} call ${record.call}${record.model ? ` (${record.model})` : ''}: ${record.reply}`;
    case 'gate-verdict':
      return `${at}gate ${record.gate} iteration ${record.iteration}: ${record.met ? 'met' : 'unmet'}${record.confidence !== undefined ? ` [${record.confidence}]` : ''}: ${record.reason}`;
    case 'benchmark-outcome':
      return `${at}benchmark ${record.benchmark}/${record.taskId} ${record.variant}: ${record.outcome.status}${record.outcome.summary ? ` - ${record.outcome.summary}` : ''}`;
    case 'refusal':
      return `${at}refusal ${record.category}${record.retryable ? ' retryable' : ''}: ${record.reason}`;
    case 'capability-gap':
      return `${at}capability gap ${record.requirement.kind} ${record.requirement.name} (${record.disposition}): ${record.reason}`;
    case 'handoff':
      return `${at}handoff ${record.handoffId} ${record.sender} -> ${record.recipient} ${record.state}: ${record.task}`;
    case 'trigger-invocation':
      return `${at}trigger ${record.adapter}/${record.trigger} ${record.phase} ${record.action}: ${record.invocationId}`;
    case 'cost-snapshot':
      return `${at}cost ${record.phase}${record.report.spentUsd !== undefined ? `: $${record.report.spentUsd}` : ''}`;
    case 'preflight-classification':
      return `${at}preflight ${record.result.engine}${record.result.model ? `/${record.result.model}` : ''}: ${record.result.ok ? 'pass' : record.result.failure} - ${record.result.detail}`;
    case 'lifecycle-transition':
      return `${at}lifecycle ${record.unit} ${'from' in record && record.from ? `${record.from} -> ` : ''}${record.to}${record.reason ? `: ${record.reason}` : ''}`;
  }
}

export interface SemanticRecorder {
  sink: (event: LoopEvent) => void;
  write: (record: unknown) => void;
}

/** Validated semantic JSONL sink. Truncates any existing file at the start. */
export function makeSemanticRecorder(
  path: string,
  runId?: string,
): SemanticRecorder {
  let enabled = true;
  try {
    ensureDir(path);
    writeFileSync(path, '');
  } catch {
    enabled = false;
  }

  const write = (record: unknown) => {
    if (!enabled) return;
    try {
      const parsed = safeParseSemanticRunRecord(record);
      if (!parsed.success) return;
      appendFileSync(path, `${JSON.stringify(parsed.data)}\n`);
    } catch {
      /* best-effort: semantic records must never break the run */
    }
  };

  return {
    write,
    sink(event) {
      try {
        for (const record of semanticRecordsFromEvent(event, runId)) write(record);
      } catch {
        /* best-effort: semantic projection must never break the run */
      }
    },
  };
}
