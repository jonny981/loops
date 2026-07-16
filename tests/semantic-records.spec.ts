import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dag,
  fnJob,
  gateJob,
  humanGate,
  humanGateKey,
  kickback,
  loop,
  predicate,
  readSemanticRecords,
  revisionRequest,
  run,
  runEventsPath,
  runSemanticRecordsPath,
  semanticRecordsFromEvent,
  sequence,
} from '../src/api.ts';
import type { Condition, LoopEvent, SemanticRunRecord } from '../src/api.ts';
import { parseSemanticRunRecord } from '../src/runtime/semantic-schema.ts';

function readRecords(runId: string): SemanticRunRecord[] {
  return readSemanticRecords(runId) ?? [];
}

describe('semantic run records', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'loops-semantic-'));
    process.env.LOOPS_HOME = home;
  });

  afterAll(() => {
    delete process.env.LOOPS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('writes dispatch and completion records beside supervised raw events', async () => {
    const result = await run(
      fnJob('compile', async () => ({
        status: 'pass',
        summary: 'compiled',
        late: true,
      })),
      { supervise: true },
    );
    const runId = result.runId!;

    expect(readFileSync(runEventsPath(runId), 'utf8')).toContain('"job:start"');
    const records = readRecords(runId);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      runId,
      kind: 'lifecycle-transition',
      unit: 'run',
      from: 'created',
      to: 'running',
    });
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 1,
      runId,
      kind: 'lifecycle-transition',
      unit: 'run',
      from: 'running',
      to: 'pass',
    });
    const rawRecords = readFileSync(runSemanticRecordsPath(runId), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(rawRecords.every((record) => parseSemanticRunRecord(record))).toBe(true);
    expect(records.every((record) => record.runId === runId)).toBe(true);
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch',
        unit: 'job',
        label: 'compile',
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'completion',
        unit: 'job',
        label: 'compile',
        outcome: expect.objectContaining({
          status: 'pass',
          summary: 'compiled',
          late: true,
        }),
      }),
    );
  });

  it('records review surfacing plus emitted and routed revision requests', async () => {
    let reviews = 0;
    const result = await run(
      loop({
        name: 'build',
        body: fnJob('implementation', async () => ({ status: 'pass', summary: 'implemented' })),
        review: fnJob('review', async () => {
          reviews += 1;
          return reviews === 1
            ? revisionRequest({
                reason: 'Missing cancellation handling.',
                findings: [
                  {
                    reviewer: 'correctness',
                    severity: 'blocking',
                    evidence: 'AbortSignal is ignored.',
                  },
                ],
              })
            : { status: 'pass', summary: 'approved' };
        }),
        max: 2,
      }),
      { supervise: true },
    );

    const records = readRecords(result.runId!);
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'surfacing',
        source: 'loop-review',
        decision: 'accepted',
        severity: 'block',
        reason: 'Missing cancellation handling.',
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'revision-emitted',
        sourceEvent: 'job:end',
        revision: expect.objectContaining({
          reason: 'Missing cancellation handling.',
        }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'revision-routed',
        sourceEvent: 'loop:review',
        decision: 'accepted',
        revision: expect.objectContaining({
          reason: 'Missing cancellation handling.',
        }),
      }),
    );
  });

  it('marks a review that exhausts the loop as rejected, not accepted', async () => {
    const result = await run(
      loop({
        name: 'build',
        body: fnJob('implementation', async () => ({
          status: 'pass',
          summary: 'implemented',
        })),
        // Always fails; max: 1 leaves no room to re-enter, so the loop exhausts.
        review: fnJob('review', async () =>
          revisionRequest({ reason: 'Still not right.' }),
        ),
        max: 1,
      }),
      { supervise: true },
    );

    // The loop gave up without re-running, so the surfaced/routed revision is
    // rejected, not accepted — otherwise a supervisor reads dropped feedback as
    // acted-on.
    const records = readRecords(result.runId!);
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'surfacing',
        source: 'loop-review',
        decision: 'rejected',
        reason: 'Still not right.',
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'revision-routed',
        sourceEvent: 'loop:review',
        decision: 'rejected',
      }),
    );
  });

  it('records a node-level completion for every node type, with re-run attempts', async () => {
    let checks = 0;
    const result = await run(
      dag({
        name: 'pipe',
        maxKickbacks: 1,
        nodes: {
          // A bare async function node: it emits no job:end of its own, so its
          // only completion is the dag-node one.
          seed: async () => ({ status: 'pass', summary: 'seeded' }),
          // Skipped by an unmet `when` — still visible in the stream.
          optional: {
            when: predicate(() => false, 'not needed'),
            job: fnJob('optional', async () => ({ status: 'pass' })),
          },
          // Kicks seed back once, then passes — forcing seed to re-run.
          check: {
            needs: ['seed'],
            job: fnJob('check', async () => {
              checks += 1;
              return checks === 1
                ? kickback('seed', 'redo the seed')
                : { status: 'pass', summary: 'ok after redo' };
            }),
          },
        },
      }),
      { supervise: true },
    );

    const nodeCompletions = readRecords(result.runId!).filter(
      (r): r is Extract<SemanticRunRecord, { kind: 'completion' }> =>
        r.kind === 'completion' && r.unit === 'dag-node',
    );
    // The bare-fn node completes on its first run and again after the kickback.
    expect(nodeCompletions).toContainEqual(
      expect.objectContaining({ label: 'seed', attempt: 1 }),
    );
    expect(nodeCompletions).toContainEqual(
      expect.objectContaining({ label: 'seed', attempt: 2 }),
    );
    // The skipped node is visible rather than silently absent.
    expect(nodeCompletions).toContainEqual(
      expect.objectContaining({
        label: 'optional',
        outcome: expect.objectContaining({
          summary: expect.stringContaining('skipped'),
        }),
      }),
    );
  });

  it('projects gate, advisor, pause, and restore events into versioned records', () => {
    const events: LoopEvent[] = [
      {
        kind: 'loop:condition',
        ts: 1,
        path: ['build'],
        which: 'until',
        iteration: 2,
        result: {
          met: false,
          confidence: 0.4,
          reason: 'one test failed',
          output: 'FAIL cancellation',
        },
      },
      {
        kind: 'advisor:consult',
        ts: 2,
        path: ['build'],
        label: 'implementer',
        call: 1,
        question: 'Which adapter is compatible?',
        reply: 'Use an in-memory legacy adapter.',
        model: 'advisor-model',
      },
      {
        kind: 'human:gate',
        ts: 3,
        path: ['release'],
        name: 'ship-it',
        prompt: 'Approve release',
        resumeCommand: 'loops run release.loop.ts --resume release.ckpt',
      },
      {
        kind: 'limit:pause',
        ts: 4,
        path: ['build'],
        code: 'QUOTA',
        reason: 'quota resets later',
        resumeCommand: 'loops run build.loop.ts --resume build.ckpt',
      },
      {
        kind: 'runtime:restore',
        ts: 5,
        path: [],
        checkpoint: 'build.ckpt',
        decision: 'restored',
        restoredNodes: 2,
        totalNodes: 3,
        reason: 'restored 2/3 nodes from a matching workspace',
        fingerprint: 'matched',
      },
    ];

    const records = events.flatMap((event) =>
      semanticRecordsFromEvent(event, 'projection-a1b2c3'),
    );
    expect(records).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        runId: 'projection-a1b2c3',
        kind: 'gate-verdict',
        gate: 'until',
        iteration: 2,
        met: false,
        reason: 'one test failed',
        confidence: 0.4,
        output: 'FAIL cancellation',
      }),
      expect.objectContaining({
        kind: 'advisor-consult',
        call: 1,
        question: 'Which adapter is compatible?',
        reply: 'Use an in-memory legacy adapter.',
      }),
      expect.objectContaining({
        kind: 'lifecycle-transition',
        unit: 'job',
        from: 'running',
        to: 'paused',
        acknowledgement: {
          name: 'ship-it',
          prompt: 'Approve release',
        },
      }),
      expect.objectContaining({
        kind: 'lifecycle-transition',
        unit: 'loop',
        from: 'running',
        to: 'paused',
        metadata: { code: 'QUOTA' },
      }),
      expect.objectContaining({
        kind: 'lifecycle-transition',
        unit: 'run',
        from: 'paused',
        to: 'running',
        checkpoint: {
          path: 'build.ckpt',
          decision: 'restored',
          restoredNodes: 2,
          totalNodes: 3,
          fingerprint: 'matched',
        },
      }),
    ]);
    expect(records.every((record) => parseSemanticRunRecord(record))).toBe(true);
    expect(() => semanticRecordsFromEvent(events[0]!, '../invalid')).toThrow();
  });

  it('omits trusted changed-workspace restores from semantic record v1', () => {
    const event: LoopEvent = {
      kind: 'runtime:restore',
      ts: 5,
      path: [],
      checkpoint: 'build.ckpt',
      decision: 'restored',
      restoredNodes: 2,
      totalNodes: 3,
      reason: 'restored 2/3 nodes from an explicitly trusted changed workspace',
      fingerprint: 'changed',
    };

    expect(semanticRecordsFromEvent(event, 'projection-a1b2c3')).toEqual([]);
  });

  it('records verdicts from dag when conditions and gate jobs', async () => {
    const whenCondition: Condition = async () => ({
      met: false,
      reason: 'optional node disabled',
      confidence: 1,
      output: 'WHEN_EVIDENCE',
    });
    const qualityCondition: Condition = async () => ({
      met: true,
      reason: 'quality accepted',
      confidence: 0.95,
      output: 'GATE_EVIDENCE',
    });
    const result = await run(
      dag({
        name: 'condition-surfaces',
        nodes: {
          optional: {
            when: whenCondition,
            job: fnJob('optional', async () => ({ status: 'pass' })),
          },
          quality: gateJob('quality-check', qualityCondition),
        },
      }),
      { supervise: true },
    );

    const verdicts = readRecords(result.runId!).filter(
      (record): record is Extract<SemanticRunRecord, { kind: 'gate-verdict' }> =>
        record.kind === 'gate-verdict',
    );
    expect(verdicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['condition-surfaces', 'optional'],
          gate: 'when',
          iteration: 0,
          met: false,
          confidence: 1,
          output: 'WHEN_EVIDENCE',
        }),
        expect.objectContaining({
          path: ['condition-surfaces', 'quality'],
          gate: 'quality-check',
          iteration: 0,
          met: true,
          confidence: 0.95,
          output: 'GATE_EVIDENCE',
        }),
      ]),
    );
  });

  it('writes a coherent resumed lifecycle in timestamp order', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'loops-semantic-resume-'));
    const checkpoint = join(workspace, 'checkpoint.json');
    const build = () =>
      sequence(
        'resume-contract',
        fnJob('prepare', async () => ({ status: 'pass' })),
        humanGate({ name: 'approve' }),
      );

    try {
      const paused = await run(build(), {
        cwd: workspace,
        checkpoint,
        supervise: true,
        runId: 'semantic-paused-a1b2c3',
      });
      expect(paused.outcome.status).toBe('paused');

      const resumed = await run(build(), {
        cwd: workspace,
        resumeFrom: checkpoint,
        state: { [humanGateKey('approve')]: true },
        supervise: true,
        runId: 'semantic-resumed-a1b2c3',
      });
      expect(resumed.outcome.status).toBe('pass');

      const records = readRecords(resumed.runId!);
      expect(records[0]).toMatchObject({
        kind: 'lifecycle-transition',
        unit: 'run',
        from: 'paused',
        to: 'running',
        checkpoint: { decision: 'restored', restoredNodes: 1 },
      });
      expect(records.map((record) => record.ts)).toEqual(
        [...records.map((record) => record.ts)].sort((a, b) => a - b),
      );
      expect(
        records.filter(
          (record) =>
            record.kind === 'lifecycle-transition' &&
            record.unit === 'run' &&
            record.from === 'created' &&
            record.to === 'running',
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps semantic validation best-effort for cyclic proof payloads', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = await run(
      fnJob('cyclic-proof', async (ctx) => {
        ctx.emit({
          kind: 'proof',
          ts: Date.now(),
          path: [...ctx.path],
          name: 'cyclic',
          artifact: { kind: 'json', data: cyclic as never },
        });
        return { status: 'pass', summary: 'work completed' };
      }),
      { supervise: true },
    );

    expect(result.outcome.status).toBe('pass');
    const records = readRecords(result.runId!);
    expect(records.some((record) => record.kind === 'proof')).toBe(false);
    expect(records.at(-1)).toMatchObject({
      kind: 'lifecycle-transition',
      to: 'pass',
    });
  });

  it('adapts known legacy lines while skipping torn, invalid, and unsupported records', async () => {
    const result = await run(
      fnJob('legacy-reader', async () => ({ status: 'pass' })),
      { supervise: true },
    );
    const runId = result.runId!;
    writeFileSync(
      runSemanticRecordsPath(runId),
      [
        JSON.stringify({
          kind: 'dispatch',
          ts: 1,
          path: ['legacy'],
          unit: 'job',
          label: 'legacy',
        }),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'completion',
          ts: 2,
          path: ['v1'],
          unit: 'job',
          label: 'v1',
          outcome: { status: 'pass' },
        }),
        JSON.stringify({
          schemaVersion: 2,
          kind: 'dispatch',
          ts: 3,
          path: [],
          unit: 'job',
        }),
        JSON.stringify({ schemaVersion: 1, kind: 'unknown', ts: 4, path: [] }),
        '{"torn":',
      ].join('\n'),
    );

    expect(readSemanticRecords(runId)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        runId,
        kind: 'dispatch',
        label: 'legacy',
      }),
      expect.objectContaining({
        schemaVersion: 1,
        kind: 'completion',
      }),
    ]);
    expect(readSemanticRecords('../../outside/registry')).toBeUndefined();
  });
});
