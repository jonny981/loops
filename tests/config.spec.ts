import { describe, it, expect } from 'vitest';

import { parseDuration, buildJobFromFlags, FlagSpec } from '../src/config.ts';
import { run, MockEngine } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';

const mockOpts: RunOptions = { engine: 'mock', engines: { mock: () => new MockEngine(() => 'work done') } };

describe('parseDuration', () => {
  it('parses suffixed durations', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
  });
  it('parses a bare millisecond number', () => {
    expect(parseDuration('250')).toBe(250);
  });
  it('throws on garbage', () => {
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
  });
});

describe('FlagSpec', () => {
  it('requires a prompt', () => {
    expect(() => FlagSpec.parse({ prompt: '' })).toThrow();
  });
  it('rejects an out-of-range threshold', () => {
    expect(() => FlagSpec.parse({ prompt: 'x', threshold: 2 })).toThrow();
  });
});

describe('buildJobFromFlags', () => {
  it('builds a runnable standard loop (worker passes => loop passes)', async () => {
    const job = buildJobFromFlags(FlagSpec.parse({ prompt: 'do the thing' }));
    const { outcome, stats } = await run(job, mockOpts);
    expect(outcome.status).toBe('pass');
    expect(stats.agentCalls).toBeGreaterThanOrEqual(1);
  });
});
