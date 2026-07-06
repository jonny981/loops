import { describe, it, expect } from 'vitest';

import { run, loop, fnJob, predicate, MockEngine } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('loop primitive', () => {
  it('aborts when the start gate is not met', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'pass' })),
        start: predicate(() => false),
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('aborted');
  });

  it('stops when `until` is met', async () => {
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'count',
        body: fnJob('b', async () => {
          n += 1;
          return { status: 'fail', summary: `n=${n}` };
        }),
        until: predicate(() => n >= 3, 'n>=3'),
        max: 10,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(stats.loops[0]?.iterations).toBe(3);
  });

  it('marks the loop late when the converged body outcome is late', async () => {
    const { outcome } = await run(
      loop({
        name: 'late-body',
        body: fnJob('b', async () => ({ status: 'pass', late: true })),
        max: 1,
      }),
      mockOpts,
    );

    expect(outcome.status).toBe('pass');
    expect(outcome.late).toBe(true);
  });

  it('exhausts at max when nothing converges', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 4,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('exhausted');
  });

  it('re-enters the loop when review fails, then passes', async () => {
    let work = 0;
    let reviews = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'wr',
        body: fnJob('b', async () => {
          work += 1;
          return { status: 'pass', summary: `w${work}` };
        }),
        until: predicate(() => true),
        review: fnJob('rev', async () => {
          reviews += 1;
          return { status: reviews >= 2 ? 'pass' : 'fail' };
        }),
        max: 5,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(work).toBe(2);
    expect(reviews).toBe(2);
    expect(stats.loops[0]?.reviewsFailed).toBe(1);
    expect(stats.loops[0]?.reviewsPassed).toBe(1);
  });

  it('nests loops within loops', async () => {
    let innerRuns = 0;
    const inner = loop({
      name: 'inner',
      body: fnJob('i', async () => {
        innerRuns += 1;
        return { status: 'pass' };
      }),
      max: 1,
    });
    let outerIter = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'outer',
        body: inner,
        until: predicate(() => {
          outerIter += 1;
          return outerIter >= 3;
        }),
        max: 10,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(innerRuns).toBe(3);
    const paths = stats.loops.map((l) => l.path);
    expect(paths).toContain('outer');
    expect(paths.some((p) => p.includes('inner'))).toBe(true);
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => {
          ac.abort();
          return { status: 'fail' };
        }),
        max: 100,
      }),
      { ...mockOpts, signal: ac.signal },
    );
    expect(outcome.status).toBe('aborted');
  });

  it('runs onComplete exactly once', async () => {
    let calls = 0;
    await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'pass' })),
        onComplete: () => {
          calls += 1;
        },
      }),
      mockOpts,
    );
    expect(calls).toBe(1);
  });
});
