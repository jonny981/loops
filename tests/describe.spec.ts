import { describe, it, expect } from 'vitest';
import {
  loop,
  dag,
  agentJob,
  fnJob,
  gateJob,
  commandSucceeds,
  agentCheck,
  quorum,
  predicate,
  jobMeta,
  renderPlan,
  describeConditions,
} from '../src/api.ts';

// The builders register an introspectable shape for the Job they return, so a
// loop can be read back (and rendered) without running it. This is what backs
// `loops validate` / `loops describe`.

describe('job introspection (meta + renderPlan)', () => {
  it('attaches meta to a loop and renders its shape', () => {
    const job = loop({
      name: 'build',
      max: 20,
      body: agentJob({ label: 'worker', prompt: 'go', ground: true }),
      until: [
        commandSucceeds('npm', ['test']),
        agentCheck({ question: 'done?', threshold: 0.85 }),
      ],
      commit: true,
    });

    const meta = jobMeta(job);
    expect(meta?.kind).toBe('loop');
    expect(meta?.name).toBe('build');
    expect(meta?.max).toBe(20);
    expect(meta?.gate).toEqual(['npm test', 'judge "done?" >=0.85']);
    expect(meta?.commit).toBe(true);
    const body = meta?.body as { kind: string; name: string; ground: boolean };
    expect(body.kind).toBe('agent');
    expect(body.name).toBe('worker');
    expect(body.ground).toBe(true);

    const plan = renderPlan(meta).join('\n');
    expect(plan).toContain('loop "build" (max 20)');
    expect(plan).toContain('gate: npm test, judge "done?" >=0.85');
    expect(plan).toContain('on convergence: commit');
    expect(plan).toContain('agent "worker" (grounded)');
  });

  it('attaches meta to a dag with nodes, deps, and a nested loop', () => {
    const job = dag({
      name: 'ship',
      nodes: {
        research: agentJob({ label: 'research', prompt: 'r' }),
        implement: {
          needs: ['research'],
          job: loop({
            name: 'impl',
            body: fnJob('x', async () => ({ status: 'pass' as const })),
            until: predicate(() => true, 'ok'),
          }),
        },
        review: {
          needs: ['implement'],
          job: gateJob('review', commandSucceeds('npm', ['run', 'lint'])),
        },
      },
    });

    const meta = jobMeta(job);
    expect(meta?.kind).toBe('dag');
    const nodes = meta?.nodes as Array<{
      name: string;
      needs: string[];
      job?: { kind: string };
    }>;
    expect(nodes.map((n) => n.name)).toEqual(['research', 'implement', 'review']);
    expect(nodes[1]!.needs).toEqual(['research']);
    expect(nodes[1]!.job?.kind).toBe('loop');
    expect(nodes[2]!.job?.kind).toBe('gate');

    const plan = renderPlan(meta).join('\n');
    expect(plan).toContain('dag "ship" (3 nodes)');
    expect(plan).toContain('- implement (needs research)');
    expect(plan).toContain('loop "impl"');
  });

  it('labels a quorum, and a hand-written job has no meta', () => {
    const j = quorum(
      2,
      agentCheck({ question: 'a' }),
      agentCheck({ question: 'b' }),
      agentCheck({ question: 'c' }),
    );
    expect(describeConditions(j)).toEqual(['quorum 2/3']);

    const bare = async () => ({ status: 'pass' as const });
    expect(jobMeta(bare)).toBeUndefined();
    expect(renderPlan(undefined)).toEqual([
      '(a runnable job, shape not introspectable)',
    ]);
  });
});
