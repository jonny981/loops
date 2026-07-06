import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dag,
  fnJob,
  kickback,
  loop,
  predicate,
  revisionRequest,
  run,
  runEventsPath,
  runSemanticRecordsPath,
} from '../src/api.ts';
import type { SemanticRunRecord } from '../src/api.ts';

function readRecords(runId: string): SemanticRunRecord[] {
  const raw = readFileSync(runSemanticRecordsPath(runId), 'utf8').trim();
  return raw ? raw.split('\n').map((line) => JSON.parse(line) as SemanticRunRecord) : [];
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
});
