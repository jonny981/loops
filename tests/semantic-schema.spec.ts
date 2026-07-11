import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  SEMANTIC_RECORD_FILTER_KINDS,
  SEMANTIC_RUN_RECORD_KINDS,
  SEMANTIC_RUN_RECORD_SCHEMA_VERSION,
  adaptSemanticRunRecord,
  parseSemanticRunRecord,
  safeParseSemanticRunRecord,
  semanticRunRecordJsonSchema,
} from '../src/runtime/semantic-schema.ts';

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'semantic-records',
);

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe('semantic run record schema v1', () => {
  it('validates every acceptance fixture through Zod and the generated JSON Schema', () => {
    const fromJsonSchema = z.fromJSONSchema(semanticRunRecordJsonSchema);
    const dir = join(fixtures, 'v1');
    const files = readdirSync(dir).filter((file) => file.endsWith('.jsonl'));

    expect(files.sort()).toEqual([
      'advisor-consulted.jsonl',
      'benchmark.jsonl',
      'capability-gap.jsonl',
      'externally-triggered.jsonl',
      'failed.jsonl',
      'handed-off.jsonl',
      'multi-agent.jsonl',
      'paused.jsonl',
      'refused.jsonl',
      'resumed.jsonl',
      'successful.jsonl',
    ]);

    for (const file of files) {
      for (const value of readJsonl(join(dir, file))) {
        expect(safeParseSemanticRunRecord(value), file).toMatchObject({ success: true });
        expect(() => fromJsonSchema.parse(value), file).not.toThrow();
      }
    }
  });

  it('publishes one complete canonical kind vocabulary plus the revision filter alias', () => {
    expect(SEMANTIC_RUN_RECORD_SCHEMA_VERSION).toBe(1);
    expect(semanticRunRecordJsonSchema.$id).toBe(
      'urn:loops-adk:semantic-run-record:v1',
    );
    expect(SEMANTIC_RUN_RECORD_KINDS).toEqual([
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
    ]);
    expect(SEMANTIC_RECORD_FILTER_KINDS).toEqual([
      ...SEMANTIC_RUN_RECORD_KINDS,
      'revision',
    ]);
  });

  it('rejects unsupported versions, kinds, fields, and invalid constrained values', () => {
    const fromJsonSchema = z.fromJSONSchema(semanticRunRecordJsonSchema);
    const valid = {
      schemaVersion: 1,
      kind: 'gate-verdict',
      ts: 1,
      path: [],
      gate: 'until',
      iteration: 1,
      met: true,
      reason: 'done',
      confidence: 0.9,
    };

    const invalid = [
      { ...valid, schemaVersion: 2 },
      { ...valid, kind: 'unknown' },
      { ...valid, extra: true },
      { ...valid, confidence: 1.01 },
      { ...valid, ts: -1 },
    ];
    for (const value of invalid) {
      expect(safeParseSemanticRunRecord(value).success).toBe(false);
      expect(() => fromJsonSchema.parse(value)).toThrow();
    }
    expect(
      safeParseSemanticRunRecord({
        schemaVersion: 1,
        kind: 'preflight-classification',
        ts: 1,
        path: [],
        result: {
          engine: 'codex',
          ok: false,
          failure: 'timeout',
          detail: 'late',
          latencyMs: -1,
        },
      }).success,
    ).toBe(false);
    expect(
      safeParseSemanticRunRecord({ ...valid, metadata: { invalid: () => undefined } })
        .success,
    ).toBe(false);
    expect(() => parseSemanticRunRecord(valid)).not.toThrow();

    const contradictoryPreflight = [
      {
        schemaVersion: 1,
        kind: 'preflight-classification',
        ts: 1,
        path: [],
        result: {
          engine: 'codex',
          ok: true,
          failure: 'timeout',
          detail: 'ok',
          latencyMs: 1,
        },
      },
      {
        schemaVersion: 1,
        kind: 'preflight-classification',
        ts: 1,
        path: [],
        result: {
          engine: 'codex',
          ok: false,
          detail: 'failed',
          latencyMs: 1,
        },
      },
    ];
    for (const value of contradictoryPreflight) {
      expect(safeParseSemanticRunRecord(value).success).toBe(false);
      expect(() => fromJsonSchema.parse(value)).toThrow();
    }
  });

  it('adapts only known unversioned 0.7.0 records without mutating the archive', () => {
    const legacy = readJsonl(join(fixtures, 'legacy-0.7.0.jsonl'));
    const snapshot = structuredClone(legacy);
    const adapted = legacy.map((value) =>
      adaptSemanticRunRecord(value, 'legacy-a1b2c3'),
    );

    expect(legacy).toEqual(snapshot);
    expect(adapted).toHaveLength(6);
    expect(adapted.every((record) => record.schemaVersion === 1)).toBe(true);
    expect(adapted.every((record) => record.runId === 'legacy-a1b2c3')).toBe(true);
    expect(adapted.map((record) => record.kind)).toEqual([
      'dispatch',
      'completion',
      'surfacing',
      'revision-emitted',
      'revision-routed',
      'proof',
    ]);

    const versioned = {
      schemaVersion: 1,
      kind: 'dispatch',
      ts: 1,
      path: [],
      unit: 'job',
    } as const;
    expect(adaptSemanticRunRecord(versioned, 'ignored-a1b2c3')).toEqual(versioned);

    expect(() =>
      adaptSemanticRunRecord({
        kind: 'advisor-consult',
        ts: 1,
        path: [],
        label: 'advisor',
        call: 1,
        question: 'q',
        reply: 'a',
      }),
    ).toThrow();
    expect(() =>
      adaptSemanticRunRecord({
        schemaVersion: 2,
        kind: 'dispatch',
        ts: 1,
        path: [],
        unit: 'job',
      }),
    ).toThrow();
  });
});
