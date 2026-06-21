import { describe, it, expect } from 'vitest';

import { emptyVM, reduce } from '../src/tui/model.ts';
import type { LoopEvent } from '../src/api.ts';

type NoTs<T> = T extends unknown ? Omit<T, 'ts'> : never;
const at = (e: NoTs<LoopEvent>): LoopEvent => ({ ...e, ts: 0 } as LoopEvent);

describe('tui view-model', () => {
  it('builds a loop node and tracks iterations + status', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'loop:start', path: ['poll'], depth: 1, max: 5 }));
    reduce(vm, at({ kind: 'loop:iteration', path: ['poll'], iteration: 2 }));
    reduce(vm, at({ kind: 'loop:end', path: ['poll'], iterations: 2, outcome: { status: 'pass' } }));
    const node = vm.nodes.get('poll')!;
    expect(node.type).toBe('loop');
    expect(node.iteration).toBe(2);
    expect(node.max).toBe(5);
    expect(node.status).toBe('pass');
  });

  it('tallies review pass/fail', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'loop:start', path: ['l'], depth: 1 }));
    reduce(vm, at({ kind: 'loop:review', path: ['l'], outcome: { status: 'fail' } }));
    reduce(vm, at({ kind: 'loop:review', path: ['l'], outcome: { status: 'pass' } }));
    const node = vm.nodes.get('l')!;
    expect(node.reviewFail).toBe(1);
    expect(node.reviewPass).toBe(1);
  });

  it('accumulates usage and caps the stream buffer', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'engine:usage', path: ['l'], model: 'm', usage: { inputTokens: 10, outputTokens: 4 } }));
    reduce(vm, at({ kind: 'engine:text', path: ['l'], delta: 'x'.repeat(5000) }));
    expect(vm.calls).toBe(1);
    expect(vm.tokensIn).toBe(10);
    expect(vm.tokensOut).toBe(4);
    expect(vm.stream.length).toBeLessThanOrEqual(1600);
  });

  it('records errors and resets the stream on a new job', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'engine:text', path: ['l'], delta: 'old' }));
    reduce(vm, at({ kind: 'job:start', path: ['l'], label: 'worker' }));
    reduce(vm, at({ kind: 'error', path: ['l'], code: 'ENGINE', message: 'nope' }));
    expect(vm.activeLabel).toBe('worker');
    expect(vm.stream).toBe('');
    expect(vm.errors).toEqual(['[ENGINE] nope']);
  });
});
