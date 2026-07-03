import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, loop, dag, fnJob, predicate, humanGate } from '../src/api.ts';
import {
  listRuns,
  readRunStatus,
  readRunProgress,
  runEventsPath,
} from '../src/api.ts';

// A supervised run registers itself under LOOPS_HOME/runs and writes its live
// state there. The read side (list/status/tail) is just file IO, so the whole
// thing is testable offline by pointing LOOPS_HOME at a temp dir.

describe('out-of-process supervision', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'loops-home-'));
    process.env.LOOPS_HOME = home;
  });

  afterAll(() => {
    delete process.env.LOOPS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('registers a supervised run with its shape, live state, and events', async () => {
    let n = 0;
    const job = loop({
      name: 'sup-test',
      body: fnJob('step', async () => ({
        status: ++n >= 2 ? ('pass' as const) : ('fail' as const),
        summary: `n=${n}`,
      })),
      until: predicate(() => n >= 2, 'two steps'),
      max: 5,
    });

    const result = await run(job, { supervise: true });
    expect(result.runId).toBeDefined();
    const id = result.runId!;

    // status.json reflects the terminal outcome and the loop's shape
    const st = readRunStatus(id);
    expect(st).toBeDefined();
    expect(st!.status).toBe('pass');
    expect(st!.title).toBe('sup-test');
    expect(st!.shape?.kind).toBe('loop');
    expect(st!.live.iteration).toBeGreaterThanOrEqual(2);
    expect(st!.live.lastOutcome?.status).toBe('pass');

    // listRuns sees it
    expect(listRuns().some((r) => r.runId === id)).toBe(true);

    // events were appended
    const events = readFileSync(runEventsPath(id), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string });
    expect(events.some((e) => e.kind === 'loop:iteration')).toBe(true);
    expect(events.some((e) => e.kind === 'loop:end')).toBe(true);
  });

  describe('readRunProgress (the rollup)', () => {
    it('rolls up an exhausted run with a gate-failing blocker and recent events', async () => {
      const job = loop({
        name: 'stuck',
        body: fnJob('step', async () => ({ status: 'pass' as const })),
        until: predicate(() => false, 'tests green'),
        max: 2,
      });
      const result = await run(job, { supervise: true });
      expect(result.outcome.status).toBe('exhausted');

      const p = readRunProgress(result.runId!);
      expect(p).toBeDefined();
      expect(p!.status).toBe('exhausted');
      expect(p!.title).toBe('stuck');
      // live.path carries the loop's own name; '(root)' only before any event.
      expect(p!.stage).toBe('stuck');
      expect(p!.iteration).toBe(2);
      expect(p!.blocker).toEqual({
        kind: 'gate-failing',
        detail: 'tests green: false',
      });
      expect(p!.recent.length).toBeGreaterThan(0);
      expect(p!.recent.some((l) => l.includes('loop'))).toBe(true);
    });

    it('reports a human-gate blocker with the gate name and prompt', async () => {
      const job = loop({
        name: 'gated',
        body: humanGate({ name: 'sign-off', prompt: 'check the deploy' }),
        max: 3,
      });
      const result = await run(job, { supervise: true });
      expect(result.outcome.status).toBe('paused');

      const p = readRunProgress(result.runId!);
      expect(p!.blocker).toEqual({
        kind: 'human-gate',
        detail: 'sign-off: check the deploy',
      });
    });

    it('keeps the human-gate blocker when a parallel sibling passes after the gate', async () => {
      // The gate pauses immediately; the sibling loop passes ~50ms later, so
      // its loop:end(pass) lands in the events file AFTER the human:gate
      // event (a pausing dag still awaits its in-flight nodes). The pass must
      // not read as the gate being resolved — the run is genuinely paused.
      const job = dag({
        name: 'release',
        nodes: {
          gate: humanGate({ name: 'ship-it', prompt: 'approve the release' }),
          build: loop({
            name: 'build',
            body: fnJob('compile', async () => {
              await new Promise((r) => setTimeout(r, 50));
              return { status: 'pass' as const };
            }),
            until: predicate(() => true, 'built'),
            max: 2,
          }),
        },
      });
      const result = await run(job, { supervise: true });
      expect(result.outcome.status).toBe('paused');

      const p = readRunProgress(result.runId!);
      expect(p!.blocker).toEqual({
        kind: 'human-gate',
        detail: 'ship-it: approve the release',
      });
    });

    it('reports no blocker for a passed run that recovered from a mid-run error', async () => {
      // A thrown body is retried (default onError: continue) and emits an
      // `error` event; once the run ends `pass`, that event is history, not
      // a blocker.
      let n = 0;
      const job = loop({
        name: 'recovers',
        body: async () => {
          n += 1;
          if (n === 1) throw new Error('transient blip');
          return { status: 'pass' as const, summary: `n=${n}` };
        },
        until: predicate(() => n >= 2, 'second try'),
        max: 3,
      });
      const result = await run(job, { supervise: true });
      expect(result.outcome.status).toBe('pass');

      const p = readRunProgress(result.runId!);
      expect(p!.status).toBe('pass');
      expect(p!.blocker).toBeUndefined();
    });

    it('returns undefined for an unknown runId', () => {
      expect(readRunProgress('no-such-run-000000')).toBeUndefined();
      // A traversal-shaped id is rejected outright, never joined into a path.
      expect(readRunProgress('../../outside/registry')).toBeUndefined();
    });
  });
});
