import { describe, it, expect } from 'vitest';

import { emptyVM, reduce } from '../src/tui/model.ts';
import type { LoopEvent } from '../src/api.ts';

type NoTs<T> = T extends unknown ? Omit<T, 'ts'> : never;
const at = (e: NoTs<LoopEvent>): LoopEvent => ({ ...e, ts: 0 }) as LoopEvent;
/** Assert presence, narrowing away `undefined` for strict indexed access. */
const req = <T>(x: T | undefined): T => {
  expect(x).toBeDefined();
  return x as T;
};

describe('tui view-model', () => {
  it('surfaces restore diagnostics as a notice', () => {
    const vm = emptyVM();
    reduce(
      vm,
      at({
        kind: 'runtime:restore',
        path: [],
        checkpoint: 'ckpt.json',
        decision: 'restored',
        restoredNodes: 1,
        totalNodes: 1,
        reason: 'restored 1/1 nodes from ckpt.json',
        fingerprint: 'matched',
      }),
    );

    expect(vm.notice).toBe('restored 1/1 nodes from ckpt.json');
  });

  it('builds a loop node and tracks iterations + status', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'loop:start', path: ['poll'], depth: 1, max: 5 }));
    reduce(vm, at({ kind: 'loop:iteration', path: ['poll'], iteration: 2 }));
    reduce(
      vm,
      at({
        kind: 'loop:end',
        path: ['poll'],
        iterations: 2,
        outcome: { status: 'pass' },
      }),
    );
    const node = vm.nodes.get('poll')!;
    expect(node.type).toBe('loop');
    expect(node.iteration).toBe(2);
    expect(node.max).toBe(5);
    expect(node.status).toBe('pass');
  });

  it('tallies review pass/fail', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'loop:start', path: ['l'], depth: 1 }));
    reduce(
      vm,
      at({ kind: 'loop:review', path: ['l'], outcome: { status: 'fail' } }),
    );
    reduce(
      vm,
      at({ kind: 'loop:review', path: ['l'], outcome: { status: 'pass' } }),
    );
    const node = vm.nodes.get('l')!;
    expect(node.reviewFail).toBe(1);
    expect(node.reviewPass).toBe(1);
  });

  it('accumulates usage and caps the stream buffer', () => {
    const vm = emptyVM();
    reduce(
      vm,
      at({
        kind: 'engine:usage',
        path: ['l'],
        model: 'm',
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
    reduce(
      vm,
      at({ kind: 'engine:text', path: ['l'], delta: 'x'.repeat(5000) }),
    );
    expect(vm.calls).toBe(1);
    expect(vm.tokensIn).toBe(10);
    expect(vm.tokensOut).toBe(4);
    expect(vm.stream.length).toBeLessThanOrEqual(1600);
  });

  it('records errors and resets the stream on a new job', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'engine:text', path: ['l'], delta: 'old' }));
    reduce(vm, at({ kind: 'job:start', path: ['l'], label: 'worker' }));
    reduce(
      vm,
      at({ kind: 'error', path: ['l'], code: 'ENGINE', message: 'nope' }),
    );
    expect(vm.activeLabel).toBe('worker');
    expect(vm.stream).toBe('');
    expect(vm.errors).toEqual(['[ENGINE] nope']);
  });

  it('surfaces a human gate and a limit pause as the notice banner', () => {
    const vm = emptyVM();
    expect(vm.notice).toBeUndefined();
    reduce(
      vm,
      at({
        kind: 'human:gate',
        path: ['deploy'],
        name: 'prod-approval',
        prompt: 'sign off on prod',
      }),
    );
    expect(vm.notice).toBe('⏸ human gate "prod-approval": sign off on prod');
    reduce(
      vm,
      at({
        kind: 'limit:pause',
        path: ['deploy'],
        code: 'QUOTA',
        reason: 'usage limit reached',
      }),
    );
    expect(vm.notice).toBe('⏸ paused (QUOTA): usage limit reached');
  });
});

describe('tui view-model — iteration history', () => {
  it('builds a per-iteration record across ≥3 iterations with per-iteration tokens and attribution', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'loop:start', path: ['build'], depth: 1, max: 5 }));

    // iteration 1: body fail, until not met
    reduce(vm, at({ kind: 'loop:iteration', path: ['build'], iteration: 1 }));
    reduce(
      vm,
      at({ kind: 'engine:text', path: ['build'], delta: 'thinking…' }),
    );
    reduce(
      vm,
      at({
        kind: 'engine:usage',
        path: ['build'],
        model: 'm',
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'job:end',
        path: ['build'],
        label: 'worker',
        outcome: { status: 'fail', summary: 'missed' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:condition',
        path: ['build'],
        which: 'until',
        result: { met: false, reason: 'not yet' },
      }),
    );

    // iteration 2: body pass, until met, review FAIL → iteration is fail-flavoured
    reduce(vm, at({ kind: 'loop:iteration', path: ['build'], iteration: 2 }));
    reduce(
      vm,
      at({
        kind: 'engine:usage',
        path: ['build'],
        model: 'm',
        usage: { inputTokens: 200, outputTokens: 40 },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'job:end',
        path: ['build'],
        label: 'worker',
        outcome: { status: 'pass', summary: 'looks done' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:condition',
        path: ['build'],
        which: 'until',
        result: { met: true, reason: 'converged', confidence: 0.8 },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:review',
        path: ['build'],
        outcome: { status: 'fail', summary: 'needs X' },
      }),
    );

    // iteration 3: body pass, until met, review PASS → loop ends pass
    reduce(vm, at({ kind: 'loop:iteration', path: ['build'], iteration: 3 }));
    reduce(
      vm,
      at({
        kind: 'engine:usage',
        path: ['build'],
        model: 'm',
        usage: { inputTokens: 50, outputTokens: 10 },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'job:end',
        path: ['build'],
        label: 'worker',
        outcome: { status: 'pass', summary: 'fixed X' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:condition',
        path: ['build'],
        which: 'until',
        result: { met: true, reason: 'converged' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:review',
        path: ['build'],
        outcome: { status: 'pass', summary: 'ship it' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:end',
        path: ['build'],
        iterations: 3,
        outcome: { status: 'pass' },
      }),
    );

    const node = vm.nodes.get('build')!;
    expect(node.iterations).toHaveLength(3);

    const i1 = req(node.iterations[0]);
    const i2 = req(node.iterations[1]);
    const i3 = req(node.iterations[2]);

    // iteration 1
    expect(i1.iteration).toBe(1);
    expect(i1.bodyStatus).toBe('fail');
    expect(i1.bodySummary).toBe('missed');
    expect(i1.until).toEqual({
      met: false,
      reason: 'not yet',
      confidence: undefined,
    });
    expect(i1.tokensIn).toBe(100);
    expect(i1.tokensOut).toBe(20);
    expect(i1.calls).toBe(1);
    expect(i1.transcript).toBe('thinking…');
    // finalized at the next iteration boundary to its bodyStatus
    expect(i1.status).toBe('fail');
    expect(i1.review).toBeUndefined();

    // iteration 2: review failed → status fail despite body pass
    expect(i2.bodyStatus).toBe('pass');
    expect(i2.until).toEqual({
      met: true,
      reason: 'converged',
      confidence: 0.8,
    });
    expect(i2.review).toEqual({ status: 'fail', summary: 'needs X' });
    expect(i2.status).toBe('fail');
    expect(i2.tokensIn).toBe(200);
    expect(i2.calls).toBe(1);

    // iteration 3: review passed → loop:end sets it pass
    expect(i3.bodyStatus).toBe('pass');
    expect(i3.review).toEqual({ status: 'pass', summary: 'ship it' });
    expect(i3.status).toBe('pass');
    expect(i3.tokensIn).toBe(50);
    expect(i3.endedAt).toBe(0);

    // aggregate fields still work
    expect(node.status).toBe('pass');
    expect(node.iteration).toBe(3);
    expect(node.reviewPass).toBe(1);
    expect(node.reviewFail).toBe(1);
    expect(vm.tokensIn).toBe(350);
    expect(vm.tokensOut).toBe(70);
    expect(vm.calls).toBe(3);
  });

  it('records stopOn on the current iteration and finalizes status on loop:end', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'loop:start', path: ['poll'], depth: 1 }));
    reduce(vm, at({ kind: 'loop:iteration', path: ['poll'], iteration: 1 }));
    reduce(
      vm,
      at({
        kind: 'job:end',
        path: ['poll'],
        label: 'worker',
        outcome: { status: 'fail' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:condition',
        path: ['poll'],
        which: 'stopOn',
        result: { met: true, reason: 'kill switch' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:end',
        path: ['poll'],
        iterations: 1,
        outcome: { status: 'aborted' },
      }),
    );

    const node = vm.nodes.get('poll')!;
    expect(node.iterations).toHaveLength(1);
    const rec = req(node.iterations[0]);
    expect(rec.stopOn).toEqual({ met: true, reason: 'kill switch' });
    expect(rec.status).toBe('aborted');
    expect(rec.endedAt).toBe(0);
  });

  it('keeps nested-loop iterations from colliding with the parent', () => {
    const vm = emptyVM();
    // Parent loop "outer" whose body is a nested loop "inner".
    reduce(vm, at({ kind: 'loop:start', path: ['outer'], depth: 1, max: 3 }));
    reduce(vm, at({ kind: 'loop:iteration', path: ['outer'], iteration: 1 }));

    // Nested loop runs entirely inside outer's iteration 1.
    reduce(
      vm,
      at({ kind: 'loop:start', path: ['outer', 'inner'], depth: 2, max: 4 }),
    );
    reduce(
      vm,
      at({ kind: 'loop:iteration', path: ['outer', 'inner'], iteration: 1 }),
    );
    reduce(
      vm,
      at({
        kind: 'engine:usage',
        path: ['outer', 'inner'],
        model: 'm',
        usage: { inputTokens: 7, outputTokens: 3 },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'job:end',
        path: ['outer', 'inner'],
        label: 'worker',
        outcome: { status: 'fail' },
      }),
    );
    reduce(
      vm,
      at({ kind: 'loop:iteration', path: ['outer', 'inner'], iteration: 2 }),
    );
    reduce(
      vm,
      at({
        kind: 'engine:usage',
        path: ['outer', 'inner'],
        model: 'm',
        usage: { inputTokens: 9, outputTokens: 1 },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'job:end',
        path: ['outer', 'inner'],
        label: 'worker',
        outcome: { status: 'pass' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:end',
        path: ['outer', 'inner'],
        iterations: 2,
        outcome: { status: 'pass' },
      }),
    );

    // Now the outer iteration's own body completes.
    reduce(
      vm,
      at({
        kind: 'engine:usage',
        path: ['outer'],
        model: 'm',
        usage: { inputTokens: 500, outputTokens: 100 },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'job:end',
        path: ['outer'],
        label: 'worker',
        outcome: { status: 'pass', summary: 'outer body' },
      }),
    );
    reduce(
      vm,
      at({
        kind: 'loop:end',
        path: ['outer'],
        iterations: 1,
        outcome: { status: 'pass' },
      }),
    );

    const outer = vm.nodes.get('outer')!;
    const inner = vm.nodes.get('outer / inner')!;

    // Outer has exactly one iteration; inner's events did NOT leak into it.
    expect(outer.iterations).toHaveLength(1);
    expect(inner.iterations).toHaveLength(2);

    // Outer iteration only counts the outer-path usage + body.
    const o1 = req(outer.iterations[0]);
    expect(o1.tokensIn).toBe(500);
    expect(o1.calls).toBe(1);
    expect(o1.bodyStatus).toBe('pass');
    expect(o1.bodySummary).toBe('outer body');

    // Inner iterations track their own tokens/body separately.
    const in1 = req(inner.iterations[0]);
    const in2 = req(inner.iterations[1]);
    expect(in1.tokensIn).toBe(7);
    expect(in1.bodyStatus).toBe('fail');
    expect(in2.tokensIn).toBe(9);
    expect(in2.bodyStatus).toBe('pass');
  });

  it('caps the per-iteration transcript', () => {
    const vm = emptyVM();
    reduce(vm, at({ kind: 'loop:start', path: ['l'], depth: 1 }));
    reduce(vm, at({ kind: 'loop:iteration', path: ['l'], iteration: 1 }));
    reduce(
      vm,
      at({ kind: 'engine:text', path: ['l'], delta: 'y'.repeat(5000) }),
    );
    expect(
      req(vm.nodes.get('l')!.iterations[0]).transcript.length,
    ).toBeLessThanOrEqual(2000);
  });
});
