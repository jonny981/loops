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
 *
 * With a `plan` (a `LivePlan`) instead of static `nodes`, the graph is data
 * and the dag is *steerable* (docs/momentum.md): accepted plan edits take
 * structural effect at the next barrier — the safepoint — via the same
 * invalidate-and-re-enter mechanics kickback uses, while a `cancel`/`remove`
 * of a running node aborts it immediately through its per-node controller.
 * The dag guards the plan while it runs: no edit touches a node that already
 * passed (the past is immutable). Execution still terminates within any one
 * plan version; only further steers extend a run's life.
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
import { setMeta, jobMeta, describeConditions } from './describe.ts';
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
import { revisionFromOutcome } from './feedback.ts';
import { DEFAULT_FANOUT_CONCURRENCY } from './concurrency.ts';
import type { PlanChange } from './plan.ts';

/** Sanitise a name into a git-ref-safe slug. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/(^-+|-+$)/g, '') || 'node';
}

function normalize(node: DagNode | Job): DagNode {
  return typeof node === 'function' ? { job: node } : node;
}

/** One immutable snapshot of the graph — rebuilt per plan version, never
 *  mutated in place, so closures created during a barrier stay consistent. */
interface Graph {
  names: string[];
  nodes: Map<string, DagNode>;
  order: string[];
  dependents: Map<string, string[]>;
}

export function dag(config: DagConfig): Job {
  if (!config.name)
    throw new LoopError({
      code: 'CONFIG',
      message: 'dag() requires a non-empty name',
    });
  const plan = config.plan;
  if (plan && config.nodes)
    throw new LoopError({
      code: 'CONFIG',
      message: `dag "${config.name}": pass exactly one of "nodes" (static) or "plan" (live), not both`,
    });
  if (!plan && !config.nodes)
    throw new LoopError({
      code: 'CONFIG',
      message: `dag "${config.name}": requires "nodes" or a live "plan"`,
    });

  const buildGraph = (source: Map<string, DagNode>): Graph => {
    const names = [...source.keys()];
    const edges: [string, string][] = [];
    for (const [name, node] of source) {
      for (const dep of node.needs ?? []) {
        if (!source.has(dep)) {
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
    const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
    for (const [dep, name] of edges) dependents.get(dep)!.push(name);
    return { names, nodes: source, order, dependents };
  };

  // Fail fast on a bad graph, before the Job is ever run (either source; a
  // live plan re-validates every edit itself, so this snapshot stays valid).
  const initialGraph = buildGraph(
    plan
      ? plan.nodes()
      : new Map(
          Object.keys(config.nodes!).map((n) => [
            n,
            normalize(config.nodes![n]!),
          ]),
        ),
  );

  const stopOnError = config.stopOnError ?? true;
  const maxKickbacks = config.maxKickbacks ?? 0;

  // Graph relations for routing cross-stage feedback (kickback) and steer
  // invalidation. Pure functions of a snapshot's `needs` edges. `dependents`
  // is the forward adjacency (who needs me); a kickback to a target re-runs
  // the target plus everything reachable from it, and the target must be an
  // ancestor.
  const ancestorsOf = (g: Graph, name: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(g.nodes.get(name)!.needs ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(g.nodes.get(n)!.needs ?? []));
    }
    return seen;
  };
  const dirtyFrom = (g: Graph, target: string): Set<string> => {
    const seen = new Set<string>([target]);
    const stack = [target];
    while (stack.length) {
      const n = stack.pop()!;
      for (const d of g.dependents.get(n)!)
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
      : DEFAULT_FANOUT_CONCURRENCY;

  const job: Job = async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();
    const checkpointKey = JSON.stringify(path);
    const resumedDag = parent.checkpoint?.resumeDags?.[checkpointKey];
    if (parent.checkpoint?.resumeDags)
      delete parent.checkpoint.resumeDags[checkpointKey];

    let g = plan ? buildGraph(plan.nodes()) : initialGraph;
    parent.emit({ kind: 'dag:start', ts: ts(), path, depth, nodes: g.names });

    const limit = pLimit(limitN);
    const results = new Map<string, Outcome>();
    const memo = new Map<string, Promise<Outcome>>();
    // How many times each node has run (1 on the first pass, +1 per kickback
    // re-run). Stamped onto its dag:node events so records can tell rounds apart.
    const attempts = new Map<string, number>();
    let stopped = false;
    // When a node is kicked back to, the reason rides into its next run as
    // `lastReview` — the same channel a loop's failed `review` uses, so grounding
    // renders it as "## Next". Empty in the common (no-kickback) case.
    const pendingKickback = new Map<string, Outcome>();

    // The frontier's controllers: one per running node, so a steer can preempt
    // a single branch without stopping the graph.
    const nodeAborts = new Map<string, AbortController>();
    // Names terminated by a steer (cancel, or remove of a not-yet-passed
    // node). Cancellation is deliberate: it neither trips stopOnError nor
    // counts against the dag's disposition.
    const cancelledNames = new Set<string>(plan ? plan.cancelled() : []);
    const cancelledOutcome = (): Outcome => ({
      status: 'aborted',
      summary: 'cancelled by steer',
    });
    const pausedOutcome = (): Outcome => ({
      status: 'paused',
      summary: `paused by control${parent.pause?.reason ? `: ${parent.pause.reason}` : ''}`,
    });

    // Steers land here as they are accepted; their structural effect applies
    // at the next barrier (the safepoint). Cancellation of a running node is
    // the one immediate effect — the barrier may be waiting on that very node.
    const pendingSteers: PlanChange[] = [];
    let detachGuard: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    if (plan) {
      detachGuard = plan.attachGuard((edits) => {
        for (const edit of edits) {
          if (edit.op === 'add' || edit.op === 'reprioritise') continue;
          if (results.get(edit.name)?.status === 'pass')
            return `${edit.op} refused: node "${edit.name}" already crystallized (the past is immutable)`;
        }
        return undefined;
      });
      unsubscribe = plan.subscribe((change) => {
        pendingSteers.push(change);
        for (const edit of change.edits) {
          parent.emit({
            kind: 'dag:edit',
            ts: ts(),
            path,
            plan: plan.name,
            version: change.version,
            op: edit.op,
            node: edit.name,
            accepted: true,
          });
          if (edit.op === 'cancel' || edit.op === 'remove') {
            cancelledNames.add(edit.name);
            nodeAborts.get(edit.name)?.abort();
          }
        }
      });
    }

    // Each node runs under its own name in the path, so a nested job (e.g. a
    // loop) is uniquely addressable for stats/logs even across same-named siblings.
    const nodeCtx = (
      name: string,
      workspace?: Workspace,
      environment?: EnvHandle,
      signal?: AbortSignal,
    ): JobContext =>
      childContext(parent, {
        depth,
        path: [...path, name],
        workspace,
        environment,
        signal,
        lastReview: pendingKickback.get(name),
        graph: {
          dag: config.name,
          node: name,
          path: [...path, name],
          needs: g.nodes.get(name)!.needs ?? [],
          dependents: g.dependents.get(name) ?? [],
        },
        timeoutMs: g.nodes.get(name)!.timeoutMs,
        timeoutGraceMs: g.nodes.get(name)!.timeoutGraceMs,
      });

    // Land-back merges are serialised: concurrent nodes finishing at once must
    // not race on the parent branch's index/HEAD.
    const mergeLimit = pLimit(1);
    let forkSeq = 0;

    /**
     * Run a node, in its own worktree when isolated. On pass the node's work is
     * captured (any uncommitted remainder is committed in the worktree) and
     * landed back into the parent branch (`--no-ff`, serialised). A merge
     * conflict fails the node; loops does not auto-resolve. The worktree is
     * always removed; a cleanly-merged fork branch is deleted.
     */
    const runNodeJob = async (
      name: string,
      node: DagNode,
      signal?: AbortSignal,
    ): Promise<Outcome> => {
      const isolated = node.isolate ?? config.isolation === 'worktree';
      if (!isolated) return node.job(nodeCtx(name, undefined, undefined, signal));

      const base = parent.workspace;
      if (!(await isRepo({ cwd: base.dir, signal: parent.signal }))) {
        parent.log(
          `node "${name}" requested worktree isolation but ${base.dir} is not a git repo; running in the shared workspace`,
          'warn',
        );
        return node.job(nodeCtx(name, undefined, undefined, signal));
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
        const outcome = await node.job(nodeCtx(name, wtWs, envHandle, signal));
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
            // Conflict. Either fail, or synthesise the merge (an agent
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
      cached = false,
    ): Outcome => {
      results.set(name, outcome);
      const checkpoint = parent.checkpoint;
      if (checkpoint) {
        const dagState = (checkpoint.dags[checkpointKey] ??= { nodes: {} });
        if (!cached && phase === 'done' && outcome.status === 'pass') {
          dagState.nodes[name] = {
            phase,
            outcome,
            attempt: attempts.get(name),
          };
        } else if (!cached && outcome.status !== 'pass') {
          delete dagState.nodes[name];
        }
      }
      parent.emit({
        kind: 'dag:node',
        ts: ts(),
        path,
        node: name,
        phase,
        outcome,
        attempt: attempts.get(name),
        cached,
        timeoutMs: g.nodes.get(name)?.timeoutMs,
      });
      // A paused node is a deliberate halt (a human gate awaiting
      // acknowledgement), not a failure: stop scheduling not-yet-started nodes
      // even when `stopOnError` is false or the node is optional.
      if (phase === 'done' && outcome.status === 'paused') {
        stopped = true;
      }
      if (
        phase === 'done' &&
        outcome.status !== 'pass' &&
        g.nodes.get(name)?.optional !== true &&
        stopOnError &&
        // A cancelled node is a deliberate steer, not a failure — it must not
        // stop its siblings.
        !cancelledNames.has(name) &&
        // A node requesting a kickback is going to be re-run — don't let its
        // (provisional) non-pass abort siblings before the feedback is resolved.
        !(maxKickbacks > 0 && revisionFromOutcome(outcome)?.target)
      ) {
        stopped = true;
      }
      return outcome;
    };

    const run = (name: string): Promise<Outcome> => {
      const existing = memo.get(name);
      if (existing) return existing;
      const node = g.nodes.get(name)!;
      const promise = (async (): Promise<Outcome> => {
        // This node's run count: 1 the first time, +1 each kickback re-run (the
        // memo/results were cleared for the dirty subgraph, so run() re-enters).
        attempts.set(name, (attempts.get(name) ?? 0) + 1);
        // Whole node is guarded: a throw anywhere (dep resolution, `when`, the
        // job) becomes a recorded outcome, so the DAG always reaches `dag:end`.
        try {
          if (cancelledNames.has(name))
            return record(name, cancelledOutcome(), 'done');
          const needs = node.needs ?? [];
          const deps = await Promise.all(needs.map(run));
          // A declared `needs` on a REQUIRED producer is a hard dependency — its
          // failure blocks this consumer. An OPTIONAL producer is best-effort:
          // its failure neither fails the DAG nor blocks consumers, so a consumer
          // must tolerate that producer's artifacts being absent. Skipped deps
          // (unmet `when`) come back with status 'pass', so they never block.
          const blocked = needs.some(
            (dep, i) =>
              deps[i]!.status !== 'pass' && g.nodes.get(dep)!.optional !== true,
          );
          if (blocked)
            return record(
              name,
              { status: 'aborted', summary: 'blocked by a failed dependency' },
              'done',
            );
          if (parent.pause?.requested)
            return record(name, pausedOutcome(), 'done');
          if (parent.signal.aborted || stopped)
            return record(
              name,
              { status: 'aborted', summary: 'aborted before start' },
              'done',
            );

          const cached = resumedDag?.nodes[name];
          if (cached?.phase === 'done' && cached.outcome.status === 'pass') {
            attempts.set(name, cached.attempt ?? attempts.get(name) ?? 1);
            return record(name, cached.outcome, cached.phase, true);
          }

          // `when` + the job both run inside the concurrency limit, so an
          // agentCheck gate counts against the cap (it's real backend load).
          const result = await limit(
            async (): Promise<{ outcome: Outcome; phase: 'done' | 'skip' }> => {
              if (cancelledNames.has(name))
                return { outcome: cancelledOutcome(), phase: 'done' };
              if (parent.pause?.requested)
                return { outcome: pausedOutcome(), phase: 'done' };
              if (parent.signal.aborted || stopped)
                return {
                  outcome: {
                    status: 'aborted',
                    summary: 'aborted before start',
                  },
                  phase: 'done',
                };
              if (node.when) {
                const conditionCtx = nodeCtx(name);
                const r = await toCondition(node.when)(conditionCtx, undefined);
                parent.emit({
                  kind: 'condition:result',
                  ts: ts(),
                  path: [...conditionCtx.path],
                  label: 'when',
                  iteration: conditionCtx.iteration,
                  result: r,
                });
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
                attempt: attempts.get(name),
                timeoutMs: node.timeoutMs,
              });
              // The per-node controller: a steer cancelling this node aborts
              // exactly this branch of the frontier, nothing else. Static dags
              // pay nothing — the combined signal degenerates to the parent's.
              const ctl = new AbortController();
              nodeAborts.set(name, ctl);
              if (cancelledNames.has(name)) ctl.abort();
              try {
                const signal = AbortSignal.any([parent.signal, ctl.signal]);
                return {
                  outcome: await runNodeJob(name, node, signal),
                  phase: 'done',
                };
              } finally {
                nodeAborts.delete(name);
              }
            },
          );
          // A preempted node reports as cancelled whatever its abort surfaced
          // as — unless it raced to a genuine pass, which stands (it
          // crystallized first).
          const outcome =
            cancelledNames.has(name) &&
            result.phase === 'done' &&
            result.outcome.status !== 'pass'
              ? cancelledOutcome()
              : result.outcome;
          return record(name, outcome, result.phase);
        } catch (e) {
          if (cancelledNames.has(name))
            return record(name, cancelledOutcome(), 'done');
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

    // One scheduling epoch: kick off every node in the current graph, highest
    // `priority` admitted to the concurrency queue first (memoized nodes
    // return instantly, so an epoch only *runs* what an edit or kickback
    // invalidated).
    const runAll = (): Promise<Outcome[]> => {
      const entry = [...g.names].sort(
        (a, b) =>
          (g.nodes.get(b)!.priority ?? 0) - (g.nodes.get(a)!.priority ?? 0),
      );
      return Promise.all(entry.map(run));
    };

    // Apply the steers that landed during the last barrier: rebuild the graph
    // at the plan's current version and invalidate the affected subgraph so it
    // re-runs — kickback's mechanics, generalised to arbitrary edits. A node
    // that already passed keeps its result: the past is immutable, and
    // re-doing accepted work is kickback's job, not steering's.
    const applySteers = (): boolean => {
      if (!plan || !pendingSteers.length) return false;
      const changes = pendingSteers.splice(0);
      const oldG = g;
      g = buildGraph(plan.nodes());
      const dirty = new Set<string>();
      for (const change of changes) {
        for (const edit of change.edits) {
          if (edit.op === 'reprioritise' || edit.op === 'cancel') continue;
          if (!g.nodes.has(edit.name)) {
            // Removed: clear its state, and dirty its old consumers (they may
            // have been rewired onto other producers in the same batch).
            memo.delete(edit.name);
            results.delete(edit.name);
            delete parent.checkpoint?.dags[checkpointKey]?.nodes[edit.name];
            delete resumedDag?.nodes[edit.name];
            for (const d of oldG.dependents.get(edit.name) ?? [])
              if (g.nodes.has(d))
                for (const dd of dirtyFrom(g, d)) dirty.add(dd);
            continue;
          }
          for (const d of dirtyFrom(g, edit.name)) dirty.add(d);
        }
      }
      for (const d of dirty) {
        if (results.get(d)?.status === 'pass') continue; // crystallized: stands
        if (cancelledNames.has(d)) continue; // terminal by steer
        memo.delete(d);
        results.delete(d);
        delete parent.checkpoint?.dags[checkpointKey]?.nodes[d];
        delete resumedDag?.nodes[d];
      }
      stopped = false; // a prior stopOnError must not block the re-run
      return true;
    };

    // Cross-stage feedback: a node may return a `kickback` asking an earlier
    // node to redo work. We re-run the target + its dependents (the cycle lives
    // in execution, the graph stays acyclic), bounded by `maxKickbacks` so it
    // provably terminates. The whole pass is inert when `maxKickbacks` is 0, so
    // the default path is exactly the single barrier.
    let kickbacksUsed = 0;
    const kickbackRejected = new Set<string>();
    const kickbackPass = async (): Promise<void> => {
      if (maxKickbacks <= 0) return;
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
        // A pause (a human gate awaiting acknowledgement) outranks a pending
        // kickback: the halt is deliberate, so nothing may run past it, not
        // even the gate itself, whose `human:gate` event must fire exactly
        // once per pause. Leave `stopped` set and the kickback unresolved;
        // resumed DAG nodes restore completed green work from checkpoint.
        if (g.names.some((n) => results.get(n)?.status === 'paused')) break;
        // Honour kickbacks in topological order, skipping any already rejected.
        const from = g.order.find((n) => {
          const result = results.get(n);
          return (
            result !== undefined &&
            revisionFromOutcome(result)?.target !== undefined &&
            !kickbackRejected.has(n)
          );
        });
        if (!from) break;
        const request = revisionFromOutcome(results.get(from)!)!;
        const to = request.target!;
        const { reason } = request;

        // Validate the target: it must exist, be an ancestor, and (if the node
        // declares `acceptsKickbackTo`) be an allowed target. An invalid target
        // is rejected once and never reconsidered unless the node itself re-runs.
        const allow = g.nodes.get(from)!.acceptsKickbackTo;
        const note = !g.nodes.has(to)
          ? `unknown node "${to}"`
          : !ancestorsOf(g, from).has(to)
            ? `"${to}" is not an ancestor of "${from}"`
            : allow && !allow.includes(to)
              ? `"${from}" does not accept kickback to "${to}"`
              : undefined;
        if (note) {
          kickbackRejected.add(from);
          emitKickback(from, to, reason, false, note);
          continue;
        }

        if (kickbacksUsed >= maxKickbacks) {
          // Budget spent. Reject and stop: the unresolved kickback leaves the
          // kicking node's own outcome to stand.
          emitKickback(
            from,
            to,
            reason,
            false,
            `kickback budget (${maxKickbacks}) exhausted`,
          );
          break;
        }

        kickbacksUsed += 1;
        emitKickback(from, to, reason, true);
        const dirty = dirtyFrom(g, to);
        for (const d of dirty) {
          memo.delete(d); // force re-run
          results.delete(d);
          kickbackRejected.delete(d); // a re-run earns a fresh verdict
          delete parent.checkpoint?.dags[checkpointKey]?.nodes[d];
          delete resumedDag?.nodes[d];
        }
        pendingKickback.set(to, {
          status: 'fail',
          summary: `Kicked back from "${from}": ${reason}`,
          revision: { ...request, source: request.source ?? from },
        });
        stopped = false; // a prior stopOnError must not block the re-run
        await runAll();
      }
    };

    try {
      // The epoch loop. A static dag makes exactly one pass (barrier +
      // kickbacks) and exits; a live dag re-enters once per steer batch that
      // landed during the previous epoch, and completes when a barrier settles
      // with no steer landed since it began — so within one plan version,
      // execution terminates, and only external force extends the run.
      for (;;) {
        await runAll();
        await kickbackPass();
        if (!plan) break;
        if (g.names.some((n) => results.get(n)?.status === 'paused')) break;
        if (!applySteers()) break;
      }
    } finally {
      detachGuard?.();
      unsubscribe?.();
    }

    const requiredFailed = g.names.filter(
      (n) =>
        results.get(n)?.status === 'fail' &&
        g.nodes.get(n)!.optional !== true &&
        !cancelledNames.has(n),
    );
    const requiredAborted = g.names.filter(
      (n) =>
        results.get(n)?.status === 'aborted' &&
        g.nodes.get(n)!.optional !== true &&
        !cancelledNames.has(n),
    );
    // A pause anywhere in the graph (any node, optional included) pauses the
    // whole dag. First in declaration order names the outcome.
    const pausedNode = g.names.find(
      (n) => results.get(n)?.status === 'paused',
    );
    const data = Object.fromEntries(results);
    const late = [...results.values()].some((r) => r.late);
    let outcome: Outcome;
    if (parent.signal.aborted) {
      // a genuine user/signal cancellation
      outcome = {
        status: 'aborted',
        ...(late ? { late: true } : {}),
        summary: `dag "${config.name}" aborted`,
        data,
      };
    } else if (pausedNode) {
      // Paused takes precedence over fail: on resume, completed green nodes can
      // be restored from checkpoint and unfinished or failed nodes get a fresh
      // pass. The paused status is what tells the caller the run is resumable.
      // The paused node's dependents land blocked-aborted as usual; they must
      // not flip this to fail.
      outcome = {
        status: 'paused',
        ...(late ? { late: true } : {}),
        summary: results.get(pausedNode)!.summary,
        data,
      };
    } else if (requiredFailed.length > 0 || requiredAborted.length > 0) {
      // a real failure (direct, or a required node left undone by an upstream
      // failure) is a fail (exit 1), distinct from a cancellation (exit 130).
      outcome = {
        status: 'fail',
        ...(late ? { late: true } : {}),
        summary: `dag "${config.name}": ${requiredFailed.length + requiredAborted.length} required node(s) did not complete`,
        data,
      };
    } else {
      outcome = {
        status: 'pass',
        ...(late ? { late: true } : {}),
        summary: `dag "${config.name}": all ${g.names.length} node(s) green`,
        data,
      };
    }
    parent.emit({ kind: 'dag:end', ts: ts(), path, outcome });
    return outcome;
  };

  return setMeta(job, {
    kind: 'dag',
    name: config.name,
    ...(plan ? { live: plan.name } : {}),
    nodes: [...initialGraph.nodes.entries()].map(([name, node]) => {
      return {
        name,
        needs: node.needs ?? [],
        isolate: node.isolate ?? false,
        optional: node.optional === true,
        ...(node.timeoutMs ? { timeoutMs: node.timeoutMs } : {}),
        // Condition labels only — the meta must stay JSON-serializable
        // (`loops describe --json` prints it verbatim).
        ...(node.when ? { when: describeConditions(node.when) } : {}),
        job: jobMeta(node.job),
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

/** Run jobs concurrently; default fan-out is capped at 4. */
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
