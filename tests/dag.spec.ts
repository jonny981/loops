import { afterAll, describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  run,
  loop,
  dag,
  sequence,
  parallel,
  fnJob,
  predicate,
  commandSucceeds,
  gateJob,
} from '../src/api.ts';
import type { LoopEvent, Outcome, RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/api.ts';
import { cleanupRepos, tmpRepo } from './git-helpers.ts';

afterAll(cleanupRepos);

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};
const pass = (rec: string[], name: string) =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'pass' as const };
  });
const fail = (rec: string[], name: string) =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'fail' as const };
  });

describe('dag', () => {
  it('sequence runs in order and stops at the first failure', async () => {
    const order: string[] = [];
    const { outcome } = await run(
      sequence('seq', pass(order, 'a'), pass(order, 'b'), pass(order, 'c')),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('parallel runs every node regardless of failures', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      parallel('par', { a: fail(ran, 'a'), b: pass(ran, 'b') }),
      mockOpts,
    );
    expect(ran.sort()).toEqual(['a', 'b']);
    expect(outcome.status).toBe('fail');
  });

  it('marks the dag late when a child outcome is late', async () => {
    const { outcome } = await run(
      dag({
        name: 'late-dag',
        nodes: {
          a: fnJob('a', async () => ({ status: 'pass', late: true })),
          b: { needs: ['a'], job: fnJob('b', async () => ({ status: 'pass' })) },
        },
      }),
      mockOpts,
    );

    expect(outcome.status).toBe('pass');
    expect(outcome.late).toBe(true);
  });

  it('blocks dependents of a failed required node', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'd',
        nodes: { a: fail(ran, 'a'), b: { job: pass(ran, 'b'), needs: ['a'] } },
      }),
      mockOpts,
    );
    expect(ran).toEqual(['a']);
    expect(outcome.status).toBe('fail');
  });

  it('detects cycles before running', () => {
    expect(() =>
      dag({
        name: 'c',
        nodes: {
          a: {
            job: fnJob('a', async () => ({ status: 'pass' })),
            needs: ['b'],
          },
          b: {
            job: fnJob('b', async () => ({ status: 'pass' })),
            needs: ['a'],
          },
        },
      }),
    ).toThrow(/cycle/);
  });

  it('an optional leaf failure does not fail the DAG', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'o',
        nodes: {
          a: pass(ran, 'a'),
          notify: { job: fail(ran, 'notify'), optional: true },
        },
      }),
      mockOpts,
    );
    expect(ran.sort()).toEqual(['a', 'notify']);
    expect(outcome.status).toBe('pass'); // optional failure ignored
  });

  it('a failed optional producer does not block a required dependent', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'o',
        nodes: {
          a: { job: fail(ran, 'a'), optional: true },
          b: { job: pass(ran, 'b'), needs: ['a'] },
        },
      }),
      mockOpts,
    );
    // An optional producer is best-effort: its failure neither fails the DAG
    // nor blocks consumers — b runs and its real outcome (not a synthetic
    // abort) is what the dag carries.
    expect(ran).toEqual(['a', 'b']);
    expect(outcome.status).toBe('pass');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.b).toMatchObject({ status: 'pass' });
  });

  it("a dependent of a failed optional producer still fails on its own merit", async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'o',
        nodes: {
          a: { job: fail(ran, 'a'), optional: true },
          b: { job: fail(ran, 'b'), needs: ['a'] },
        },
      }),
      mockOpts,
    );
    expect(ran).toEqual(['a', 'b']); // b ran (not blocked) and failed itself
    expect(outcome.status).toBe('fail');
  });

  it('a failed optional producer does not stop scheduling under stopOnError', async () => {
    const ran: string[] = [];
    const slow = fnJob('slow', async () => {
      await new Promise((r) => setTimeout(r, 30));
      ran.push('slow');
      return { status: 'pass' as const };
    });
    const { outcome } = await run(
      dag({
        name: 's',
        nodes: {
          opt: { job: fail(ran, 'opt'), optional: true },
          dep: { job: pass(ran, 'dep'), needs: ['opt'] },
          slow,
          late: { job: pass(ran, 'late'), needs: ['slow'] },
        },
      }),
      mockOpts,
    );
    // dep is not blocked (and records a pass), so stopOnError never trips —
    // the unrelated slow→late chain must still be scheduled to completion.
    expect(ran.sort()).toEqual(['dep', 'late', 'opt', 'slow']);
    expect(outcome.status).toBe('pass');
  });

  it('a failed required producer blocks a consumer that also has a failed optional producer', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'm',
        nodes: {
          req: fail(ran, 'req'),
          opt: { job: fail(ran, 'opt'), optional: true },
          c: { job: pass(ran, 'c'), needs: ['req', 'opt'] },
        },
        stopOnError: false,
      }),
      mockOpts,
    );
    // Mixed needs: the optional producer's failure is forgiven, but the
    // required producer's is not — one hard dependency is enough to block.
    expect(ran.sort()).toEqual(['opt', 'req']);
    expect(outcome.status).toBe('fail');
    const data = outcome.data as Record<string, Outcome>;
    expect(data.c).toMatchObject({
      status: 'aborted',
      summary: 'blocked by a failed dependency',
    });
  });

  it('an aborted optional producer (blocked upstream) does not block its consumer', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 't',
        nodes: {
          a: fail(ran, 'a'),
          b: { job: pass(ran, 'b'), needs: ['a'], optional: true },
          c: { job: pass(ran, 'c'), needs: ['b'] },
        },
        stopOnError: false,
      }),
      mockOpts,
    );
    // a (required) fails → b is blocked-aborted; b is optional, so its abort
    // neither blocks c nor counts against the dag — but a's own failure does.
    expect(ran.sort()).toEqual(['a', 'c']);
    const data = outcome.data as Record<string, Outcome>;
    expect(data.b).toMatchObject({ status: 'aborted' });
    expect(data.c).toMatchObject({ status: 'pass' });
    expect(outcome.status).toBe('fail');
  });

  it('skips a node whose `when` gate is unmet', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'w',
        nodes: {
          a: pass(ran, 'a'),
          b: { job: pass(ran, 'b'), needs: ['a'], when: () => false },
        },
      }),
      mockOpts,
    );
    expect(ran).toEqual(['a']);
    expect(outcome.status).toBe('pass');
  });

  it('respects a concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const make = (name: string) =>
      fnJob(name, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { status: 'pass' } as Outcome;
      });
    await run(
      parallel(
        'p',
        { a: make('a'), b: make('b'), c: make('c'), d: make('d') },
        2,
      ),
      mockOpts,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('does not apply node agent timeouts as command gate timeouts', async () => {
    const { outcome } = await run(
      dag({
        name: 'command-timeout',
        nodes: {
          test: {
            timeoutMs: 1,
            job: gateJob(
              'slow-command',
              commandSucceeds(process.execPath, [
                '-e',
                'setTimeout(() => process.exit(0), 20)',
              ]),
            ),
          },
        },
      }),
      mockOpts,
    );

    expect(outcome.status).toBe('pass');
  });

  it('caps default fan-out at four nodes', async () => {
    let active = 0;
    let peak = 0;
    const make = (name: string) =>
      fnJob(name, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return { status: 'pass' } as Outcome;
      });
    await run(
      parallel('p', {
        a: make('a'),
        b: make('b'),
        c: make('c'),
        d: make('d'),
        e: make('e'),
        f: make('f'),
      }),
      mockOpts,
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('resume skips checkpointed green upstream nodes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-dag-resume-'));
    const checkpoint = join(dir, 'ckpt.json');
    let upstreamRuns = 0;
    let gateRuns = 0;

    const build = () =>
      dag({
        name: 'resume-dag',
        nodes: {
          upstream: fnJob('upstream', async () => {
            upstreamRuns += 1;
            return { status: 'pass' as const, summary: 'durable work done' };
          }),
          gate: {
            needs: ['upstream'],
            job: fnJob('gate', async (ctx) => {
              gateRuns += 1;
              return ctx.state.resume
                ? { status: 'pass' as const, summary: 'resumed' }
                : { status: 'paused' as const, summary: 'pause after upstream' };
            }),
          },
        },
      });

    const first = await run(build(), { ...mockOpts, checkpoint });
    expect(first.outcome.status).toBe('paused');
    expect(upstreamRuns).toBe(1);
    expect(gateRuns).toBe(1);

    const second = await run(build(), {
      ...mockOpts,
      checkpoint,
      resumeFrom: checkpoint,
      state: { resume: true },
    });
    expect(second.outcome.status).toBe('pass');
    expect(upstreamRuns).toBe(1);
    expect(gateRuns).toBe(2);
  });

  it('does not reuse checkpointed DAG nodes across same-process loop iterations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-dag-loop-cache-'));
    const checkpoint = join(dir, 'ckpt.json');
    let runs = 0;

    const { outcome } = await run(
      loop({
        name: 'outer',
        body: dag({
          name: 'body',
          nodes: {
            step: fnJob('step', async () => {
              runs += 1;
              return { status: 'pass' as const };
            }),
          },
        }),
        until: predicate(() => false, 'not done'),
        max: 2,
      }),
      { ...mockOpts, checkpoint },
    );

    expect(outcome.status).toBe('exhausted');
    expect(runs).toBe(2);
  });

  it('re-evaluates skipped when nodes on resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-dag-skip-resume-'));
    const checkpoint = join(dir, 'ckpt.json');
    let deployRuns = 0;

    const build = () =>
      dag({
        name: 'skip-resume',
        nodes: {
          deploy: {
            when: predicate((ctx) => ctx.state.deploy === true, 'deploy enabled'),
            job: fnJob('deploy', async () => {
              deployRuns += 1;
              return { status: 'pass' as const };
            }),
          },
          gate: fnJob('gate', async (ctx) =>
            ctx.state.resume
              ? { status: 'pass' as const }
              : { status: 'paused' as const, summary: 'pause after skip' },
          ),
        },
      });

    const first = await run(build(), { ...mockOpts, checkpoint });
    expect(first.outcome.status).toBe('paused');
    expect(deployRuns).toBe(0);

    const second = await run(build(), {
      ...mockOpts,
      checkpoint,
      resumeFrom: checkpoint,
      state: { deploy: true, resume: true },
    });
    expect(second.outcome.status).toBe('pass');
    expect(deployRuns).toBe(1);
  });

  it('does not skip checkpointed nodes when the workspace fingerprint changed', async () => {
    const repo = await tmpRepo();
    const dir = mkdtempSync(join(tmpdir(), 'loops-dag-fingerprint-'));
    const checkpoint = join(dir, 'ckpt.json');
    let upstreamRuns = 0;

    const build = () =>
      dag({
        name: 'fingerprint-resume',
        nodes: {
          upstream: fnJob('upstream', async () => {
            upstreamRuns += 1;
            writeFileSync(join(repo, 'artifact.txt'), `run=${upstreamRuns}\n`);
            return { status: 'pass' as const };
          }),
          gate: {
            needs: ['upstream'],
            job: fnJob('gate', async (ctx) =>
              ctx.state.resume
                ? { status: 'pass' as const }
                : { status: 'paused' as const, summary: 'pause after upstream' },
            ),
          },
        },
      });

    const first = await run(build(), { ...mockOpts, cwd: repo, checkpoint });
    expect(first.outcome.status).toBe('paused');
    expect(upstreamRuns).toBe(1);

    writeFileSync(join(repo, 'artifact.txt'), 'mutated outside checkpoint\n');
    const second = await run(build(), {
      ...mockOpts,
      cwd: repo,
      checkpoint,
      resumeFrom: checkpoint,
      state: { resume: true },
    });
    expect(second.outcome.status).toBe('pass');
    expect(upstreamRuns).toBe(2);
  });

  it('does skip checkpointed nodes when the checkpoint file is inside the workspace', async () => {
    const repo = await tmpRepo();
    const checkpoint = join(repo, 'ckpt.json');
    let upstreamRuns = 0;

    const build = () =>
      dag({
        name: 'in-worktree-checkpoint',
        nodes: {
          upstream: fnJob('upstream', async () => {
            upstreamRuns += 1;
            writeFileSync(join(repo, 'artifact.txt'), `run=${upstreamRuns}\n`);
            return { status: 'pass' as const };
          }),
          gate: {
            needs: ['upstream'],
            job: fnJob('gate', async (ctx) =>
              ctx.state.resume
                ? { status: 'pass' as const }
                : { status: 'paused' as const, summary: 'pause after upstream' },
            ),
          },
        },
      });

    const first = await run(build(), { ...mockOpts, cwd: repo, checkpoint });
    expect(first.outcome.status).toBe('paused');
    expect(upstreamRuns).toBe(1);

    const second = await run(build(), {
      ...mockOpts,
      cwd: repo,
      checkpoint,
      resumeFrom: checkpoint,
      state: { resume: true },
    });
    expect(second.outcome.status).toBe('pass');
    expect(upstreamRuns).toBe(1);
  });

  it('restores checkpointed DAG nodes after a signal-aborted run with the same checkpoint path', async () => {
    const repo = await tmpRepo();
    const checkpoint = join(repo, 'ckpt.json');
    const controller = new AbortController();
    let upstreamRuns = 0;
    const events: LoopEvent[] = [];

    const build = (abortFirstRun: boolean) =>
      dag({
        name: 'signal-resume',
        nodes: {
          upstream: fnJob('upstream', async () => {
            upstreamRuns += 1;
            writeFileSync(join(repo, 'artifact.txt'), `run=${upstreamRuns}\n`);
            return { status: 'pass' as const };
          }),
          gate: {
            needs: ['upstream'],
            job: fnJob('gate', async (ctx) => {
              if (abortFirstRun) {
                controller.abort();
                return { status: 'aborted' as const, summary: 'terminated' };
              }
              return ctx.state.resume
                ? { status: 'pass' as const, summary: 'resumed' }
                : { status: 'fail' as const };
            }),
          },
        },
      });

    const first = await run(build(true), {
      ...mockOpts,
      cwd: repo,
      checkpoint,
      signal: controller.signal,
    });
    expect(first.outcome.status).toBe('aborted');
    expect(upstreamRuns).toBe(1);

    const second = await run(build(false), {
      ...mockOpts,
      cwd: repo,
      checkpoint,
      resumeFrom: checkpoint,
      state: { resume: true },
      onEvent: (event) => events.push(event),
    });

    expect(second.outcome.status).toBe('pass');
    expect(upstreamRuns).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'runtime:restore',
        decision: 'restored',
        restoredNodes: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'dag:node',
        node: 'upstream',
        cached: true,
      }),
    );
  });

  it('skips aborted-run DAG restore when the workspace fingerprint changed', async () => {
    const repo = await tmpRepo();
    const checkpoint = join(repo, 'ckpt.json');
    const controller = new AbortController();
    let upstreamRuns = 0;
    const events: LoopEvent[] = [];

    const build = (abortFirstRun: boolean) =>
      dag({
        name: 'changed-resume',
        nodes: {
          upstream: fnJob('upstream', async () => {
            upstreamRuns += 1;
            writeFileSync(join(repo, 'artifact.txt'), `run=${upstreamRuns}\n`);
            return { status: 'pass' as const };
          }),
          gate: {
            needs: ['upstream'],
            job: fnJob('gate', async () => {
              if (abortFirstRun) {
                controller.abort();
                return { status: 'aborted' as const };
              }
              return { status: 'pass' as const };
            }),
          },
        },
      });

    await run(build(true), {
      ...mockOpts,
      cwd: repo,
      checkpoint,
      signal: controller.signal,
    });
    writeFileSync(join(repo, 'artifact.txt'), 'mutated outside checkpoint\n');

    const second = await run(build(false), {
      ...mockOpts,
      cwd: repo,
      checkpoint,
      resumeFrom: checkpoint,
      onEvent: (event) => events.push(event),
    });

    expect(second.outcome.status).toBe('pass');
    expect(upstreamRuns).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'runtime:restore',
        decision: 'skipped',
        fingerprint: 'changed',
      }),
    );
  });

  it('restores a legacy checkpoint with DAG nodes but no workspace fingerprint', async () => {
    const repo = await tmpRepo();
    const checkpoint = join(repo, 'legacy-ckpt.json');
    let upstreamRuns = 0;
    const events: LoopEvent[] = [];
    writeFileSync(
      checkpoint,
      JSON.stringify({
        state: {},
        dags: {
          [JSON.stringify(['legacy-resume'])]: {
            nodes: {
              upstream: {
                phase: 'done',
                outcome: { status: 'pass', summary: 'legacy pass' },
              },
            },
          },
        },
      }),
    );

    const result = await run(
      dag({
        name: 'legacy-resume',
        nodes: {
          upstream: fnJob('upstream', async () => {
            upstreamRuns += 1;
            return { status: 'pass' as const };
          }),
          gate: {
            needs: ['upstream'],
            job: fnJob('gate', async () => ({ status: 'pass' as const })),
          },
        },
      }),
      {
        ...mockOpts,
        cwd: repo,
        checkpoint,
        resumeFrom: checkpoint,
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.outcome.status).toBe('pass');
    expect(upstreamRuns).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'runtime:restore',
        decision: 'restored',
        fingerprint: 'checkpoint-missing',
      }),
    );
  });

  it('reports no restored nodes when checkpoint DAG keys do not match the current graph', async () => {
    const repo = await tmpRepo();
    const checkpoint = join(repo, 'old-graph.ckpt.json');
    const events: LoopEvent[] = [];
    let runs = 0;
    writeFileSync(
      checkpoint,
      JSON.stringify({
        state: {},
        dags: {
          [JSON.stringify(['old-dag'])]: {
            nodes: {
              upstream: {
                phase: 'done',
                outcome: { status: 'pass', summary: 'old pass' },
              },
            },
          },
        },
      }),
    );

    const result = await run(
      dag({
        name: 'new-dag',
        nodes: {
          upstream: fnJob('upstream', async () => {
            runs += 1;
            return { status: 'pass' as const, summary: 'fresh pass' };
          }),
        },
      }),
      {
        ...mockOpts,
        cwd: repo,
        checkpoint,
        resumeFrom: checkpoint,
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.outcome.status).toBe('pass');
    expect(runs).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'runtime:restore',
        decision: 'skipped',
        restoredNodes: 0,
        totalNodes: 0,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'dag:node',
        node: 'upstream',
        cached: false,
      }),
    );
  });

  it('writes checkpoints even when cached outcomes contain non-JSON data', async () => {
    const repo = await tmpRepo();
    const checkpoint = join(repo, 'non-json-ckpt.json');

    const { outcome } = await run(
      dag({
        name: 'non-json-cache',
        nodes: {
          upstream: fnJob('upstream', async () => ({
            status: 'pass' as const,
            data: { id: BigInt(1) },
          })),
          gate: {
            needs: ['upstream'],
            job: fnJob('gate', async () => ({
              status: 'paused' as const,
              summary: 'pause',
            })),
          },
        },
      }),
      { ...mockOpts, cwd: repo, checkpoint },
    );

    expect(outcome.status).toBe('paused');
    expect(existsSync(checkpoint)).toBe(true);
    const saved = JSON.parse(readFileSync(checkpoint, 'utf8')) as {
      dags?: Record<string, { nodes?: Record<string, { outcome?: Outcome }> }>;
    };
    const node = saved.dags?.['["non-json-cache"]']?.nodes?.upstream;
    expect(node?.outcome?.status).toBe('pass');
    expect(node?.outcome?.data).toEqual({});
  });
});
