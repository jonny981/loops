import { describe, it, expect } from 'vitest';

import { livePlan, fnJob } from '../src/api.ts';
import type { PlanEdit } from '../src/api.ts';

const job = (name: string) => fnJob(name, async () => ({ status: 'pass' as const }));

let seq = 0;
const plan = (nodes: Parameters<typeof livePlan>[0]['nodes'], extra?: Partial<Parameters<typeof livePlan>[0]>) =>
  livePlan({ name: `plan-spec-${(seq += 1)}`, nodes, ...extra });

describe('livePlan', () => {
  it('starts at version 1 and bumps once per accepted batch', () => {
    const p = plan({ a: job('a') });
    expect(p.version).toBe(1);
    p.apply([
      { op: 'add', name: 'b', node: job('b') },
      { op: 'add', name: 'c', node: { job: job('c'), needs: ['b'] } },
    ]);
    expect(p.version).toBe(2);
    expect([...p.nodes().keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('refuses a cycle introduced by rewire — the live toposort', () => {
    const p = plan({
      a: job('a'),
      b: { job: job('b'), needs: ['a'] },
    });
    expect(() => p.apply([{ op: 'rewire', name: 'a', needs: ['b'] }])).toThrow(
      /cycle/,
    );
    expect(p.version).toBe(1);
    expect(p.nodes().get('a')!.needs).toBeUndefined();
  });

  it('refuses an unknown dependency on add', () => {
    const p = plan({ a: job('a') });
    expect(() =>
      p.apply([{ op: 'add', name: 'b', node: { job: job('b'), needs: ['ghost'] } }]),
    ).toThrow(/unknown node "ghost"/);
  });

  it('refuses a remove that leaves a dangling consumer, unless the batch resolves it', () => {
    const p = plan({
      a: job('a'),
      b: { job: job('b'), needs: ['a'] },
    });
    expect(() => p.apply([{ op: 'remove', name: 'a' }])).toThrow(
      /needs unknown node "a"/,
    );
    // Same remove, with the consumer rewired in the same atomic batch: accepted.
    p.apply([
      { op: 'remove', name: 'a' },
      { op: 'rewire', name: 'b', needs: [] },
    ]);
    expect([...p.nodes().keys()]).toEqual(['b']);
  });

  it('applies batches atomically — one bad edit rolls back the whole batch', () => {
    const p = plan({ a: job('a') });
    expect(() =>
      p.apply([
        { op: 'add', name: 'b', node: job('b') },
        { op: 'remove', name: 'ghost' },
      ]),
    ).toThrow(/unknown node "ghost"/);
    expect(p.version).toBe(1);
    expect(p.nodes().has('b')).toBe(false);
  });

  it('refuses cancelling a producer a live consumer still needs', () => {
    const p = plan({
      a: job('a'),
      b: { job: job('b'), needs: ['a'] },
    });
    expect(() => p.apply([{ op: 'cancel', name: 'a' }])).toThrow(
      /resolve the dependent in the same batch/,
    );
    // Cancelling both in one batch is fine.
    p.apply([
      { op: 'cancel', name: 'a' },
      { op: 'cancel', name: 'b' },
    ]);
    expect([...p.cancelled()].sort()).toEqual(['a', 'b']);
  });

  it('instantiates an add from a registered template (the out-of-process path)', () => {
    const p = plan(
      { a: job('a') },
      {
        templates: {
          fix: (params) =>
            fnJob(`fix-${(params as { n: number }).n}`, async () => ({
              status: 'pass' as const,
            })),
        },
      },
    );
    p.apply([
      {
        op: 'add',
        name: 'fix-7',
        template: 'fix',
        params: { n: 7 },
        needs: ['a'],
        priority: 3,
      },
    ]);
    const node = p.nodes().get('fix-7')!;
    expect(typeof node.job).toBe('function');
    expect(node.needs).toEqual(['a']);
    expect(node.priority).toBe(3);
  });

  it('refuses an add with no node and no template, and an unknown template', () => {
    const p = plan({ a: job('a') });
    expect(() => p.apply([{ op: 'add', name: 'x' } as PlanEdit])).toThrow(
      /needs a "node" .* or a "template"/,
    );
    expect(() =>
      p.apply([{ op: 'add', name: 'x', template: 'ghost' }]),
    ).toThrow(/unknown template "ghost"/);
  });

  it('consults guards and refuses the whole batch on a veto', () => {
    const p = plan({ a: job('a') });
    const detach = p.attachGuard((edits) =>
      edits.some((e) => e.op === 'remove') ? 'the past is immutable' : undefined,
    );
    expect(() => p.apply([{ op: 'remove', name: 'a' }])).toThrow(
      /the past is immutable/,
    );
    detach();
    p.apply([{ op: 'remove', name: 'a' }]);
    expect(p.nodes().size).toBe(0);
  });

  it('notifies subscribers with the post-apply version and the batch', () => {
    const p = plan({ a: job('a') });
    const seen: Array<{ version: number; ops: string[] }> = [];
    const unsubscribe = p.subscribe((change) =>
      seen.push({ version: change.version, ops: change.edits.map((e) => e.op) }),
    );
    p.apply([{ op: 'reprioritise', name: 'a', priority: 9 }]);
    unsubscribe();
    p.apply([{ op: 'remove', name: 'a' }]);
    expect(seen).toEqual([{ version: 2, ops: ['reprioritise'] }]);
    expect(p.nodes().get('a')).toBeUndefined();
  });
});
