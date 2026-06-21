import { describe, it, expect } from 'vitest';

import { run, loop, fnJob, agentCheck, mockVerdict } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';

const withVerdict = (v: 'yes' | 'no', c: number): RunOptions => ({
  engine: 'mock',
  engines: { mock: () => mockVerdict(v, c) },
});

const failingBody = () => fnJob('b', async () => ({ status: 'fail' as const, summary: 'work' }));

describe('conditions', () => {
  it('agentCheck opens the gate above threshold', async () => {
    const { outcome } = await run(
      loop({ name: 'x', body: failingBody(), until: agentCheck({ question: 'done?', threshold: 0.8 }), max: 5 }),
      withVerdict('yes', 0.9),
    );
    expect(outcome.status).toBe('pass');
  });

  it('agentCheck keeps looping below threshold', async () => {
    const { outcome } = await run(
      loop({ name: 'x', body: failingBody(), until: agentCheck({ question: 'done?', threshold: 0.8 }), max: 3 }),
      withVerdict('yes', 0.5),
    );
    expect(outcome.status).toBe('exhausted');
  });

  it('accepts one-or-many mixed conditions (predicate + agentCheck)', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        // a bare predicate AND an agent check — both must hold (default `all`)
        until: [() => true, agentCheck({ question: 'done?', threshold: 0.8 })],
        max: 5,
      }),
      withVerdict('yes', 0.95),
    );
    expect(outcome.status).toBe('pass');
  });

  it('one-or-many short-circuits when a deterministic member fails', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: [() => false, agentCheck({ question: 'done?', threshold: 0.1 })],
        max: 2,
      }),
      withVerdict('yes', 0.99),
    );
    expect(outcome.status).toBe('exhausted');
  });
});
