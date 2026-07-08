import { describe, it, expect, vi } from 'vitest';

import { plainReporter, jsonReporter, printSummary } from '../src/reporters.ts';
import type { LoopEvent } from '../src/api.ts';

const sample: LoopEvent[] = [
  {
    kind: 'runtime:restore',
    ts: 0,
    path: [],
    checkpoint: 'ckpt.json',
    decision: 'restored',
    restoredNodes: 1,
    totalNodes: 1,
    reason: 'restored 1/1 nodes from ckpt.json',
    fingerprint: 'matched',
  },
  { kind: 'loop:start', ts: 0, path: ['l'], depth: 1, max: 3 },
  { kind: 'loop:iteration', ts: 0, path: ['l'], iteration: 1 },
  { kind: 'job:start', ts: 0, path: ['l'], label: 'worker' },
  { kind: 'engine:text', ts: 0, path: ['l'], delta: 'streamed ' },
  { kind: 'engine:tool', ts: 0, path: ['l'], name: 'Bash', phase: 'use' },
  {
    kind: 'loop:condition',
    ts: 0,
    path: ['l'],
    which: 'until',
    result: { met: true, reason: 'done' },
  },
  {
    kind: 'loop:review',
    ts: 0,
    path: ['l'],
    outcome: { status: 'fail', summary: 'nope' },
  },
  { kind: 'dag:start', ts: 0, path: ['d'], depth: 1, nodes: ['a', 'b'] },
  {
    kind: 'dag:node',
    ts: 0,
    path: ['d'],
    node: 'a',
    phase: 'done',
    outcome: { status: 'pass' },
  },
  { kind: 'dag:end', ts: 0, path: ['d'], outcome: { status: 'pass' } },
  { kind: 'error', ts: 0, path: ['l'], code: 'ENGINE', message: 'bad' },
  {
    kind: 'limit:wait',
    ts: 0,
    path: ['l'],
    code: 'RATE_LIMIT',
    waitMs: 5000,
    resumeAt: 5000,
  },
  {
    kind: 'limit:pause',
    ts: 0,
    path: ['l'],
    code: 'QUOTA',
    reason: 'usage limit',
    resumeCommand: 'loops run x --resume ckpt.json',
  },
  {
    kind: 'loop:end',
    ts: 0,
    path: ['l'],
    iterations: 1,
    outcome: { status: 'paused' },
  },
];

describe('reporters', () => {
  it('plain reporter handles every event kind without throwing', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = plainReporter();
    expect(() => sample.forEach(report)).not.toThrow();
    write.mockRestore();
    log.mockRestore();
  });

  it('json reporter writes one NDJSON line per event', () => {
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
    const report = jsonReporter();
    sample.forEach(report);
    write.mockRestore();
    expect(lines).toHaveLength(sample.length);
    expect(JSON.parse(lines[0]!).kind).toBe('runtime:restore');
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
  });

  it('plain reporter prints one per-iteration report line per completed iteration', () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => {
        out.push(args.map(String).join(' '));
      });
    // Strip ANSI so assertions are colour-agnostic.
    const clean = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

    const events: LoopEvent[] = [
      { kind: 'loop:start', ts: 0, path: ['build'], depth: 1, max: 3 },
      // iteration 1: body fail, until not met, usage 1200/300
      { kind: 'loop:iteration', ts: 0, path: ['build'], iteration: 1 },
      {
        kind: 'engine:usage',
        ts: 0,
        path: ['build'],
        model: 'm',
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
      {
        kind: 'job:end',
        ts: 0,
        path: ['build'],
        label: 'worker',
        outcome: { status: 'fail' },
      },
      {
        kind: 'loop:condition',
        ts: 0,
        path: ['build'],
        which: 'until',
        result: { met: false, reason: 'no' },
      },
      // iteration 2: body pass, until met, review fail
      { kind: 'loop:iteration', ts: 0, path: ['build'], iteration: 2 },
      {
        kind: 'engine:usage',
        ts: 0,
        path: ['build'],
        model: 'm',
        usage: { inputTokens: 500, outputTokens: 50 },
      },
      {
        kind: 'job:end',
        ts: 0,
        path: ['build'],
        label: 'worker',
        outcome: { status: 'pass' },
      },
      {
        kind: 'loop:condition',
        ts: 0,
        path: ['build'],
        which: 'until',
        result: { met: true, reason: 'yes' },
      },
      {
        kind: 'loop:review',
        ts: 0,
        path: ['build'],
        outcome: { status: 'fail', summary: 'needs X' },
      },
      {
        kind: 'loop:end',
        ts: 0,
        path: ['build'],
        iterations: 2,
        outcome: { status: 'exhausted' },
      },
    ];
    const report = plainReporter();
    events.forEach(report);
    write.mockRestore();
    log.mockRestore();

    const lines = out.map(clean);
    const iter1 = lines.find((l) => l.includes('↳ iter 1:'));
    const iter2 = lines.find((l) => l.includes('↳ iter 2:'));
    expect(iter1).toBeDefined();
    expect(iter1).toContain('body=fail');
    expect(iter1).toContain('until=not met');
    expect(iter1).toContain('1.2k/300 tok');

    expect(iter2).toBeDefined();
    expect(iter2).toContain('body=pass');
    expect(iter2).toContain('until=met');
    expect(iter2).toContain('review=fail');
    expect(iter2).toContain('(needs X)');
    expect(iter2).toContain('500/50 tok');
  });

  it('printSummary renders without throwing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() =>
      printSummary({
        outcome: { status: 'pass', confidence: 0.9, summary: 'ok' },
        stats: {
          startedAt: 0,
          elapsedMs: 1234,
          loops: [
            {
              path: 'l',
              iterations: 2,
              reviewsPassed: 1,
              reviewsFailed: 1,
              lastStatus: 'pass',
            },
          ],
          models: [{ model: 'm', calls: 2, inputTokens: 10, outputTokens: 20 }],
          totalInputTokens: 10,
          totalOutputTokens: 20,
          agentCalls: 2,
          errors: [{ path: 'l', code: 'ENGINE', message: 'x', ts: 0 }],
        },
      }),
    ).not.toThrow();
    log.mockRestore();
  });

  it('printSummary surfaces the resume command for a paused outcome', () => {
    const out: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => {
        out.push(args.map(String).join(' '));
      });
    const emptyStats = {
      startedAt: 0,
      elapsedMs: 0,
      loops: [],
      models: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      agentCalls: 0,
      errors: [],
    };
    printSummary(
      { outcome: { status: 'paused', summary: 'rate limited' }, stats: emptyStats },
      'loops run x --resume ckpt.json',
    );
    log.mockRestore();
    const clean = out.map((s) => s.replace(/\[[0-9;]*m/g, ''));
    expect(clean.some((l) => l.includes('PAUSED'))).toBe(true);
    expect(
      clean.some((l) => l.includes('Resume') && l.includes('--resume ckpt.json')),
    ).toBe(true);
  });
});
