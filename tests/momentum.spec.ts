import { describe, it, expect } from 'vitest';

import { momentumFromEvents, momentumLine } from '../src/api.ts';
import type { LoopEvent } from '../src/api.ts';

const t0 = 1_700_000_000_000;

const nodePass = (
  ts: number,
  node: string,
  extra?: { cached?: boolean; phase?: 'done' | 'skip' },
): LoopEvent => ({
  kind: 'dag:node',
  ts,
  path: ['d'],
  node,
  phase: extra?.phase ?? 'done',
  outcome: { status: 'pass' },
  cached: extra?.cached,
});

const loopPass = (ts: number): LoopEvent => ({
  kind: 'loop:end',
  ts,
  path: ['l'],
  outcome: { status: 'pass' },
  iterations: 3,
});

const steer = (ts: number, accepted: boolean): LoopEvent => ({
  kind: 'dag:edit',
  ts,
  path: ['d'],
  plan: 'p',
  version: 2,
  op: 'add',
  node: 'x',
  accepted,
});

const stall = (ts: number): LoopEvent => ({
  kind: 'loop:stall',
  ts,
  path: ['l'],
  iteration: 5,
  report: { reason: 'flat', window: 3, iterations: [3, 4, 5], evidence: [] },
});

describe('momentum', () => {
  it('counts only fresh, gated completions — not restores, not skips', () => {
    const report = momentumFromEvents([
      nodePass(t0, 'a'),
      nodePass(t0 + 1, 'b', { cached: true }), // checkpoint restore: not momentum
      nodePass(t0 + 2, 'c', { phase: 'skip' }), // unmet when: green, but no work
      loopPass(t0 + 3),
      steer(t0 + 4, true),
      steer(t0 + 5, false), // refused force is not force
    ]);
    expect(report.crystallized).toBe(2);
    expect(report.steers).toBe(1);
  });

  it('is alive when work crystallized within the window, idle when it went quiet', () => {
    const events = [nodePass(t0, 'a')];
    expect(momentumFromEvents(events, { now: t0 + 60_000 }).state).toBe('alive');
    expect(momentumFromEvents(events, { now: t0 + 3_600_000 }).state).toBe(
      'idle',
    );
  });

  it('is stalled when the noProgress detector tripped after the last crystallization', () => {
    expect(
      momentumFromEvents([nodePass(t0, 'a'), stall(t0 + 1_000)], {
        now: t0 + 2_000,
      }).state,
    ).toBe('stalled');
    // A crystallization after the stall clears it: motion resumed being momentum.
    expect(
      momentumFromEvents(
        [nodePass(t0, 'a'), stall(t0 + 1_000), nodePass(t0 + 2_000, 'b')],
        { now: t0 + 3_000 },
      ).state,
    ).toBe('alive');
  });

  it('is done on any terminal run status', () => {
    for (const status of ['pass', 'fail', 'exhausted', 'aborted', 'paused']) {
      expect(
        momentumFromEvents([nodePass(t0, 'a')], { status, now: t0 }).state,
      ).toBe('done');
    }
    expect(
      momentumFromEvents([nodePass(t0, 'a')], { status: 'running', now: t0 })
        .state,
    ).toBe('alive');
  });

  it('reports the crystallization rate over the observed span', () => {
    const report = momentumFromEvents([
      nodePass(t0, 'a'),
      nodePass(t0 + 30 * 60_000, 'b'), // two units, 30 minutes apart
    ]);
    expect(report.ratePerHour).toBeCloseTo(2, 5);
    // A single unit has no span, so no rate — never a fabricated number.
    expect(momentumFromEvents([nodePass(t0, 'a')]).ratePerHour).toBeUndefined();
  });

  it('renders the one-line supervision read', () => {
    const line = momentumLine(
      momentumFromEvents(
        [nodePass(t0, 'a'), nodePass(t0 + 30 * 60_000, 'b'), steer(t0, true)],
        { now: t0 + 31 * 60_000 },
      ),
    );
    expect(line).toMatch(/^alive — 2 crystallized \(2\.0\/h\), 1 steer$/);
  });
});
