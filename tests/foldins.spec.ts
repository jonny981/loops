import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, loop, fnJob, agentJob, agentCheck, Budget } from '../src/api.ts';
import type { Engine } from '../src/api.ts';

/** A stateless engine that reports `perCall` tokens per turn (half in, half out). */
const usageEngine = (perCall = 200): Engine => ({
  name: 'usage-mock',
  async run(_req, onEvent) {
    const half = perCall / 2;
    onEvent({
      type: 'usage',
      usage: { inputTokens: half, outputTokens: half },
      model: 'usage-mock',
    });
    return {
      text: 'ok',
      usage: { inputTokens: half, outputTokens: half },
      model: 'usage-mock',
    };
  },
});

/** An engine that always returns the same text — for scripted validator replies. */
const replyEngine = (text: string): Engine => ({
  name: 'reply',
  async run() {
    return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: 'reply' };
  },
});

const failBody = () => fnJob('b', async () => ({ status: 'fail' as const }));
const usageOpts = (perCall = 200) => ({
  engine: 'um',
  engines: { um: () => usageEngine(perCall) },
});

describe('Budget', () => {
  it('tracks spent / remaining / exceeded and ignores junk', () => {
    const b = new Budget({ limit: 100 });
    expect(b.exceeded()).toBe(false);
    b.add(60);
    b.add(-5); // ignored
    b.add(Number.NaN); // ignored
    expect(b.spent()).toBe(60);
    expect(b.remaining()).toBe(40);
    b.add(50);
    expect(b.spent()).toBe(110);
    expect(b.remaining()).toBe(0);
    expect(b.exceeded()).toBe(true);
  });

  it('headroom reserves capacity before the hard cap', () => {
    const b = new Budget({ limit: 100, headroom: 30 });
    b.add(75); // 75 + 30 >= 100
    expect(b.exceeded()).toBe(true);
  });

  it('refuses engine calls once the run budget is exhausted', async () => {
    const body = agentJob({
      label: 'w',
      prompt: 'go',
      outcome: () => ({ status: 'fail' as const }),
    });
    // onLimit:'fail' keeps the old fatal contract — a budget hit terminates
    // the run as `fail` rather than the default `auto`'s pause-to-resume.
    const { outcome, budget } = await run(loop({ name: 'x', body, max: 10 }), {
      ...usageOpts(200),
      budget: 500,
      onLimit: 'fail',
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('BUDGET');
    expect(budget?.spent).toBeGreaterThanOrEqual(500);
  });

  it('soft budget warns but lets the run continue', async () => {
    const body = agentJob({
      label: 'w',
      prompt: 'go',
      outcome: () => ({ status: 'fail' as const }),
    });
    const { outcome } = await run(loop({ name: 'x', body, max: 3 }), {
      ...usageOpts(200),
      budget: { limit: 100, soft: true },
    });
    // ran to max despite the cap being blown on the first call
    expect(outcome.status).toBe('exhausted');
  });
});

describe('record + checkpoint + resume', () => {
  it('writes a record, snapshots state, and restores it on resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-'));
    const record = join(dir, 'run.jsonl');
    const checkpoint = join(dir, 'ckpt.json');

    const body = fnJob('step', async (ctx) => {
      ctx.state.count = ((ctx.state.count as number) ?? 0) + 1;
      return { status: 'fail' as const };
    });
    const r1 = await run(loop({ name: 'x', body, max: 3 }), {
      ...usageOpts(),
      recordTo: record,
      checkpoint,
    });
    expect(r1.outcome.status).toBe('exhausted');

    const lines = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((e) => e.kind !== 'engine:text')).toBe(true);
    expect(lines.some((e) => e.kind === 'loop:end')).toBe(true);

    const ckpt = JSON.parse(readFileSync(checkpoint, 'utf8')) as {
      state: { count: number };
    };
    expect(ckpt.state.count).toBe(3);

    let observed: number | undefined;
    const peek = fnJob('peek', async (ctx) => {
      observed = ctx.state.count as number;
      return { status: 'pass' as const };
    });
    await run(loop({ name: 'y', body: peek, max: 1 }), {
      ...usageOpts(),
      resumeFrom: checkpoint,
    });
    expect(observed).toBe(3);
  });

  it('a missing resume file is a clean CONFIG error', async () => {
    await expect(
      run(loop({ name: 'x', body: failBody(), max: 1 }), {
        ...usageOpts(),
        resumeFrom: join(tmpdir(), 'loops-nope-does-not-exist.json'),
      }),
    ).rejects.toThrow(/cannot resume/);
  });
});

describe('agentCheck dimensions', () => {
  it('gates on the geometric mean of the dimension scores', async () => {
    const text = JSON.stringify({ scores: { a: 0.9, b: 0.9 }, reason: 'ok' });
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failBody(),
        until: agentCheck({
          question: '?',
          threshold: 0.8,
          dimensions: ['a', 'b'],
        }),
        max: 3,
      }),
      { engine: 'r', engines: { r: () => replyEngine(text) } },
    );
    expect(outcome.status).toBe('pass'); // geo(0.9, 0.9) = 0.9 >= 0.8
  });

  it('one weak dimension drags the mean below threshold', async () => {
    const text = JSON.stringify({
      scores: { a: 0.95, b: 0.1 },
      reason: 'weak b',
    });
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failBody(),
        until: agentCheck({
          question: '?',
          threshold: 0.6,
          dimensions: ['a', 'b'],
        }),
        max: 2,
      }),
      { engine: 'r', engines: { r: () => replyEngine(text) } },
    );
    expect(outcome.status).toBe('exhausted'); // geo(0.95, 0.1) ≈ 0.31 < 0.6
  });

  it('a missing dimension scores 0 and fails the gate closed', async () => {
    const text = JSON.stringify({ scores: { a: 0.95 }, reason: 'b missing' });
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failBody(),
        until: agentCheck({
          question: '?',
          threshold: 0.5,
          dimensions: ['a', 'b'],
        }),
        max: 2,
      }),
      { engine: 'r', engines: { r: () => replyEngine(text) } },
    );
    expect(outcome.status).toBe('exhausted'); // b absent → 0 → geo 0
  });
});
