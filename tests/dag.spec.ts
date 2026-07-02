import { describe, it, expect } from 'vitest';

import { run, dag, sequence, parallel, fnJob } from '../src/api.ts';
import type { Outcome, RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};
const pass = (rec: string[], name: string) =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'pass' as const };
  });
const fail = (rec: string[], name: string) =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'fail' as const };
  });

describe('dag', () => {
  it('sequence runs in order and stops at the first failure', async () => {
    const order: string[] = [];
    const { outcome } = await run(
      sequence('seq', pass(order, 'a'), pass(order, 'b'), pass(order, 'c')),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('parallel runs every node regardless of failures', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      parallel('par', { a: fail(ran, 'a'), b: pass(ran, 'b') }),
      mockOpts,
    );
    expect(ran.sort()).toEqual(['a', 'b']);
    expect(outcome.status).toBe('fail');
  });

  it('blocks dependents of a failed required node', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'd',
        nodes: { a: fail(ran, 'a'), b: { job: pass(ran, 'b'), needs: ['a'] } },
      }),
      mockOpts,
    );
    expect(ran).toEqual(['a']);
    expect(outcome.status).toBe('fail');
  });

  it('detects cycles before running', () => {
    expect(() =>
      dag({
        name: 'c',
        nodes: {
          a: {
            job: fnJob('a', async () => ({ status: 'pass' })),
            needs: ['b'],
          },
          b: {
            job: fnJob('b', async () => ({ status: 'pass' })),
            needs: ['a'],
          },
        },
      }),
    ).toThrow(/cycle/);
  });

  it('an optional leaf failure does not fail the DAG', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'o',
        nodes: {
          a: pass(ran, 'a'),
          notify: { job: fail(ran, 'notify'), optional: true },
        },
      }),
      mockOpts,
    );
    expect(ran.sort()).toEqual(['a', 'notify']);
    expect(outcome.status).toBe('pass'); // optional failure ignored
  });

  it('a failed optional producer does not block a required dependent', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'o',
        nodes: {
          a: { job: fail(ran, 'a'), optional: true },
          b: { job: pass(ran, 'b'), needs: ['a'] },
        },
      }),
      mockOpts,
    );
    // An optional producer is best-effort: its failure neither fails the DAG
    // nor blocks consumers — b runs and its real outcome (not a synthetic
    // abort) is what the dag carries.
    expect(ran).toEqual(['a', 'b']);
    expect(outcome.status).toBe('pass');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.b).toMatchObject({ status: 'pass' });
  });

  it("a dependent of a failed optional producer still fails on its own merit", async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'o',
        nodes: {
          a: { job: fail(ran, 'a'), optional: true },
          b: { job: fail(ran, 'b'), needs: ['a'] },
        },
      }),
      mockOpts,
    );
    expect(ran).toEqual(['a', 'b']); // b ran (not blocked) and failed itself
    expect(outcome.status).toBe('fail');
  });

  it('a failed optional producer does not stop scheduling under stopOnError', async () => {
    const ran: string[] = [];
    const slow = fnJob('slow', async () => {
      await new Promise((r) => setTimeout(r, 30));
      ran.push('slow');
      return { status: 'pass' as const };
    });
    const { outcome } = await run(
      dag({
        name: 's',
        nodes: {
          opt: { job: fail(ran, 'opt'), optional: true },
          dep: { job: pass(ran, 'dep'), needs: ['opt'] },
          slow,
          late: { job: pass(ran, 'late'), needs: ['slow'] },
        },
      }),
      mockOpts,
    );
    // dep is not blocked (and records a pass), so stopOnError never trips —
    // the unrelated slow→late chain must still be scheduled to completion.
    expect(ran.sort()).toEqual(['dep', 'late', 'opt', 'slow']);
    expect(outcome.status).toBe('pass');
  });

  it('a failed required producer blocks a consumer that also has a failed optional producer', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'm',
        nodes: {
          req: fail(ran, 'req'),
          opt: { job: fail(ran, 'opt'), optional: true },
          c: { job: pass(ran, 'c'), needs: ['req', 'opt'] },
        },
        stopOnError: false,
      }),
      mockOpts,
    );
    // Mixed needs: the optional producer's failure is forgiven, but the
    // required producer's is not — one hard dependency is enough to block.
    expect(ran.sort()).toEqual(['opt', 'req']);
    expect(outcome.status).toBe('fail');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.c).toMatchObject({
      status: 'aborted',
      summary: 'blocked by a failed dependency',
    });
  });

  it('an aborted optional producer (blocked upstream) does not block its consumer', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 't',
        nodes: {
          a: fail(ran, 'a'),
          b: { job: pass(ran, 'b'), needs: ['a'], optional: true },
          c: { job: pass(ran, 'c'), needs: ['b'] },
        },
        stopOnError: false,
      }),
      mockOpts,
    );
    // a (required) fails → b is blocked-aborted; b is optional, so its abort
    // neither blocks c nor counts against the dag — but a's own failure does.
    expect(ran.sort()).toEqual(['a', 'c']);
    const data = outcome.data as Record<string, Outcome>;
    expect(data.b).toMatchObject({ status: 'aborted' });
    expect(data.c).toMatchObject({ status: 'pass' });
    expect(outcome.status).toBe('fail');
  });

  it('skips a node whose `when` gate is unmet', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'w',
        nodes: {
          a: pass(ran, 'a'),
          b: { job: pass(ran, 'b'), needs: ['a'], when: () => false },
        },
      }),
      mockOpts,
    );
    expect(ran).toEqual(['a']);
    expect(outcome.status).toBe('pass');
  });

  it('respects a concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const make = (name: string) =>
      fnJob(name, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { status: 'pass' } as Outcome;
      });
    await run(
      parallel(
        'p',
        { a: make('a'), b: make('b'), c: make('c'), d: make('d') },
        2,
      ),
      mockOpts,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});
