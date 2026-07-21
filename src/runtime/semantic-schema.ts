import { z } from 'zod';

import type { JsonValue } from '../core/types.ts';

export const SEMANTIC_RUN_RECORD_SCHEMA_VERSION = 1 as const;

export const SEMANTIC_RUN_RECORD_KINDS = [
  'dispatch',
  'completion',
  'surfacing',
  'revision-emitted',
  'revision-routed',
  'proof',
  'advisor-consult',
  'gate-verdict',
  'benchmark-outcome',
  'refusal',
  'capability-gap',
  'handoff',
  'trigger-invocation',
  'cost-snapshot',
  'preflight-classification',
  'lifecycle-transition',
] as const;

export const SEMANTIC_RECORD_FILTER_KINDS = [
  ...SEMANTIC_RUN_RECORD_KINDS,
  'revision',
] as const;

const nonnegativeInt = z.number().int().nonnegative();
const nonnegativeNumber = z.number().nonnegative();
const confidence = z.number().min(0).max(1);
const runId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const metadataSchema = z.record(z.string(), jsonValueSchema);

const baseShape = {
  schemaVersion: z.literal(SEMANTIC_RUN_RECORD_SCHEMA_VERSION),
  ts: nonnegativeInt,
  path: z.array(z.string()),
  runId: runId.optional(),
  metadata: metadataSchema.optional(),
};

function record<const K extends string, T extends z.ZodRawShape>(
  kind: K,
  shape: T,
) {
  return z
    .object({
      ...baseShape,
      kind: z.literal(kind),
      ...shape,
    })
    .strict();
}

const outcomeStatusSchema = z.enum([
  'pass',
  'fail',
  'aborted',
  'exhausted',
  'paused',
]);

export const semanticOutcomeSchema = z
  .object({
    status: outcomeStatusSchema,
    summary: z.string().optional(),
    confidence: confidence.optional(),
    late: z.literal(true).optional(),
  })
  .strict();

const feedbackSeveritySchema = z.enum([
  'block',
  'should-fix',
  'nice-to-have',
  'approve',
  'blocking',
  'advisory',
]);

export const semanticDecisionSchema = z.enum([
  'accepted',
  'rejected',
  'deferred',
  'escalated',
]);

const feedbackFindingSchema = z
  .object({
    reviewer: z.string().optional(),
    severity: feedbackSeveritySchema.optional(),
    decision: semanticDecisionSchema.optional(),
    scope: z.string().optional(),
    evidence: z.string(),
    recommendation: z.string().optional(),
  })
  .strict();

const revisionRequestSchema = z
  .object({
    target: z.string().optional(),
    reason: z.string(),
    findings: z.array(feedbackFindingSchema).optional(),
    rerun: z.literal('target-and-dependents').optional(),
    source: z.string().optional(),
    decision: semanticDecisionSchema.optional(),
  })
  .strict();

const proofArtifactSchema = z
  .object({
    kind: z.enum(['html', 'image', 'markdown', 'table', 'json']),
    title: z.string().optional(),
    description: z.string().optional(),
    mediaType: z.string().optional(),
    meta: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
    path: z.string().optional(),
    data: jsonValueSchema.optional(),
  })
  .strict();

const referenceSchema = z
  .object({
    kind: z.enum(['artifact', 'commit', 'record', 'external']),
    ref: z.string().min(1),
    title: z.string().optional(),
  })
  .strict();

const usageSchema = z
  .object({
    inputTokens: nonnegativeInt,
    outputTokens: nonnegativeInt,
  })
  .strict();

const requirementSchema = z
  .object({
    kind: z.enum(['agent', 'skill', 'capability']),
    name: z.string().min(1),
  })
  .strict();

const costReportSchema = z
  .object({
    spentUsd: nonnegativeNumber.optional(),
    baselineModel: z.string().optional(),
    baselineUsd: nonnegativeNumber.optional(),
    savedUsd: z.number().optional(),
    unpricedModels: z.array(z.string()),
    models: z.array(
      z
        .object({
          model: z.string(),
          calls: nonnegativeInt,
          inputTokens: nonnegativeInt,
          outputTokens: nonnegativeInt,
          usd: nonnegativeNumber.optional(),
        })
        .strict(),
    ),
  })
  .strict();

const dispatchRecordSchema = z.discriminatedUnion('unit', [
  record('dispatch', {
    unit: z.literal('job'),
    label: z.string(),
  }),
  record('dispatch', {
    unit: z.literal('dag-node'),
    node: z.string(),
    attempt: nonnegativeInt.positive(),
  }),
]);

const completionRecordSchema = z.discriminatedUnion('unit', [
  record('completion', {
    unit: z.literal('job'),
    label: z.string(),
    outcome: semanticOutcomeSchema,
  }),
  record('completion', {
    unit: z.literal('loop'),
    outcome: semanticOutcomeSchema,
    iterations: nonnegativeInt,
  }),
  record('completion', {
    unit: z.literal('dag'),
    outcome: semanticOutcomeSchema,
  }),
  record('completion', {
    unit: z.literal('dag-node'),
    label: z.string(),
    outcome: semanticOutcomeSchema,
    attempt: nonnegativeInt.positive(),
  }),
]);

const surfacingRecordSchema = record('surfacing', {
  source: z.enum(['loop-review', 'dag-kickback']),
  decision: semanticDecisionSchema,
  severity: z
    .enum(['block', 'should-fix', 'nice-to-have', 'approve'])
    .optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  reason: z.string(),
  note: z.string().optional(),
});

const revisionEmittedRecordSchema = record('revision-emitted', {
  sourceEvent: z.literal('job:end'),
  revision: revisionRequestSchema,
});

const revisionRoutedRecordSchema = record('revision-routed', {
  sourceEvent: z.enum(['loop:review', 'dag:kickback']),
  decision: semanticDecisionSchema,
  revision: revisionRequestSchema,
});

const proofRecordSchema = record('proof', {
  name: z.string(),
  artifact: proofArtifactSchema,
});

const advisorConsultRecordSchema = record('advisor-consult', {
  label: z.string(),
  call: nonnegativeInt.positive(),
  question: z.string(),
  reply: z.string(),
  model: z.string().optional(),
});

const gateVerdictRecordSchema = record('gate-verdict', {
  gate: z.string().min(1),
  iteration: nonnegativeInt,
  met: z.boolean(),
  reason: z.string(),
  confidence: confidence.optional(),
  output: z.string().optional(),
});

const benchmarkOutcomeRecordSchema = record('benchmark-outcome', {
  benchmark: z.string().min(1),
  taskId: z.string().min(1),
  variant: z.string().min(1),
  outcome: semanticOutcomeSchema,
  model: z.string().optional(),
  engine: z.string().optional(),
  loopsVersion: z.string().optional(),
  repository: z.string().optional(),
  configuration: z.record(z.string(), jsonValueSchema).optional(),
  metrics: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
  references: z.array(referenceSchema).optional(),
});

const refusalRecordSchema = record('refusal', {
  category: z.enum([
    'budget',
    'schema',
    'cycle',
    'permission',
    'cancelled',
    'policy',
    'other',
  ]),
  reason: z.string(),
  retryable: z.boolean(),
  actor: z.string().optional(),
  references: z.array(referenceSchema).optional(),
});

const capabilityGapRecordSchema = record('capability-gap', {
  requirement: requirementSchema,
  reason: z.string(),
  disposition: z.enum(['fallback', 'self-attempt', 'unresolved']),
  selected: requirementSchema.optional(),
  outcome: semanticOutcomeSchema.optional(),
  references: z.array(referenceSchema).optional(),
});

const handoffRecordSchema = record('handoff', {
  handoffId: z.string().min(1),
  sender: z.string().min(1),
  recipient: z.string().min(1),
  task: z.string().min(1),
  state: z.enum(['created', 'accepted', 'completed', 'rejected']),
  idempotencyKey: z.string().min(1).optional(),
  references: z.array(referenceSchema).optional(),
});

const triggerInvocationRecordSchema = record('trigger-invocation', {
  invocationId: z.string().min(1),
  adapter: z.string().min(1),
  trigger: z.string().min(1),
  phase: z.enum(['ingress', 'dispatch', 'consumed', 'rejected']),
  action: z.enum(['start', 'resume']),
  idempotencyKey: z.string().min(1),
  source: z.string().optional(),
  reason: z.string().optional(),
  references: z.array(referenceSchema).optional(),
});

const costSnapshotRecordSchema = record('cost-snapshot', {
  phase: z.enum(['interim', 'final']),
  report: costReportSchema,
  budget: z
    .object({
      limit: nonnegativeInt,
      spent: nonnegativeInt,
      remaining: nonnegativeInt,
      headroom: nonnegativeInt.optional(),
      soft: z.boolean().optional(),
    })
    .strict()
    .optional(),
});

const preflightBaseShape = {
  engine: z.string(),
  model: z.string().optional(),
  detail: z.string(),
  latencyMs: nonnegativeInt,
  usage: usageSchema.optional(),
};

const preflightFailureSchema = z.enum([
  'auth',
  'billing',
  'missing-cli',
  'model-unavailable',
  'rate-limit',
  'quota',
  'timeout',
  'aborted',
  'unknown',
]);

const preflightClassificationRecordSchema = record(
  'preflight-classification',
  {
    result: z.discriminatedUnion('ok', [
      z.object({ ...preflightBaseShape, ok: z.literal(true) }).strict(),
      z
        .object({
          ...preflightBaseShape,
          ok: z.literal(false),
          failure: preflightFailureSchema,
        })
        .strict(),
    ]),
  },
);

const terminalLifecycleStateSchema = z.enum([
  'pass',
  'fail',
  'aborted',
  'exhausted',
]);
const acknowledgementSchema = z
  .object({ name: z.string().min(1), prompt: z.string() })
  .strict();
const checkpointSchema = z.discriminatedUnion('decision', [
  z
    .object({
      path: z.string(),
      decision: z.literal('restored'),
      restoredNodes: nonnegativeInt.positive(),
      totalNodes: nonnegativeInt.positive(),
      fingerprint: z.enum([
        'matched',
        'checkpoint-missing',
        'workspace-unavailable',
      ]),
    })
    .strict(),
  z
    .object({
      path: z.string(),
      decision: z.literal('skipped'),
      restoredNodes: z.literal(0),
      totalNodes: nonnegativeInt.optional(),
      fingerprint: z.enum([
        'matched',
        'changed',
        'checkpoint-missing',
        'workspace-unavailable',
      ]),
    })
    .strict(),
]);
const workstreamLifecycleStateSchema = z.enum([
  'created',
  'active',
  'fan-out',
  'review',
  'accepted',
  'rejected',
  'escalated',
  'merged',
  'paused',
  'closed',
]);
const artifactLifecycleStateSchema = z.enum([
  'captured',
  'scoped',
  'in-progress',
  'review',
  'accepted',
  'rejected',
  'completed',
  'superseded',
]);
const handoffLifecycleStateSchema = z.enum([
  'created',
  'accepted',
  'completed',
  'rejected',
]);
const triggerLifecycleStateSchema = z.enum([
  'ingress',
  'dispatch',
  'consumed',
  'rejected',
]);

function executionLifecycleRecord<
  const U extends 'run' | 'job' | 'loop' | 'dag-node',
>(unit: U) {
  return z.discriminatedUnion('from', [
    record('lifecycle-transition', {
      unit: z.literal(unit),
      from: z.literal('created'),
      to: z.literal('running'),
      reason: z.string().optional(),
    }),
    z.discriminatedUnion('to', [
      record('lifecycle-transition', {
        unit: z.literal(unit),
        from: z.literal('running'),
        to: z.literal('paused'),
        reason: z.string().optional(),
        resumeCommand: z.string().optional(),
        acknowledgement: acknowledgementSchema.optional(),
      }),
      record('lifecycle-transition', {
        unit: z.literal(unit),
        from: z.literal('running'),
        to: terminalLifecycleStateSchema,
        reason: z.string().optional(),
      }),
    ]),
    record('lifecycle-transition', {
      unit: z.literal(unit),
      from: z.literal('paused'),
      to: z.literal('running'),
      reason: z.string().optional(),
      checkpoint: checkpointSchema,
    }),
  ]);
}

const lifecycleTransitionRecordSchema = z.discriminatedUnion('unit', [
  executionLifecycleRecord('run'),
  executionLifecycleRecord('job'),
  executionLifecycleRecord('loop'),
  executionLifecycleRecord('dag-node'),
  record('lifecycle-transition', {
    unit: z.literal('workstream'),
    from: workstreamLifecycleStateSchema.optional(),
    to: workstreamLifecycleStateSchema,
    reason: z.string().optional(),
  }),
  record('lifecycle-transition', {
    unit: z.literal('artifact'),
    from: artifactLifecycleStateSchema.optional(),
    to: artifactLifecycleStateSchema,
    reason: z.string().optional(),
  }),
  record('lifecycle-transition', {
    unit: z.literal('handoff'),
    from: handoffLifecycleStateSchema.optional(),
    to: handoffLifecycleStateSchema,
    reason: z.string().optional(),
  }),
  record('lifecycle-transition', {
    unit: z.literal('trigger'),
    from: triggerLifecycleStateSchema.optional(),
    to: triggerLifecycleStateSchema,
    reason: z.string().optional(),
  }),
]);

export const semanticRunRecordSchema = z.discriminatedUnion('kind', [
  dispatchRecordSchema,
  completionRecordSchema,
  surfacingRecordSchema,
  revisionEmittedRecordSchema,
  revisionRoutedRecordSchema,
  proofRecordSchema,
  advisorConsultRecordSchema,
  gateVerdictRecordSchema,
  benchmarkOutcomeRecordSchema,
  refusalRecordSchema,
  capabilityGapRecordSchema,
  handoffRecordSchema,
  triggerInvocationRecordSchema,
  costSnapshotRecordSchema,
  preflightClassificationRecordSchema,
  lifecycleTransitionRecordSchema,
]);

export const semanticRunRecordJsonSchema = {
  ...z.toJSONSchema(semanticRunRecordSchema, { target: 'draft-2020-12' }),
  $id: 'urn:loops-adk:semantic-run-record:v1',
  title: 'Loops semantic run record v1',
};

export type SemanticRecordKind = (typeof SEMANTIC_RUN_RECORD_KINDS)[number];
export type SemanticRecordFilterKind =
  (typeof SEMANTIC_RECORD_FILTER_KINDS)[number];
export type SemanticRunRecord = z.infer<typeof semanticRunRecordSchema>;
export type SemanticOutcome = z.infer<typeof semanticOutcomeSchema>;
export type SemanticDecision = z.infer<typeof semanticDecisionSchema>;
export type SemanticRecordOf<K extends SemanticRecordKind> = Extract<
  SemanticRunRecord,
  { kind: K }
>;

export function parseSemanticRunRecord(value: unknown): SemanticRunRecord {
  return semanticRunRecordSchema.parse(value);
}

export function safeParseSemanticRunRecord(value: unknown) {
  return semanticRunRecordSchema.safeParse(value);
}

const LEGACY_KINDS = new Set<string>([
  'dispatch',
  'completion',
  'surfacing',
  'revision-emitted',
  'revision-routed',
  'proof',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adapt a known unversioned 0.7.0 record in memory, then validate it as v1. */
export function adaptSemanticRunRecord(
  value: unknown,
  suppliedRunId?: string,
): SemanticRunRecord {
  if (!isObject(value)) return parseSemanticRunRecord(value);

  let candidate = value;
  if (value.schemaVersion === undefined) {
    if (
      typeof value.kind !== 'string' ||
      !LEGACY_KINDS.has(value.kind) ||
      'runId' in value ||
      'metadata' in value
    )
      return parseSemanticRunRecord(value);
    candidate = {
      ...value,
      schemaVersion: SEMANTIC_RUN_RECORD_SCHEMA_VERSION,
      ...(suppliedRunId !== undefined ? { runId: suppliedRunId } : {}),
    };
  }

  return parseSemanticRunRecord(candidate);
}
