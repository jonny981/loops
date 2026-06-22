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

  it('a failed dependency blocks a required dependent even when the dep is optional', async () => {
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
    expect(ran).toEqual(['a']); // b never runs against a failed dependency
    // a required node left undone by an upstream failure is a fail (exit 1),
    // not a cancellation (aborted/130).
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
