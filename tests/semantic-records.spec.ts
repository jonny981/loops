import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fnJob,
  loop,
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
      fnJob('compile', async () => ({ status: 'pass', summary: 'compiled' })),
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
        outcome: expect.objectContaining({ status: 'pass', summary: 'compiled' }),
      }),
    );
  });

  it('records review surfacing and revision requests', async () => {
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
        kind: 'revision',
        sourceEvent: 'loop:review',
        revision: expect.objectContaining({
          reason: 'Missing cancellation handling.',
        }),
      }),
    );
  });
});
