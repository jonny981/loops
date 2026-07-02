/**
 * No-progress (stall) detection — the third hard stop. Offline and
 * deterministic: the tracker is exercised directly, the loop wiring through
 * fnJob bodies with custom signals, and the workspace fingerprint against real
 * temp git repos.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  loop,
  fnJob,
  predicate,
  jobMeta,
  MockEngine,
  ProgressTracker,
  resolveNoProgress,
  workspaceFingerprint,
} from '../src/api.ts';
import type { RunOptions, LoopEvent, Condition } from '../src/api.ts';
import { tmpRepo, tmpBareDir, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

/** Run opts pinned to a non-repo cwd, so the workspace channel is absent. */
const bareOpts = (): RunOptions => ({ ...mockOpts, cwd: tmpBareDir() });

describe('resolveNoProgress', () => {
  it('is undefined when unset', () => {
    expect(resolveNoProgress(undefined)).toBeUndefined();
  });

  it('treats a bare number as the window', () => {
    const cfg = resolveNoProgress(2);
    expect(cfg?.window).toBe(2);
    expect(cfg?.minConfidenceDelta).toBe(0.02);
  });

  it('applies defaults to a partial config', () => {
    const cfg = resolveNoProgress({ minConfidenceDelta: 0.1 });
    expect(cfg?.window).toBe(3);
    expect(cfg?.minConfidenceDelta).toBe(0.1);
  });
});

describe('ProgressTracker (the novelty rule)', () => {
  const tracker = () => new ProgressTracker({ window: 3, minConfidenceDelta: 0.02 });

  it('stalls after `window` consecutive revisits of a seen signal', () => {
    const t = tracker();
    expect(t.record({ iteration: 1, signal: 'a' })).toBeUndefined(); // novel
    expect(t.record({ iteration: 2, signal: 'a' })).toBeUndefined();
    expect(t.record({ iteration: 3, signal: 'a' })).toBeUndefined();
    const report = t.record({ iteration: 4, signal: 'a', reason: 'tests red' });
    expect(report).toBeDefined();
    expect(report?.iterations).toEqual([2, 3, 4]);
    expect(report?.reason).toBe('tests red');
    expect(report?.evidence.join(' ')).toContain('signal');
  });

  it('novelty resets the run — progress at iteration 3 restarts the count', () => {
    const t = tracker();
    t.record({ iteration: 1, signal: 'a' });
    t.record({ iteration: 2, signal: 'a' });
    t.record({ iteration: 3, signal: 'b' }); // novel — reset
    t.record({ iteration: 4, signal: 'b' });
    t.record({ iteration: 5, signal: 'b' });
    const report = t.record({ iteration: 6, signal: 'b' });
    expect(report?.iterations).toEqual([4, 5, 6]);
  });

  it('oscillation gets no credit: A→B→A→B stalls (revisits are not progress)', () => {
    const t = tracker();
    expect(t.record({ iteration: 1, signal: 'A' })).toBeUndefined(); // novel
    expect(t.record({ iteration: 2, signal: 'B' })).toBeUndefined(); // novel
    expect(t.record({ iteration: 3, signal: 'A' })).toBeUndefined(); // seen — 1
    expect(t.record({ iteration: 4, signal: 'B' })).toBeUndefined(); // seen — 2
    expect(t.record({ iteration: 5, signal: 'A' })).toBeDefined(); //   seen — 3
  });

  it('confidence must beat the high-water mark by the delta', () => {
    const t = tracker();
    expect(t.record({ iteration: 1, confidence: 0.5 })).toBeUndefined(); // first — progress
    // Jitter below the delta is not progress…
    expect(t.record({ iteration: 2, confidence: 0.51 })).toBeUndefined();
    expect(t.record({ iteration: 3, confidence: 0.5 })).toBeUndefined();
    // …but slow, steady improvement accumulates past the bar (0.5 → 0.53).
    expect(t.record({ iteration: 4, confidence: 0.53 })).toBeUndefined(); // progress — reset
    expect(t.record({ iteration: 5, confidence: 0.53 })).toBeUndefined();
    expect(t.record({ iteration: 6, confidence: 0.53 })).toBeUndefined();
    const report = t.record({ iteration: 7, confidence: 0.52 });
    expect(report?.iterations).toEqual([5, 6, 7]);
    expect(report?.evidence.join(' ')).toContain('confidence');
  });

  it('any one channel showing novelty counts as progress', () => {
    const t = tracker();
    t.record({ iteration: 1, signal: 'a', confidence: 0.5 });
    // signal flat, but confidence keeps climbing — never stalls
    t.record({ iteration: 2, signal: 'a', confidence: 0.6 });
    t.record({ iteration: 3, signal: 'a', confidence: 0.7 });
    t.record({ iteration: 4, signal: 'a', confidence: 0.8 });
    expect(t.record({ iteration: 5, signal: 'a', confidence: 0.9 })).toBeUndefined();
  });

  it('an evidence-free sample is indeterminate: neither extends nor resets', () => {
    const t = tracker();
    t.record({ iteration: 1, signal: 'a' });
    t.record({ iteration: 2, signal: 'a' }); // flat — 1
    t.record({ iteration: 3 }); //              indeterminate — no effect
    t.record({ iteration: 4, signal: 'a' }); // flat — 2
    expect(t.record({ iteration: 5, signal: 'a' })).toBeDefined(); // flat — 3
    expect(t.isInert()).toBe(false);
  });

  it('reports inert only when every sample lacked evidence', () => {
    const t = tracker();
    t.record({ iteration: 1 });
    t.record({ iteration: 2 });
    expect(t.isInert()).toBe(false); // window not yet filled
    t.record({ iteration: 3 });
    expect(t.isInert()).toBe(true);
  });
});

describe('workspaceFingerprint', () => {
  it('is undefined outside a git repo', async () => {
    expect(await workspaceFingerprint({ cwd: tmpBareDir() })).toBeUndefined();
  });

  it('is stable when nothing changes, and moves on a tracked edit', async () => {
    const repo = await tmpRepo();
    const a = await workspaceFingerprint({ cwd: repo });
    const b = await workspaceFingerprint({ cwd: repo });
    expect(a).toBeDefined();
    expect(b).toBe(a);
    writeFileSync(join(repo, 'README.md'), '# changed\n');
    expect(await workspaceFingerprint({ cwd: repo })).not.toBe(a);
  });

  it('sees untracked file CONTENT, not just the path', async () => {
    const repo = await tmpRepo();
    writeFileSync(join(repo, 'scratch.txt'), 'v1');
    const a = await workspaceFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'scratch.txt'), 'v2'); // same path, new content
    const b = await workspaceFingerprint({ cwd: repo });
    expect(b).not.toBe(a);
  });

  it('a byte-identical revisit fingerprints identically (oscillation is caught)', async () => {
    const repo = await tmpRepo();
    const before = await workspaceFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# detour\n');
    const detour = await workspaceFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test\n'); // back to committed content
    const after = await workspaceFingerprint({ cwd: repo });
    expect(detour).not.toBe(before);
    expect(after).toBe(before);
  });
});

describe('loop({ noProgress })', () => {
  it('is off by default: a flat loop runs all the way to max', async () => {
    const { outcome, stats } = await run(
      loop({
        name: 'flat',
        body: fnJob('b', async () => ({ status: 'fail', summary: 'same' })),
        max: 8,
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.stall).toBeUndefined();
    expect(stats.loops[0]?.iterations).toBe(8);
  });

  it('stalls out early on a flat custom signal, with the evidence attached', async () => {
    const events: LoopEvent[] = [];
    const { outcome, stats } = await run(
      loop({
        name: 'doomed',
        body: fnJob('b', async () => ({ status: 'fail', summary: 'no luck' })),
        max: 20,
        noProgress: { window: 3, signal: () => 'stuck' },
      }),
      { ...bareOpts(), onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.iterations).toEqual([2, 3, 4]);
    expect(stats.loops[0]?.iterations).toBe(4); // 1 novel + window, not 20
    const stall = events.find((e) => e.kind === 'loop:stall');
    expect(stall).toBeDefined();
    if (stall?.kind === 'loop:stall') {
      expect(stall.report.window).toBe(3);
      expect(stall.report.reason).toBeTruthy();
    }
  });

  it('accepts the bare-number sugar', async () => {
    const { stats } = await run(
      loop({
        name: 'sugar',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 20,
        noProgress: 2, // window of 2
      }),
      { ...mockOpts, cwd: await tmpRepo() }, // repo present, nothing ever written
    );
    expect(stats.loops[0]?.iterations).toBe(3); // 1 novel + 2 flat
  });

  it('keeps going while the signal makes progress, stalls when it flattens', async () => {
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'slows',
        body: fnJob('b', async () => {
          n += 1;
          return { status: 'fail', summary: `n=${n}` };
        }),
        max: 20,
        noProgress: { window: 3, signal: () => Math.min(n, 4) },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    // 4 progressing iterations, then 3 flat ones fill the window.
    expect(stats.loops[0]?.iterations).toBe(7);
  });

  it('rising gate confidence above the delta is progress; flat confidence is not', async () => {
    let conf = 0.3;
    const rising: Condition = async () => {
      conf = Math.min(conf + 0.1, 0.6); // climbs, then plateaus at 0.6
      return { met: false, confidence: conf, reason: 'not there yet' };
    };
    const { outcome, stats } = await run(
      loop({
        name: 'judge',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: rising,
        max: 20,
        noProgress: { window: 2 },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.reason).toBe('not there yet');
    // 0.4, 0.5, 0.6 are progress; the two plateau turns fill the window.
    expect(stats.loops[0]?.iterations).toBe(5);
  });

  it('the workspace channel alone catches an agent that stops writing', async () => {
    const repo = await tmpRepo();
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'writer',
        body: fnJob('b', async () => {
          n += 1;
          // Writes for two turns, then goes idle (the classic dead loop).
          if (n <= 2) writeFileSync(join(repo, 'work.txt'), `attempt ${n}`);
          return { status: 'fail', summary: 'tests still red' };
        }),
        max: 20,
        noProgress: { window: 2 },
      }),
      { ...mockOpts, cwd: repo },
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.evidence.join(' ')).toContain('workspace');
    expect(stats.loops[0]?.iterations).toBe(4); // 2 writing + 2 idle
  });

  it('warns once and stays inert when no evidence channel exists', async () => {
    const events: LoopEvent[] = [];
    const { outcome, stats } = await run(
      loop({
        name: 'blind',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 6,
        noProgress: { window: 2, workspace: false }, // no repo, no signal, no confidence
      }),
      { ...bareOpts(), onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('exhausted'); // via max, not the detector
    expect(outcome.stall).toBeUndefined();
    expect(stats.loops[0]?.iterations).toBe(6);
    const warns = events.filter(
      (e) => e.kind === 'log' && e.level === 'warn' && /inert/.test(e.message),
    );
    expect(warns.length).toBe(1);
  });

  it('a converging loop is never cut short', async () => {
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'converges',
        body: fnJob('b', async () => {
          n += 1;
          return { status: n >= 5 ? 'pass' : 'fail' };
        }),
        until: predicate(() => n >= 5, 'done'),
        max: 20,
        noProgress: { window: 3, signal: () => n }, // signal changes every turn
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('pass');
    expect(stats.loops[0]?.iterations).toBe(5);
  });

  it('a throwing signal fn fails the loop loudly (guarded user code)', async () => {
    const { outcome } = await run(
      loop({
        name: 'buggy',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 5,
        noProgress: {
          window: 2,
          signal: () => {
            throw new Error('signal blew up');
          },
        },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('signal blew up');
  });

  it('review-rejection turns feed the detector (a flat standoff stalls)', async () => {
    const { outcome, stats } = await run(
      loop({
        name: 'standoff',
        body: fnJob('b', async () => ({ status: 'pass', summary: 'claimed done' })),
        review: fnJob('r', async () => ({
          status: 'fail',
          summary: 'same blocker',
          confidence: 0.4,
        })),
        max: 20,
        noProgress: { window: 3, signal: () => 'unchanged' },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.reason).toBe('same blocker');
    expect(stats.loops[0]?.iterations).toBe(4);
  });

  it('exposes the window in the loop meta for `loops describe`', () => {
    const j = loop({
      name: 'shaped',
      body: fnJob('b', async () => ({ status: 'pass' })),
      noProgress: 4,
    });
    expect(jobMeta(j)?.noProgress).toBe(4);
  });
});
