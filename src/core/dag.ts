/**
 * The DAG / stages layer. `dag(config)` returns a `Job`, so it nests with
 * `loop()` both ways. Nodes declare `needs` (dependencies); each node waits on
 * its dependencies' promises, then runs under a shared `p-limit` concurrency
 * gate. Cycle/missing-dep detection is delegated to `toposort` and happens
 * before any work runs.
 *
 * Failure policy (ours, not the libs'):
 *   - a required node failing blocks its dependents (they don't run);
 *   - with `stopOnError` (default) the first required failure stops scheduling
 *     anything not already in flight;
 *   - `optional` nodes never fail the DAG nor block dependents;
 *   - an unmet `when` gate *skips* the node, which counts as green.
 */

import pLimit from 'p-limit';
import toposort from 'toposort';

import type { DagConfig, DagNode, Job, JobContext, Outcome } from './types.ts';
import { childContext } from './context.ts';
import { toCondition } from './condition.ts';
import { LoopError } from './errors.ts';

function normalize(node: DagNode | Job): DagNode {
  return typeof node === 'function' ? { job: node } : node;
}

export function dag(config: DagConfig): Job {
  if (!config.name)
    throw new LoopError({
      code: 'CONFIG',
      message: 'dag() requires a non-empty name',
    });
  const names = Object.keys(config.nodes);
  const nodes = new Map<string, DagNode>(
    names.map((n) => [n, normalize(config.nodes[n]!)]),
  );

  // Fail fast on a bad graph, before the Job is ever run.
  const edges: [string, string][] = [];
  for (const [name, node] of nodes) {
    for (const dep of node.needs ?? []) {
      if (!nodes.has(dep)) {
        throw new LoopError({
          code: 'CONFIG',
          message: `dag "${config.name}": node "${name}" needs unknown node "${dep}"`,
        });
      }
      edges.push([dep, name]); // dep must precede name
    }
  }
  try {
    toposort.array(names, edges);
  } catch (e) {
    throw new LoopError({
      code: 'CONFIG',
      message: `dag "${config.name}": dependency cycle detected`,
      cause: e,
    });
  }

  const stopOnError = config.stopOnError ?? true;
  const limitN =
    config.concurrency && config.concurrency > 0
      ? config.concurrency
      : names.length || 1;

  return async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();
    parent.emit({ kind: 'dag:start', ts: ts(), path, depth, nodes: names });

    const limit = pLimit(limitN);
    const results = new Map<string, Outcome>();
    const memo = new Map<string, Promise<Outcome>>();
    let stopped = false;

    // Each node runs under its own name in the path, so a nested job (e.g. a
    // loop) is uniquely addressable for stats/logs even across same-named siblings.
    const nodeCtx = (name: string): JobContext =>
      childContext(parent, { depth, path: [...path, name] });

    const record = (
      name: string,
      outcome: Outcome,
      phase: 'done' | 'skip',
    ): Outcome => {
      results.set(name, outcome);
      parent.emit({
        kind: 'dag:node',
        ts: ts(),
        path,
        node: name,
        phase,
        outcome,
      });
      if (
        phase === 'done' &&
        outcome.status !== 'pass' &&
        nodes.get(name)!.optional !== true &&
        stopOnError
      ) {
        stopped = true;
      }
      return outcome;
    };

    const run = (name: string): Promise<Outcome> => {
      const existing = memo.get(name);
      if (existing) return existing;
      const node = nodes.get(name)!;
      const promise = (async (): Promise<Outcome> => {
        // Whole node is guarded: a throw anywhere (dep resolution, `when`, the
        // job) becomes a recorded outcome, so the DAG always reaches `dag:end`.
        try {
          const needs = node.needs ?? [];
          const deps = await Promise.all(needs.map(run));
          // A non-pass dependency blocks this node — a declared `needs` is a real
          // data dependency, so even a failed *optional* producer blocks a
          // consumer (skipped deps come back with status 'pass', so they're green).
          const blocked = needs.some((_, i) => deps[i]!.status !== 'pass');
          if (blocked)
            return record(
              name,
              { status: 'aborted', summary: 'blocked by a failed dependency' },
              'done',
            );
          if (parent.signal.aborted || stopped)
            return record(
              name,
              { status: 'aborted', summary: 'aborted before start' },
              'done',
            );

          // `when` + the job both run inside the concurrency limit, so an
          // agentCheck gate counts against the cap (it's real backend load).
          const result = await limit(
            async (): Promise<{ outcome: Outcome; phase: 'done' | 'skip' }> => {
              if (parent.signal.aborted || stopped)
                return {
                  outcome: {
                    status: 'aborted',
                    summary: 'aborted before start',
                  },
                  phase: 'done',
                };
              if (node.when) {
                const r = await toCondition(node.when)(
                  nodeCtx(name),
                  undefined,
                );
                if (!r.met)
                  return {
                    outcome: {
                      status: 'pass',
                      summary: `skipped: ${r.reason}`,
                      data: { skipped: true },
                    },
                    phase: 'skip',
                  };
              }
              parent.emit({
                kind: 'dag:node',
                ts: ts(),
                path,
                node: name,
                phase: 'start',
              });
              return { outcome: await node.job(nodeCtx(name)), phase: 'done' };
            },
          );
          return record(name, result.outcome, result.phase);
        } catch (e) {
          const error = LoopError.from(e, {
            code: 'BODY',
            phase: 'body',
            path: [...path, name],
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path: [...path, name],
            message: error.message,
            code: error.code,
          });
          return record(
            name,
            { status: 'fail', summary: error.message, error },
            'done',
          );
        }
      })();
      memo.set(name, promise);
      return promise;
    };

    await Promise.all(names.map(run));

    const requiredFailed = names.filter(
      (n) =>
        results.get(n)?.status === 'fail' && nodes.get(n)!.optional !== true,
    );
    const requiredAborted = names.filter(
      (n) =>
        results.get(n)?.status === 'aborted' && nodes.get(n)!.optional !== true,
    );
    const data = Object.fromEntries(results);
    let outcome: Outcome;
    if (parent.signal.aborted) {
      // a genuine user/signal cancellation
      outcome = {
        status: 'aborted',
        summary: `dag "${config.name}" aborted`,
        data,
      };
    } else if (requiredFailed.length > 0 || requiredAborted.length > 0) {
      // a real failure (direct, or a required node left undone by an upstream
      // failure) is a fail (exit 1), distinct from a cancellation (exit 130).
      outcome = {
        status: 'fail',
        summary: `dag "${config.name}": ${requiredFailed.length + requiredAborted.length} required node(s) did not complete`,
        data,
      };
    } else {
      outcome = {
        status: 'pass',
        summary: `dag "${config.name}": all ${names.length} node(s) green`,
        data,
      };
    }
    parent.emit({ kind: 'dag:end', ts: ts(), path, outcome });
    return outcome;
  };
}

/** Run jobs strictly in order; stop at the first non-pass. Sugar over `dag`. */
export function sequence(name: string, ...jobs: Job[]): Job {
  const nodes: Record<string, DagNode> = {};
  jobs.forEach((job, i) => {
    nodes[`step-${i}`] = { job, needs: i > 0 ? [`step-${i - 1}`] : [] };
  });
  return dag({ name, nodes, concurrency: 1, stopOnError: true });
}

/** Run jobs concurrently (optionally capped); all run regardless of failures. */
export function parallel(
  name: string,
  jobs: Record<string, Job> | Job[],
  concurrency?: number,
): Job {
  const record = Array.isArray(jobs)
    ? Object.fromEntries(jobs.map((j, i) => [`task-${i}`, j] as const))
    : jobs;
  return dag({ name, nodes: record, concurrency, stopOnError: false });
}
