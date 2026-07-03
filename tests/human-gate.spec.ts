import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { printResumeGuidance } from '../src/cli.tsx';

import {
  run,
  loop,
  dag,
  sequence,
  fnJob,
  kickback,
  humanGate,
  humanGateKey,
  pausedHumanGate,
  defineAgent,
  exitCodeFor,
  LoopError,
  MockEngine,
} from '../src/api.ts';
import type { LoopEvent, Outcome, RunOptions } from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

const passJob = (rec: string[], name: string) =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'pass' as const };
  });

describe('humanGate', () => {
  it('an unacknowledged gate pauses with the surfaced prompt', async () => {
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      humanGate({ name: 'approve', prompt: 'check the docs' }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('paused');
    expect(outcome.summary).toBe('check the docs');
    expect(outcome.data).toEqual({
      humanGate: 'approve',
      prompt: 'check the docs',
    });
    const gateEvent = events.find((e) => e.kind === 'human:gate');
    expect(gateEvent).toMatchObject({
      name: 'approve',
      prompt: 'check the docs',
      path: [],
    });
  });

  it('a state-seeded ack passes the gate, with no human:gate event', async () => {
    const events: LoopEvent[] = [];
    const { outcome } = await run(humanGate({ name: 'approve' }), {
      ...mockOpts,
      state: { 'humanGate:approve': true },
      onEvent: (e) => events.push(e),
    });
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('human gate "approve" acknowledged');
    expect(events.some((e) => e.kind === 'human:gate')).toBe(false);
  });

  it('rejects a gate name outside the slug charset (it rides in a shell hint)', () => {
    expect(() => humanGateKey('x;$(id)')).toThrow(/slug/);
    expect(() => humanGate({ name: 'bad name' })).toThrow(/slug/);
    try {
      humanGateKey('`whoami`');
      expect.unreachable('a backtick name must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).code).toBe('CONFIG');
    }
    expect(humanGateKey('prod-approval.v2:eu')).toBe(
      'humanGate:prod-approval.v2:eu',
    );
  });

  it('humanGateKey derives the state key and rejects a blank name', () => {
    expect(humanGateKey('x')).toBe('humanGate:x');
    expect(() => humanGateKey('')).toThrow(/non-blank/);
    expect(() => humanGateKey('   ')).toThrow(/non-blank/);
    try {
      humanGateKey('');
      expect.unreachable('humanGateKey("") must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).code).toBe('CONFIG');
    }
    // The constructor validates through the same path.
    expect(() => humanGate({ name: '' })).toThrow(/non-blank/);
  });

  it('a custom ack fn decides the gate (both branches)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-human-ack-'));
    const marker = join(dir, 'approved');
    const gate = humanGate({ name: 'g', ack: () => existsSync(marker) });
    const before = await run(gate, mockOpts);
    expect(before.outcome.status).toBe('paused');
    writeFileSync(marker, '');
    const after = await run(gate, mockOpts);
    expect(after.outcome.status).toBe('pass');
  });

  it('a throwing ack fn fails the gate, not the run', async () => {
    const { outcome } = await run(
      humanGate({
        name: 'g',
        ack: () => {
          throw new Error('ack exploded');
        },
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('ack exploded');
  });

  it('a paused outcome maps to exit code 75', async () => {
    const { outcome } = await run(humanGate({ name: 'approve' }), mockOpts);
    expect(outcome.status).toBe('paused');
    expect(exitCodeFor(outcome)).toBe(75);
  });
});

describe('paused propagation: loop', () => {
  it('a paused body finishes the loop immediately (no re-iteration)', async () => {
    const events: LoopEvent[] = [];
    const { outcome, stats } = await run(
      loop({ name: 'l', body: humanGate({ name: 'approve' }), max: 5 }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('paused');
    expect(stats.loops[0]?.iterations).toBe(1);
    const end = events.find((e) => e.kind === 'loop:end');
    expect(end).toMatchObject({ outcome: { status: 'paused' } });
  });

  it('an acked gate lets the loop converge normally', async () => {
    const { outcome } = await run(
      loop({ name: 'l', body: humanGate({ name: 'approve' }), max: 5 }),
      { ...mockOpts, state: { [humanGateKey('approve')]: true } },
    );
    expect(outcome.status).toBe('pass');
  });
});

describe('paused propagation: dag', () => {
  it('a paused node stops scheduling, blocks dependents, and pauses the dag', async () => {
    const ran: string[] = [];
    let releaseFence!: () => void;
    const fenceReleased = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const { outcome } = await run(
      dag({
        name: 'd',
        nodes: {
          a: passJob(ran, 'a'),
          gate: { job: humanGate({ name: 'approve' }), needs: ['a'] },
          b: { job: passJob(ran, 'b'), needs: ['gate'] },
          // `fence` resolves only after the gate's outcome is recorded (its
          // dag:node done event fires inside record(), which sets `stopped`
          // in the same synchronous frame), so `unrelated` reaches its start
          // check strictly after the stop — deterministic, not timing-based.
          fence: fnJob('fence', async () => {
            await fenceReleased;
            return { status: 'pass' };
          }),
          unrelated: { job: passJob(ran, 'unrelated'), needs: ['fence'] },
        },
      }),
      {
        ...mockOpts,
        onEvent: (e) => {
          if (e.kind === 'dag:node' && e.node === 'gate' && e.phase === 'done')
            releaseFence();
        },
      },
    );
    expect(outcome.status).toBe('paused');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.b).toMatchObject({ status: 'aborted' });
    expect(ran).toContain('a');
    expect(ran).not.toContain('b');
    expect(ran).not.toContain('unrelated');
  });

  it('pauses even with stopOnError: false (a deliberate halt, not a failure)', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'd',
        stopOnError: false,
        nodes: {
          gate: humanGate({ name: 'approve' }),
          other: passJob(ran, 'other'),
        },
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('paused');
  });

  it('paused takes precedence over a coexisting failure', async () => {
    const { outcome } = await run(
      dag({
        name: 'd',
        stopOnError: false,
        nodes: {
          broken: fnJob('broken', async () => ({
            status: 'fail' as const,
            summary: 'nope',
          })),
          gate: humanGate({ name: 'approve', prompt: 'sign off' }),
        },
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('paused');
    expect(outcome.summary).toBe('sign off');
  });

  it('a paused OPTIONAL node still pauses the dag', async () => {
    const { outcome } = await run(
      dag({
        name: 'd',
        nodes: {
          gate: { job: humanGate({ name: 'approve' }), optional: true },
        },
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('paused');
  });

  it('a signal abort outranks a coexisting pause', async () => {
    const ac = new AbortController();
    const { outcome } = await run(
      dag({ name: 'd', nodes: { gate: humanGate({ name: 'approve' }) } }),
      {
        ...mockOpts,
        signal: ac.signal,
        onEvent: (e) => {
          if (e.kind === 'human:gate') ac.abort();
        },
      },
    );
    expect(outcome.status).toBe('aborted');
    expect(exitCodeFor(outcome)).toBe(130);
  });

  it('a pause outranks a pending kickback: nothing runs past the gate', async () => {
    const ran: string[] = [];
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      dag({
        name: 'd',
        maxKickbacks: 1,
        nodes: {
          base: passJob(ran, 'base'),
          // Optional, so its fail-with-revision neither stops the dag nor
          // blocks the gate — the kickback sits pending while the gate pauses.
          worker: {
            job: fnJob('worker', async () => kickback('base', 'redo it')),
            needs: ['base'],
            optional: true,
          },
          gate: { job: humanGate({ name: 'approve' }), needs: ['worker'] },
        },
      }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('paused');
    // The kickback was never accepted: no node re-ran past the deliberate
    // halt, and the gate fired its human:gate event exactly once.
    expect(ran).toEqual(['base']);
    expect(events.filter((e) => e.kind === 'human:gate')).toHaveLength(1);
    expect(events.some((e) => e.kind === 'dag:kickback' && e.accepted)).toBe(
      false,
    );
  });
});

describe('pausedHumanGate (the outcome-data contract reader)', () => {
  it('reads the gate name from a bare gate outcome', async () => {
    const { outcome } = await run(humanGate({ name: 'approve' }), mockOpts);
    expect(pausedHumanGate(outcome)).toBe('approve');
  });

  it('recovers the gate name through a sequence-rooted pause', async () => {
    const { outcome } = await run(
      sequence(
        'deploy',
        fnJob('work', async () => ({ status: 'pass' as const })),
        humanGate({ name: 'prod-approval' }),
      ),
      mockOpts,
    );
    expect(outcome.status).toBe('paused');
    expect(pausedHumanGate(outcome)).toBe('prod-approval');
  });

  it('recovers the gate name through nested composition (loop in dag)', async () => {
    const { outcome } = await run(
      dag({
        name: 'outer',
        nodes: {
          work: loop({
            name: 'inner',
            body: humanGate({ name: 'approve' }),
            max: 5,
          }),
        },
      }),
      mockOpts,
    );
    expect(pausedHumanGate(outcome)).toBe('approve');
  });

  it('returns undefined for a non-gate pause and a non-paused outcome', () => {
    expect(
      pausedHumanGate({ status: 'paused', summary: 'rate limit hit' }),
    ).toBeUndefined();
    expect(pausedHumanGate({ status: 'pass' })).toBeUndefined();
  });
});

describe('the printed resume hint', () => {
  it('appends --ack <name> for a gate paused inside a dag', async () => {
    const { outcome } = await run(
      dag({ name: 'd', nodes: { gate: humanGate({ name: 'approve' }) } }),
      mockOpts,
    );
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      printResumeGuidance(
        'deploy.loop.ts',
        { checkpoint: 'ckpt.json' },
        outcome,
      );
    } finally {
      write.mockRestore();
    }
    const text = chunks.join('');
    // The dag replaced the gate's `data` with its node-results map, so the
    // hint only carries the name if the CLI followed the contract down.
    expect(text).toContain('--ack approve');
    expect(text).toContain('--resume ckpt.json');
  });
});

describe('paused propagation: nesting', () => {
  it('a paused dag body finishes the enclosing loop paused', async () => {
    const { outcome, stats } = await run(
      loop({
        name: 'outer',
        body: dag({
          name: 'inner',
          nodes: { gate: humanGate({ name: 'approve' }) },
        }),
        max: 5,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('paused');
    expect(stats.loops[0]?.iterations).toBe(1);
  });

  it('a paused loop node pauses the enclosing dag', async () => {
    const { outcome } = await run(
      dag({
        name: 'outer',
        nodes: {
          work: loop({
            name: 'inner',
            body: humanGate({ name: 'approve' }),
            max: 5,
          }),
        },
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('paused');
  });
});

describe('resume round-trip', () => {
  it('pause writes a checkpoint; an acked resume re-executes from the top', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-human-gate-'));
    const checkpoint = join(dir, 'ckpt.json');
    const counters: number[] = [];
    const build = () =>
      sequence(
        'deploy',
        fnJob('work', async (ctx) => {
          const next = ((ctx.state.counter as number | undefined) ?? 0) + 1;
          ctx.state.counter = next;
          counters.push(next);
          return { status: 'pass' };
        }),
        humanGate({ name: 'approve' }),
      );

    const first = await run(build(), { ...mockOpts, checkpoint });
    expect(first.outcome.status).toBe('paused');
    expect(existsSync(checkpoint)).toBe(true);
    const snapshot = JSON.parse(readFileSync(checkpoint, 'utf8')) as {
      ts: number;
      state: Record<string, unknown>;
    };
    expect(snapshot.state.counter).toBe(1);

    const second = await run(build(), {
      ...mockOpts,
      resumeFrom: checkpoint,
      state: { [humanGateKey('approve')]: true },
    });
    expect(second.outcome.status).toBe('pass');
    // Resume re-executes the whole job from the top ("the workspace is the
    // state"): the pre-gate step ran again against the restored state.
    expect(counters).toEqual([1, 2]);
  });
});

describe('AgentDef wiring', () => {
  it('an AgentHumanGate constructs directly into a humanGate node', async () => {
    const def = defineAgent({
      name: 'deployer',
      system: 'You deploy.',
      humanGates: [{ name: 'prod-approval', description: 'deploying prod' }],
    });
    const { outcome } = await run(humanGate(def.humanGates![0]!), mockOpts);
    expect(outcome.status).toBe('paused');
    // The prompt defaults to the gate's description.
    expect(outcome.summary).toBe('deploying prod');
    expect(outcome.data).toMatchObject({ humanGate: 'prod-approval' });
  });
});
