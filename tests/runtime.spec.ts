import { describe, it, expect } from 'vitest';

import { run, exitCodeFor, fnJob, loop, LoopError, MockEngine } from '../src/api.ts';
import type { Engine, RunOptions } from '../src/api.ts';

const mockOpts: RunOptions = { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } };

describe('exitCodeFor', () => {
  it('maps every status', () => {
    expect(exitCodeFor({ status: 'pass' })).toBe(0);
    expect(exitCodeFor({ status: 'fail' })).toBe(1);
    expect(exitCodeFor({ status: 'exhausted' })).toBe(2);
    expect(exitCodeFor({ status: 'aborted' })).toBe(130);
  });
});

describe('run', () => {
  it('catches a thrown root job and reports a fail outcome', async () => {
    const { outcome, stats } = await run(
      fnJob('boom', async () => {
        throw new Error('kaboom');
      }),
      mockOpts,
    );
    // fnJob catches internally and returns fail; the run still records the error
    expect(outcome.status).toBe('fail');
    expect(stats.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('seeds shared state and threads it to jobs', async () => {
    let seen: unknown;
    await run(
      fnJob('peek', async (ctx) => {
        seen = ctx.state.seedValue;
        return { status: 'pass' };
      }),
      { ...mockOpts, state: { seedValue: 42 } },
    );
    expect(seen).toBe(42);
  });

  it('uses a custom Engine instance provided via engines map', async () => {
    let calledWith = '';
    const spy: Engine = {
      name: 'spy',
      async run(req, onEvent) {
        calledWith = req.prompt;
        onEvent({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 }, model: 'spy' });
        return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, model: 'spy' };
      },
    };
    const { outcome } = await run(
      loop({
        name: 'x',
        body: (await import('../src/api.ts')).agentJob({ label: 'w', engine: 'spy', prompt: 'hello-engine' }),
        max: 1,
      }),
      { engine: 'spy', engines: { spy } },
    );
    expect(calledWith).toBe('hello-engine');
    expect(outcome.status).toBe('pass');
  });
});

describe('LoopError', () => {
  it('returns an existing LoopError unchanged via from()', () => {
    const original = new LoopError({ code: 'CONFIG', message: 'bad' });
    expect(LoopError.from(original, { code: 'UNKNOWN' })).toBe(original);
  });
  it('wraps a plain Error and marks ENGINE/TIMEOUT retryable', () => {
    const wrapped = LoopError.from(new Error('net'), { code: 'ENGINE' });
    expect(wrapped.code).toBe('ENGINE');
    expect(wrapped.retryable).toBe(true);
    expect(LoopError.from(new Error('x'), { code: 'CONFIG' }).retryable).toBe(false);
  });
});
