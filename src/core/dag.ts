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
  const names = Object.keys(config.nodes);
  const nodes = new Map<string, DagNode>(names.map((n) => [n, normalize(config.nodes[n]!)]));

  // Fail fast on a bad graph, before the Job is ever run.
  const edges: [string, string][] = [];
  for (const [name, node] of nodes) {
    for (const dep of node.needs ?? []) {
      if (!nodes.has(dep)) {
        throw new LoopError({ code: 'CONFIG', message: `dag "${config.name}": node "${name}" needs unknown node "${dep}"` });
      }
      edges.push([dep, name]); // dep must precede name
    }
  }
  try {
    toposort.array(names, edges);
  } catch (e) {
    throw new LoopError({ code: 'CONFIG', message: `dag "${config.name}": dependency cycle detected`, cause: e });
  }

  const stopOnError = config.stopOnError ?? true;
  const limitN = config.concurrency && config.concurrency > 0 ? config.concurrency : names.length || 1;

  return async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();
    parent.emit({ kind: 'dag:start', ts: ts(), path, depth, nodes: names });

    const limit = pLimit(limitN);
    const results = new Map<string, Outcome>();
    const memo = new Map<string, Promise<Outcome>>();
    let stopped = false;

    const childCtx = (): JobContext => childContext(parent, { depth, path });

    const record = (name: string, outcome: Outcome, phase: 'done' | 'skip'): Outcome => {
      results.set(name, outcome);
      parent.emit({ kind: 'dag:node', ts: ts(), path, node: name, phase, outcome });
      if (phase === 'done' && outcome.status !== 'pass' && nodes.get(name)!.optional !== true && stopOnError) {
        stopped = true;
      }
      return outcome;
    };

    const run = (name: string): Promise<Outcome> => {
      const existing = memo.get(name);
      if (existing) return existing;
      const node = nodes.get(name)!;
      const promise = (async (): Promise<Outcome> => {
        const needs = node.needs ?? [];
        const deps = await Promise.all(needs.map(run));
        // A non-pass dependency blocks this node — a declared `needs` is a real
        // data dependency, so even a failed *optional* producer blocks a
        // consumer (skipped deps come back with status 'pass', so they're green).
        const blocked = needs.some((_, i) => deps[i]!.status !== 'pass');
        if (blocked) return record(name, { status: 'aborted', summary: 'blocked by a failed dependency' }, 'done');
        if (parent.signal.aborted || stopped) return record(name, { status: 'aborted', summary: 'aborted before start' }, 'done');

        if (node.when) {
          const r = await toCondition(node.when)(childCtx(), undefined);
          if (!r.met) return record(name, { status: 'pass', summary: `skipped: ${r.reason}`, data: { skipped: true } }, 'skip');
        }

        const outcome = await limit(async (): Promise<Outcome> => {
          if (parent.signal.aborted || stopped) return { status: 'aborted', summary: 'aborted before start' };
          parent.emit({ kind: 'dag:node', ts: ts(), path, node: name, phase: 'start' });
          try {
            return await node.job(childCtx());
          } catch (e) {
            const error = LoopError.from(e, { code: 'BODY', phase: 'body', path: [...path, name] });
            parent.emit({ kind: 'error', ts: ts(), path: [...path, name], message: error.message, code: error.code });
            return { status: 'fail', summary: error.message, error };
          }
        });
        return record(name, outcome, 'done');
      })();
      memo.set(name, promise);
      return promise;
    };

    await Promise.all(names.map(run));

    const requiredFailed = names.filter((n) => results.get(n)?.status === 'fail' && nodes.get(n)!.optional !== true);
    const requiredAborted = names.filter((n) => results.get(n)?.status === 'aborted' && nodes.get(n)!.optional !== true);
    const data = Object.fromEntries(results);
    let outcome: Outcome;
    if (requiredFailed.length > 0) {
      outcome = { status: 'fail', summary: `dag "${config.name}": ${requiredFailed.length} node(s) failed`, data };
    } else if (parent.signal.aborted || requiredAborted.length > 0) {
      outcome = { status: 'aborted', summary: `dag "${config.name}" did not complete`, data };
    } else {
      outcome = { status: 'pass', summary: `dag "${config.name}": all ${names.length} node(s) green`, data };
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
export function parallel(name: string, jobs: Record<string, Job> | Job[], concurrency?: number): Job {
  const record = Array.isArray(jobs)
    ? Object.fromEntries(jobs.map((j, i) => [`task-${i}`, j] as const))
    : jobs;
  return dag({ name, nodes: record, concurrency, stopOnError: false });
}
