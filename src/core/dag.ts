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

import type {
  DagConfig,
  DagNode,
  Job,
  JobContext,
  Outcome,
  Workspace,
} from './types.ts';
import { childContext } from './context.ts';
import { toCondition } from './condition.ts';
import { setMeta, jobMeta } from './describe.ts';
import {
  isRepo,
  stageAll,
  commit,
  addWorktree,
  removeWorktree,
  deleteBranch,
  mergeBranch,
} from './git.ts';
import { composeCommitBody } from './consolidate.ts';
import { mergeSynthesis } from './merge.ts';
import type { EnvHandle } from '../env/environment.ts';
import { LoopError } from './errors.ts';

/** Sanitise a name into a git-ref-safe slug. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/(^-+|-+$)/g, '') || 'node';
}

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
  let order: string[];
  try {
    order = toposort.array(names, edges);
  } catch (e) {
    throw new LoopError({
      code: 'CONFIG',
      message: `dag "${config.name}": dependency cycle detected`,
      cause: e,
    });
  }

  const stopOnError = config.stopOnError ?? true;
  const maxKickbacks = config.maxKickbacks ?? 0;

  // Static graph relations for routing cross-stage feedback (kickback). All pure
  // functions of the declared `needs` edges, computed once. `dependents` is the
  // forward adjacency (who needs me); a kickback to a target re-runs the target
  // plus everything reachable from it, and the target must be an ancestor.
  const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const [dep, name] of edges) dependents.get(dep)!.push(name);
  const ancestorsOf = (name: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(nodes.get(name)!.needs ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(nodes.get(n)!.needs ?? []));
    }
    return seen;
  };
  const dirtyFrom = (target: string): Set<string> => {
    const seen = new Set<string>([target]);
    const stack = [target];
    while (stack.length) {
      const n = stack.pop()!;
      for (const d of dependents.get(n)!)
        if (!seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
    }
    return seen;
  };
  const limitN =
    config.concurrency && config.concurrency > 0
      ? config.concurrency
      : names.length || 1;

  const job: Job = async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();
    parent.emit({ kind: 'dag:start', ts: ts(), path, depth, nodes: names });

    const limit = pLimit(limitN);
    const results = new Map<string, Outcome>();
    const memo = new Map<string, Promise<Outcome>>();
    let stopped = false;
    // When a node is kicked back to, the reason rides into its next run as
    // `lastReview` — the same channel a loop's failed `review` uses, so grounding
    // renders it as "## Next". Empty in the common (no-kickback) case.
    const pendingKickback = new Map<string, Outcome>();

    // Each node runs under its own name in the path, so a nested job (e.g. a
    // loop) is uniquely addressable for stats/logs even across same-named siblings.
    const nodeCtx = (
      name: string,
      workspace?: Workspace,
      environment?: EnvHandle,
    ): JobContext =>
      childContext(parent, {
        depth,
        path: [...path, name],
        workspace,
        environment,
        lastReview: pendingKickback.get(name),
      });

    // Land-back merges are serialised: concurrent nodes finishing at once must
    // not race on the parent branch's index/HEAD.
    const mergeLimit = pLimit(1);
    let forkSeq = 0;

    /**
     * Run a node, in its own worktree when isolated. On pass the node's work is
     * captured (any uncommitted remainder is committed in the worktree) and
     * landed back into the parent branch (`--no-ff`, serialised). A merge
     * conflict fails the node honestly — loops does not auto-resolve. The
     * worktree is always removed; a cleanly-merged fork branch is deleted.
     */
    const runNodeJob = async (
      name: string,
      node: DagNode,
    ): Promise<Outcome> => {
      const isolated = node.isolate ?? config.isolation === 'worktree';
      if (!isolated) return node.job(nodeCtx(name));

      const base = parent.workspace;
      if (!(await isRepo({ cwd: base.dir, signal: parent.signal }))) {
        parent.log(
          `node "${name}" requested worktree isolation but ${base.dir} is not a git repo; running in the shared workspace`,
          'warn',
        );
        return node.job(nodeCtx(name));
      }

      const branch = `loops/${slug(config.name)}-${slug(name)}-${(forkSeq += 1)}`;
      const wt = await addWorktree(base.dir, {
        branch,
        base: 'HEAD',
        signal: parent.signal,
      });
      const wtWs: Workspace = { dir: wt.dir, branch };
      // Each team gets its own environment, named after its branch — born with
      // the worktree, torn down with it. A failed start propagates and the node
      // is recorded as failed; the worktree is still cleaned up in `finally`.
      let envHandle: EnvHandle | undefined;
      try {
        if (config.environment)
          envHandle = await config.environment.up(wtWs, parent.signal);
        const outcome = await node.job(nodeCtx(name, wtWs, envHandle));
        if (outcome.status === 'pass') {
          // Capture anything the node left uncommitted, so nothing is stranded
          // in the worktree, then land it back.
          await stageAll({ cwd: wt.dir, signal: parent.signal });
          await commit(
            {
              subject: `chore(${slug(name)}): worktree changes`,
              body: await composeCommitBody(parent, wtWs),
            },
            { cwd: wt.dir, signal: parent.signal },
          );
          const merged = await mergeLimit(() =>
            mergeBranch(base.dir, branch, {
              signal: parent.signal,
              message: `merge ${branch} (node ${name})`,
            }),
          );
          if (!merged.ok) {
            // Conflict. Either fail honestly, or synthesise the merge (an agent
            // resolves it and writes a synthesised body).
            if (config.onConflict !== 'synthesize') {
              return {
                status: 'fail',
                summary: `node "${name}" landed with a merge conflict; needs resolution`,
                error: new LoopError({
                  code: 'BODY',
                  message: `merge conflict landing node "${name}"`,
                  path: [...path, name],
                }),
              };
            }
            try {
              await mergeLimit(() =>
                mergeSynthesis(parent, {
                  branch,
                  message: `merge: ${branch} (node ${name}, synthesis)`,
                }),
              );
            } catch (e) {
              const error = LoopError.from(e, {
                code: 'BODY',
                path: [...path, name],
              });
              return {
                status: 'fail',
                summary: `node "${name}" merge synthesis failed: ${error.message}`,
                error,
              };
            }
          }
          await deleteBranch(base.dir, branch, { signal: parent.signal }).catch(
            () => {},
          );
        }
        return outcome;
      } finally {
        if (envHandle)
          await envHandle.down(parent.signal).catch(() => {});
        await removeWorktree(base.dir, wt.dir, {
          signal: parent.signal,
        }).catch(() => {});
      }
    };

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
        stopOnError &&
        // A node requesting a kickback is going to be re-run — don't let its
        // (provisional) non-pass abort siblings before the feedback is resolved.
        !(maxKickbacks > 0 && outcome.kickback)
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
              return { outcome: await runNodeJob(name, node), phase: 'done' };
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

    // Cross-stage feedback: a node may return a `kickback` asking an earlier
    // node to redo work. We re-run the target + its dependents (the cycle lives
    // in execution, the graph stays acyclic), bounded by `maxKickbacks` so it
    // provably terminates. The whole block is inert when `maxKickbacks` is 0, so
    // the default path is exactly the single pass above.
    if (maxKickbacks > 0) {
      let used = 0;
      const rejected = new Set<string>();
      const emitKickback = (
        from: string,
        to: string,
        reason: string,
        accepted: boolean,
        note?: string,
      ) =>
        parent.emit({
          kind: 'dag:kickback',
          ts: ts(),
          path,
          from,
          to,
          reason,
          accepted,
          note,
        });
      for (;;) {
        // Honour kickbacks in topological order, skipping any already rejected.
        const from = order.find(
          (n) => results.get(n)?.kickback && !rejected.has(n),
        );
        if (!from) break;
        const { to, reason } = results.get(from)!.kickback!;

        // Validate the target: it must exist, be an ancestor, and (if the node
        // declares `acceptsKickbackTo`) be an allowed target. An invalid target
        // is rejected once and never reconsidered unless the node itself re-runs.
        const allow = nodes.get(from)!.acceptsKickbackTo;
        const note = !nodes.has(to)
          ? `unknown node "${to}"`
          : !ancestorsOf(from).has(to)
            ? `"${to}" is not an ancestor of "${from}"`
            : allow && !allow.includes(to)
              ? `"${from}" does not accept kickback to "${to}"`
              : undefined;
        if (note) {
          rejected.add(from);
          emitKickback(from, to, reason, false, note);
          continue;
        }

        if (used >= maxKickbacks) {
          // Budget spent. Reject and stop — the unresolved kickback leaves the
          // kicking node's own outcome to stand (a fail keeps the dag honest).
          emitKickback(
            from,
            to,
            reason,
            false,
            `kickback budget (${maxKickbacks}) exhausted`,
          );
          break;
        }

        used += 1;
        emitKickback(from, to, reason, true);
        const dirty = dirtyFrom(to);
        for (const d of dirty) {
          memo.delete(d); // force re-run
          results.delete(d);
          rejected.delete(d); // a re-run earns a fresh verdict
        }
        pendingKickback.set(to, {
          status: 'fail',
          summary: `Kicked back from "${from}": ${reason}`,
          data: { kickback: true, from },
        });
        stopped = false; // a prior stopOnError must not block the re-run
        await Promise.all(names.map(run));
      }
    }

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

  return setMeta(job, {
    kind: 'dag',
    name: config.name,
    nodes: Object.entries(config.nodes).map(([name, v]) => {
      const node = typeof v === 'function' ? undefined : v;
      const nodeJob = node ? node.job : (v as Job);
      return {
        name,
        needs: node?.needs ?? [],
        isolate: node?.isolate ?? false,
        job: jobMeta(nodeJob),
      };
    }),
  });
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
