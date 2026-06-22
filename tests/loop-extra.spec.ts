import { describe, it, expect } from 'vitest';

import { run, loop, fnJob, predicate, MockEngine } from '../src/api.ts';
import type { Job, RunOptions } from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('loop extras', () => {
  it('stopOn aborts the loop early', async () => {
    let n = 0;
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => {
          n += 1;
          return { status: 'fail' };
        }),
        stopOn: predicate(() => n >= 2, 'n>=2'),
        max: 10,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('aborted');
    expect(n).toBe(2);
  });

  it('retry.onError "fail" ends the loop on a thrown body', async () => {
    const throwing: Job = async () => {
      throw new Error('boom');
    };
    const { outcome } = await run(
      loop({ name: 'x', body: throwing, retry: { onError: 'fail' }, max: 5 }),
      mockOpts,
    );
    expect(outcome.status).toBe('fail');
  });

  it('retry.onError "continue" tolerates errors up to maxConsecutive', async () => {
    let n = 0;
    const throwing: Job = async () => {
      n += 1;
      throw new Error('e');
    };
    const { outcome } = await run(
      loop({
        name: 'x',
        body: throwing,
        retry: { onError: 'continue', maxConsecutive: 3 },
        max: 100,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('fail');
    expect(n).toBe(3);
  });
});
