import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, loop, fnJob, predicate } from '../src/api.ts';
import { listRuns, readRunStatus, runEventsPath } from '../src/api.ts';

// A supervised run registers itself under LOOPS_HOME/runs and writes its live
// state there. The read side (list/status/tail) is just file IO, so the whole
// thing is testable offline by pointing LOOPS_HOME at a temp dir.

describe('out-of-process supervision', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'loops-home-'));
    process.env.LOOPS_HOME = home;
  });

  afterAll(() => {
    delete process.env.LOOPS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('registers a supervised run with its shape, live state, and events', async () => {
    let n = 0;
    const job = loop({
      name: 'sup-test',
      body: fnJob('step', async () => ({
        status: ++n >= 2 ? ('pass' as const) : ('fail' as const),
        summary: `n=${n}`,
      })),
      until: predicate(() => n >= 2, 'two steps'),
      max: 5,
    });

    const result = await run(job, { supervise: true });
    expect(result.runId).toBeDefined();
    const id = result.runId!;

    // status.json reflects the terminal outcome and the loop's shape
    const st = readRunStatus(id);
    expect(st).toBeDefined();
    expect(st!.status).toBe('pass');
    expect(st!.title).toBe('sup-test');
    expect(st!.shape?.kind).toBe('loop');
    expect(st!.live.iteration).toBeGreaterThanOrEqual(2);
    expect(st!.live.lastOutcome?.status).toBe('pass');

    // listRuns sees it
    expect(listRuns().some((r) => r.runId === id)).toBe(true);

    // events were appended
    const events = readFileSync(runEventsPath(id), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string });
    expect(events.some((e) => e.kind === 'loop:iteration')).toBe(true);
    expect(events.some((e) => e.kind === 'loop:end')).toBe(true);
  });
});
