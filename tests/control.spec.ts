import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  run,
  loop,
  dag,
  fnJob,
  livePlan,
  requestControl,
  MockEngine,
} from '../src/api.ts';
import type { Outcome, RunOptions } from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

// The control channel is registry files; isolate each test's registry.
let home: string;
let priorHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'loops-control-'));
  priorHome = process.env.LOOPS_HOME;
  process.env.LOOPS_HOME = home;
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.LOOPS_HOME;
  else process.env.LOOPS_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
const planName = () => `control-spec-${(seq += 1)}`;

describe('out-of-process control', () => {
  it('rejects a runId outside the registry alphabet', () => {
    expect(() => requestControl('../escape', { cmd: 'pause' })).toThrow(
      /runId must match/,
    );
  });

  it('pause lands at the loop safepoint as a resumable paused outcome', async () => {
    const runId = 'pause-test';
    let iterations = 0;
    const { outcome } = await run(
      loop({
        name: 'pausable',
        max: 200,
        delayMs: 20,
        body: fnJob('tick', async () => {
          iterations += 1;
          if (iterations === 1)
            requestControl(runId, { cmd: 'pause', reason: 'operator hold' });
          return { status: 'fail' as const, summary: 'not done yet' };
        }),
      }),
      { ...mockOpts, supervise: true, runId },
    );
    expect(outcome.status).toBe('paused');
    expect(outcome.summary).toMatch(/paused by control: operator hold/);
    expect(iterations).toBeGreaterThanOrEqual(1);
    expect(iterations).toBeLessThan(200); // it did not run out the cap
  });

  it('abort stops the run via the root signal', async () => {
    const runId = 'abort-test';
    let iterations = 0;
    const { outcome } = await run(
      loop({
        name: 'abortable',
        max: 200,
        delayMs: 20,
        body: fnJob('tick', async () => {
          iterations += 1;
          if (iterations === 1) requestControl(runId, { cmd: 'abort' });
          return { status: 'fail' as const };
        }),
      }),
      { ...mockOpts, supervise: true, runId },
    );
    expect(outcome.status).toBe('aborted');
    expect(iterations).toBeLessThan(200);
  });

  it('never replays commands written before the run started', async () => {
    const runId = 'stale-test';
    // A previous life's pause AND abort sit in the control file. A fresh run
    // must ignore both — replaying a stale abort would kill every resume.
    requestControl(runId, { cmd: 'pause', reason: 'from a previous life' });
    requestControl(runId, { cmd: 'abort' });
    let iterations = 0;
    const { outcome } = await run(
      loop({
        name: 'fresh',
        max: 3,
        delayMs: 30,
        body: fnJob('tick', async () => {
          iterations += 1;
          return { status: 'fail' as const };
        }),
      }),
      { ...mockOpts, supervise: true, runId },
    );
    expect(outcome.status).toBe('exhausted'); // ran out its cap, untouched
    expect(iterations).toBe(3);
  });

  it('emits a refused dag:edit when a steer batch is invalid', async () => {
    const runId = 'refuse-test';
    const name = planName();
    const plan = livePlan({
      name,
      nodes: {
        waiter: fnJob('waiter', async (ctx) => {
          requestControl(runId, {
            cmd: 'steer',
            plan: name,
            edits: [{ op: 'explode', name: 'x' } as never],
          });
          // Hold the barrier open until the poller has delivered the command.
          const deadline = Date.now() + 5_000;
          while (!refused.length && Date.now() < deadline && !ctx.signal.aborted)
            await new Promise((r) => setTimeout(r, 10));
          return { status: 'pass' as const };
        }),
      },
    });
    const refused: string[] = [];
    const { outcome } = await run(dag({ name: 'refusals', plan }), {
      ...mockOpts,
      supervise: true,
      runId,
      onEvent: (e) => {
        if (e.kind === 'dag:edit' && !e.accepted) refused.push(e.note ?? '');
      },
    });
    expect(outcome.status).toBe('pass');
    expect(refused.length).toBe(1);
    expect(refused[0]).toMatch(/unknown edit op "explode"/);
    expect(plan.version).toBe(1); // nothing applied
  });

  it('steer reaches a running live dag from outside the job tree', async () => {
    const runId = 'steer-test';
    const name = planName();
    const plan = livePlan({
      name,
      templates: {
        extra: () => fnJob('extra', async () => ({ status: 'pass' as const })),
      },
      nodes: {
        waiter: fnJob('waiter', async (ctx) => {
          // Send the steer through the real channel (registry file), then hold
          // the barrier open until the control poller delivers it.
          requestControl(runId, {
            cmd: 'steer',
            plan: name,
            edits: [{ op: 'add', name: 'extra', template: 'extra' }],
          });
          const deadline = Date.now() + 5_000;
          while (plan.version === 1 && Date.now() < deadline && !ctx.signal.aborted)
            await new Promise((r) => setTimeout(r, 10));
          return { status: 'pass' as const };
        }),
      },
    });
    const { outcome } = await run(dag({ name: 'steerable', plan }), {
      ...mockOpts,
      supervise: true,
      runId,
    });
    expect(outcome.status).toBe('pass');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.extra!.status).toBe('pass'); // the steered-in node ran
  });
});
