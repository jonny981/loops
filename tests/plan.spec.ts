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

  it('refuses an unknown op — never a silent version bump', () => {
    const p = plan({ a: job('a') });
    expect(() =>
      p.apply([{ op: 'explode', name: 'a' } as unknown as PlanEdit]),
    ).toThrow(/unknown edit op "explode"/);
    expect(() => p.apply([null as unknown as PlanEdit])).toThrow(
      /unknown edit op/,
    );
    expect(() =>
      p.apply([{ op: 'remove' } as unknown as PlanEdit]),
    ).toThrow(/non-empty "name"/);
    expect(p.version).toBe(1);
  });

  it('a throwing template refuses the batch with its message', () => {
    const p = plan(
      { a: job('a') },
      {
        templates: {
          boom: () => {
            throw new Error('factory exploded');
          },
        },
      },
    );
    expect(() =>
      p.apply([
        { op: 'add', name: 'ok', node: job('ok') },
        { op: 'add', name: 'bad', template: 'boom' },
      ]),
    ).toThrow(/template "boom" threw .* factory exploded/);
    expect(p.version).toBe(1);
    expect(p.nodes().has('ok')).toBe(false); // atomic: the good edit rolled back too
  });

  it('a throwing guard fails closed — the batch is refused, never waved by', () => {
    const p = plan({ a: job('a') });
    const detach = p.attachGuard(() => {
      throw new Error('guard crashed');
    });
    expect(() => p.apply([{ op: 'remove', name: 'a' }])).toThrow(
      /guard threw: guard crashed/,
    );
    expect(p.nodes().has('a')).toBe(true);
    detach();
  });

  it('refuses a reentrant apply from inside a guard, keeping the plan whole', () => {
    const p = plan({ a: job('a') });
    const detach = p.attachGuard(() => {
      p.apply([{ op: 'reprioritise', name: 'a', priority: 1 }]); // throws
      return undefined;
    });
    expect(() => p.apply([{ op: 'remove', name: 'a' }])).toThrow(
      /reentrant apply/,
    );
    expect(p.version).toBe(1);
    detach();
  });

  it('isolates a throwing subscriber: the apply commits and later listeners still fire', () => {
    const p = plan({ a: job('a') });
    const seen: number[] = [];
    p.subscribe(() => {
      throw new Error('broken subscriber');
    });
    p.subscribe((change) => seen.push(change.version));
    const change = p.apply([{ op: 'reprioritise', name: 'a', priority: 2 }]);
    expect(change.version).toBe(2);
    expect(seen).toEqual([2]);
    expect(p.nodes().get('a')!.priority).toBe(2);
  });

  it('stamps the steer source on the change and hands it to guards', () => {
    const p = plan({ a: job('a') });
    const sources: string[] = [];
    p.attachGuard((_edits, meta) => {
      sources.push(meta.source);
      return undefined;
    });
    const internal = p.apply([{ op: 'reprioritise', name: 'a', priority: 1 }]);
    const external = p.apply(
      [{ op: 'reprioritise', name: 'a', priority: 2 }],
      { source: 'external' },
    );
    expect(internal.source).toBe('internal');
    expect(external.source).toBe('external');
    expect(sources).toEqual(['internal', 'external']);
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
