import { describe, it, expect } from 'vitest';

import { run, dag, loop, fnJob, livePlan, MockEngine } from '../src/api.ts';
import type { Job, LoopEvent, Outcome, RunOptions } from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

let seq = 0;
const planName = () => `live-dag-spec-${(seq += 1)}`;

const pass = (rec: string[], name: string): Job =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'pass' as const };
  });

describe('live dag (a steered plan)', () => {
  it('runs nodes steered in mid-run, honouring priority admission order', async () => {
    const order: string[] = [];
    const plan = livePlan({
      name: planName(),
      nodes: {
        seed: fnJob('seed', async () => {
          order.push('seed');
          plan.apply([
            { op: 'add', name: 'low', node: pass(order, 'low') },
            {
              op: 'add',
              name: 'high',
              node: { job: pass(order, 'high'), priority: 5 },
            },
          ]);
          return { status: 'pass' as const };
        }),
      },
    });
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      dag({ name: 'steered', plan, concurrency: 1 }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('pass');
    expect(order).toEqual(['seed', 'high', 'low']);
    const edits = events.filter((e) => e.kind === 'dag:edit');
    expect(edits.map((e) => e.kind === 'dag:edit' && e.node)).toEqual([
      'low',
      'high',
    ]);
    expect(edits.every((e) => e.kind === 'dag:edit' && e.accepted)).toBe(true);
  });

  it('cancel preempts a running node via its per-node signal without failing the dag', async () => {
    const plan = livePlan({
      name: planName(),
      nodes: {
        worker: fnJob('worker', async (ctx) => {
          // An interruptible unit: honours its own signal, as an engine would.
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) return resolve();
            ctx.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return { status: 'aborted' as const, summary: 'interrupted' };
        }),
        incident: fnJob('incident', async () => {
          plan.apply([{ op: 'cancel', name: 'worker' }]);
          return { status: 'pass' as const };
        }),
      },
    });
    const { outcome } = await run(
      dag({ name: 'preempt', plan, concurrency: 2 }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass'); // a deliberate cancel is not a failure
    const data = outcome.data as Record<string, Outcome>;
    expect(data.worker!.status).toBe('aborted');
    expect(data.worker!.summary).toBe('cancelled by steer');
  });

  it('refuses edits that touch crystallized work — the past is immutable', async () => {
    let veto = '';
    const plan = livePlan({
      name: planName(),
      nodes: {
        done: fnJob('done', async () => ({ status: 'pass' as const })),
        later: {
          needs: ['done'],
          job: fnJob('later', async () => {
            try {
              plan.apply([
                { op: 'remove', name: 'done' },
                { op: 'rewire', name: 'later', needs: [] },
              ]);
            } catch (e) {
              veto = e instanceof Error ? e.message : String(e);
            }
            return { status: 'pass' as const };
          }),
        },
      },
    });
    const { outcome } = await run(dag({ name: 'past', plan }), mockOpts);
    expect(outcome.status).toBe('pass');
    expect(veto).toMatch(/already crystallized/);
  });

  it('remove + rewire in one batch re-runs the invalidated subgraph against the new plan', async () => {
    const ran: string[] = [];
    const plan = livePlan({
      name: planName(),
      nodes: {
        bad: fnJob('bad', async () => {
          ran.push('bad');
          return { status: 'fail' as const, summary: 'doomed' };
        }),
        blocked: {
          needs: ['bad'],
          job: fnJob('blocked', async () => {
            ran.push('blocked');
            return { status: 'pass' as const };
          }),
        },
        fixer: fnJob('fixer', async () => {
          plan.apply([
            { op: 'remove', name: 'bad' },
            { op: 'rewire', name: 'blocked', needs: [] },
          ]);
          return { status: 'pass' as const };
        }),
      },
    });
    const { outcome } = await run(
      dag({ name: 'rewired', plan, stopOnError: false }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(ran).toEqual(['bad', 'blocked']);
    const data = outcome.data as Record<string, Outcome>;
    expect(data.blocked!.status).toBe('pass');
    expect('bad' in data).toBe(false); // removed from the plan, gone from the graph
  });

  it('a graceful cancel winds a loop node down at its iteration boundary, not mid-turn', async () => {
    let iterations = 0;
    let sawHardAbort = false;
    const plan = livePlan({
      name: planName(),
      nodes: {
        worker: loop({
          name: 'worker-loop',
          max: 50,
          body: fnJob('turn', async (ctx) => {
            iterations += 1;
            await new Promise((r) => setTimeout(r, 30));
            if (ctx.signal.aborted) sawHardAbort = true;
            return { status: 'fail' as const, summary: 'more to do' };
          }),
        }),
        incident: fnJob('incident', async () => {
          // Cancel only once a turn is genuinely in flight, so the assertion
          // "the current turn completes untouched" is actually exercised.
          while (iterations === 0) await new Promise((r) => setTimeout(r, 5));
          plan.apply([{ op: 'cancel', name: 'worker', graceMs: 60_000 }]);
          return { status: 'pass' as const };
        }),
      },
    });
    const { outcome } = await run(
      dag({ name: 'wind-down', plan, concurrency: 2 }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.worker!.status).toBe('aborted');
    expect(data.worker!.summary).toBe('cancelled by steer');
    // The loop yielded at its boundary well before max, and the hard abort
    // (60s away) never fired: the turn in flight completed untouched.
    expect(iterations).toBeGreaterThanOrEqual(1);
    expect(iterations).toBeLessThan(50);
    expect(sawHardAbort).toBe(false);
  });

  it('bounds in-graph steering with maxSteers while external force stays exempt', async () => {
    let refusal = '';
    const noop = (name: string): Job =>
      fnJob(name, async () => ({ status: 'pass' as const }));
    const plan = livePlan({
      name: planName(),
      nodes: {
        steerer: fnJob('steerer', async () => {
          plan.apply([{ op: 'add', name: 'in-1', node: noop('in-1') }]);
          plan.apply([{ op: 'add', name: 'in-2', node: noop('in-2') }]);
          try {
            plan.apply([{ op: 'add', name: 'in-3', node: noop('in-3') }]);
          } catch (e) {
            refusal = e instanceof Error ? e.message : String(e);
          }
          // The operator is not budgeted: external source still lands.
          plan.apply([{ op: 'add', name: 'ext-1', node: noop('ext-1') }], {
            source: 'external',
          });
          return { status: 'pass' as const };
        }),
      },
    });
    const { outcome } = await run(
      dag({ name: 'budgeted', plan, maxSteers: 2 }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(refusal).toMatch(/in-graph steer budget \(2\) exhausted/);
    const data = outcome.data as Record<string, Outcome>;
    expect(data['in-1']!.status).toBe('pass');
    expect(data['in-2']!.status).toBe('pass');
    expect('in-3' in data).toBe(false);
    expect(data['ext-1']!.status).toBe('pass');
  });

  it('a live dag with no steers behaves exactly like a static one and terminates', async () => {
    const ran: string[] = [];
    const plan = livePlan({
      name: planName(),
      nodes: {
        a: pass(ran, 'a'),
        b: { needs: ['a'], job: pass(ran, 'b') },
      },
    });
    const { outcome } = await run(dag({ name: 'quiet', plan }), mockOpts);
    expect(outcome.status).toBe('pass');
    expect(ran).toEqual(['a', 'b']);
  });

  it('rejects a dag config with both nodes and a plan, or neither', () => {
    const plan = livePlan({ name: planName(), nodes: {} });
    expect(() =>
      dag({ name: 'both', plan, nodes: { a: pass([], 'a') } }),
    ).toThrow(/exactly one of "nodes" .* or "plan"/);
    expect(() => dag({ name: 'neither' })).toThrow(/requires "nodes" or a live "plan"/);
  });
});
