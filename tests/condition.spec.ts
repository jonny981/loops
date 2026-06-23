import { describe, it, expect } from 'vitest';

import {
  run,
  loop,
  fnJob,
  agentCheck,
  mockVerdict,
  quorum,
  commandSucceeds,
} from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';

// A mock engine that is never expected to be called — lets engine-free
// conditions (predicates, quorum-of-predicates, commandSucceeds) run without
// constructing a real backend.
const noEngine: RunOptions = {
  engine: 'mock',
  engines: { mock: () => mockVerdict('no', 0) },
};

const withVerdict = (v: 'yes' | 'no', c: number): RunOptions => ({
  engine: 'mock',
  engines: { mock: () => mockVerdict(v, c) },
});

const failingBody = () =>
  fnJob('b', async () => ({ status: 'fail' as const, summary: 'work' }));

describe('conditions', () => {
  it('agentCheck opens the gate above threshold', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: agentCheck({ question: 'done?', threshold: 0.8 }),
        max: 5,
      }),
      withVerdict('yes', 0.9),
    );
    expect(outcome.status).toBe('pass');
  });

  it('agentCheck keeps looping below threshold', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: agentCheck({ question: 'done?', threshold: 0.8 }),
        max: 3,
      }),
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

describe('quorum', () => {
  it('opens when at least k of n hold', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: quorum(
          2,
          () => true,
          () => true,
          () => false,
        ),
        max: 5,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('pass');
  });

  it('keeps looping below k', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: quorum(
          2,
          () => true,
          () => false,
          () => false,
        ),
        max: 2,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('exhausted');
  });

  it('counts a throwing judge as a "no" vote rather than crashing', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: quorum(
          1,
          () => {
            throw new Error('boom');
          },
          () => true,
        ),
        max: 5,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('pass');
  });

  it('rejects an out-of-range k at definition time', () => {
    expect(() => quorum(3, () => true)).toThrow(/quorum requires/);
    expect(() => quorum(0, () => true)).toThrow(/quorum requires/);
  });
});

describe('commandSucceeds', () => {
  it('is met when the command exits 0', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: commandSucceeds('node', ['-e', 'process.exit(0)']),
        max: 3,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('pass');
  });

  it('is not met when the command exits non-zero', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: commandSucceeds('node', ['-e', 'process.exit(1)']),
        max: 2,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('exhausted');
  });
});
