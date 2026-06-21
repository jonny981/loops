import { describe, it, expect, vi } from 'vitest';

import { plainReporter, jsonReporter, printSummary } from '../src/reporters.ts';
import type { LoopEvent } from '../src/api.ts';

const sample: LoopEvent[] = [
  { kind: 'loop:start', ts: 0, path: ['l'], depth: 1, max: 3 },
  { kind: 'loop:iteration', ts: 0, path: ['l'], iteration: 1 },
  { kind: 'job:start', ts: 0, path: ['l'], label: 'worker' },
  { kind: 'engine:text', ts: 0, path: ['l'], delta: 'streamed ' },
  { kind: 'engine:tool', ts: 0, path: ['l'], name: 'Bash', phase: 'use' },
  { kind: 'loop:condition', ts: 0, path: ['l'], which: 'until', result: { met: true, reason: 'done' } },
  { kind: 'loop:review', ts: 0, path: ['l'], outcome: { status: 'fail', summary: 'nope' } },
  { kind: 'dag:start', ts: 0, path: ['d'], depth: 1, nodes: ['a', 'b'] },
  { kind: 'dag:node', ts: 0, path: ['d'], node: 'a', phase: 'done', outcome: { status: 'pass' } },
  { kind: 'dag:end', ts: 0, path: ['d'], outcome: { status: 'pass' } },
  { kind: 'error', ts: 0, path: ['l'], code: 'ENGINE', message: 'bad' },
  { kind: 'loop:end', ts: 0, path: ['l'], iterations: 1, outcome: { status: 'pass' } },
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
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const report = jsonReporter();
    sample.forEach(report);
    write.mockRestore();
    expect(lines).toHaveLength(sample.length);
    expect(JSON.parse(lines[0]!).kind).toBe('loop:start');
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
  });

  it('printSummary renders without throwing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() =>
      printSummary({
        outcome: { status: 'pass', confidence: 0.9, summary: 'ok' },
        stats: {
          startedAt: 0,
          elapsedMs: 1234,
          loops: [{ path: 'l', iterations: 2, reviewsPassed: 1, reviewsFailed: 1, lastStatus: 'pass' }],
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
});
