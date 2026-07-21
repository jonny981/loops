/**
 * The live plan — the versioned, steerable graph behind a live `dag()`
 * (designed in docs/momentum.md). A `LivePlan` holds the node graph as data:
 * edits (`add`/`remove`/`rewire`/`cancel`/`reprioritise`) are validated as an
 * atomic batch against the *edited* graph — unknown dependencies, dangling
 * consumers, and cycles are refused whole, nothing half-applies — and each
 * accepted batch bumps the plan version. The executor (a running dag) attaches
 * a guard so edits that touch crystallized work (a node that already passed)
 * are refused: the past is immutable, only the future is data.
 *
 * Validation here is the "live toposort": the same acyclicity discipline
 * `dag()` applies once at construction, applied per edit batch for the life of
 * the plan. Steering *sources* differ in budget, not mechanism: out-of-process
 * steering (a person, a helm driver, `loops steer`) is unbounded — external
 * force is how an indefinite process stays alive — while a run terminates
 * within any one plan version.
 */

import toposort from 'toposort';

import type { DagNode, Job } from './types.ts';
import { LoopError } from './errors.ts';

/**
 * One steering operation. Applied only as part of an atomic batch. An `add`
 * carries either a ready `node` (in-process steering) or a `template` name +
 * `params` (out-of-process steering: JSON cannot carry a function, so the
 * recipe registers what kinds of work exist and the steer instantiates one).
 */
export type PlanEdit =
  | {
      op: 'add';
      name: string;
      node?: DagNode | Job;
      template?: string;
      params?: unknown;
      /** Dependencies for a templated add (a `node` carries its own `needs`). */
      needs?: string[];
      priority?: number;
    }
  | { op: 'remove'; name: string }
  | { op: 'rewire'; name: string; needs: string[] }
  | { op: 'cancel'; name: string }
  | { op: 'reprioritise'; name: string; priority: number };

/** A named node factory: the recipe's vocabulary of steerable work. */
export type PlanTemplate = (params: unknown) => DagNode | Job;

export interface LivePlanConfig {
  /** Registry name — how an out-of-process `steer` command addresses this plan. */
  name: string;
  /** The initial graph, same shape as `DagConfig.nodes`. May be empty. */
  nodes?: Record<string, DagNode | Job>;
  /**
   * Named node factories an out-of-process `add` can instantiate:
   * `{"op":"add","name":"fix-123","template":"fix-bug","params":{...}}`.
   * The recipe defines what kinds of work exist; the steer picks one.
   */
  templates?: Record<string, PlanTemplate>;
}

/**
 * An executor's veto over a batch. Returns a reason to refuse the whole batch,
 * or undefined to allow it. Attached while a dag is running the plan.
 */
export type PlanGuard = (edits: readonly PlanEdit[]) => string | undefined;

export interface PlanChange {
  version: number;
  edits: readonly PlanEdit[];
}

type PlanListener = (change: PlanChange) => void;

function normalize(node: DagNode | Job): DagNode {
  return typeof node === 'function' ? { job: node } : node;
}

function steerError(plan: string, message: string): LoopError {
  return new LoopError({ code: 'STEER', message: `plan "${plan}": ${message}` });
}

/**
 * Validate a full node map the way `dag()` does at construction: every declared
 * dependency exists, no cycles. Throws a STEER error naming the offence.
 */
function validateGraph(
  plan: string,
  nodes: Map<string, DagNode>,
  cancelled: ReadonlySet<string>,
): void {
  const edges: [string, string][] = [];
  for (const [name, node] of nodes) {
    for (const dep of node.needs ?? []) {
      if (!nodes.has(dep))
        throw steerError(plan, `node "${name}" needs unknown node "${dep}"`);
      // A live consumer must never depend on a cancelled producer: the steer
      // that cancels a node must resolve its dependents in the same batch
      // (cancel, remove, or rewire them), or the batch is refused whole.
      if (cancelled.has(dep) && !cancelled.has(name))
        throw steerError(
          plan,
          `node "${name}" needs cancelled node "${dep}"; resolve the dependent in the same batch`,
        );
      edges.push([dep, name]);
    }
  }
  try {
    toposort.array([...nodes.keys()], edges);
  } catch {
    throw steerError(plan, 'dependency cycle detected');
  }
}

// Live plans register by name so an out-of-process steer command, delivered to
// the run process by the control channel, can find its target. Module-scoped:
// the registry is per-process, which is exactly the scope a steer applies at.
const registry = new Map<string, LivePlan>();

/** Look up a registered live plan by name (undefined when none). */
export function getLivePlan(name: string): LivePlan | undefined {
  return registry.get(name);
}

/** All registered live plan names (for error messages and defaulting). */
export function livePlanNames(): string[] {
  return [...registry.keys()];
}

export class LivePlan {
  readonly name: string;
  #nodes: Map<string, DagNode>;
  #version = 1;
  #cancelled = new Set<string>();
  readonly #templates: Map<string, PlanTemplate>;
  readonly #guards = new Set<PlanGuard>();
  readonly #listeners = new Set<PlanListener>();

  constructor(config: LivePlanConfig) {
    if (!config.name)
      throw new LoopError({
        code: 'CONFIG',
        message: 'livePlan() requires a non-empty name',
      });
    this.name = config.name;
    this.#nodes = new Map(
      Object.entries(config.nodes ?? {}).map(([n, v]) => [n, normalize(v)]),
    );
    this.#templates = new Map(Object.entries(config.templates ?? {}));
    validateGraph(this.name, this.#nodes, this.#cancelled);
    registry.set(this.name, this);
  }

  /** Monotonic plan version; bumps once per accepted batch. */
  get version(): number {
    return this.#version;
  }

  /** A defensive copy of the current graph. */
  nodes(): Map<string, DagNode> {
    return new Map(this.#nodes);
  }

  /** Names cancelled by a steer. Cancelled nodes stay in the graph, terminal. */
  cancelled(): ReadonlySet<string> {
    return this.#cancelled;
  }

  /**
   * Apply a batch of edits atomically. The whole batch is validated against a
   * copy of the graph — structural rules first (unknown names, duplicate adds,
   * dangling consumers, cycles: the live toposort), then every attached
   * executor guard (the arrow of time: no edit touches crystallized work).
   * Any refusal throws a `STEER` `LoopError` and nothing applies; success
   * mutates the graph, bumps the version, and notifies subscribers.
   */
  apply(edits: readonly PlanEdit[]): PlanChange {
    if (!edits.length) throw steerError(this.name, 'empty edit batch');
    const next = new Map(this.#nodes);
    const nextCancelled = new Set(this.#cancelled);
    for (const edit of edits) {
      switch (edit.op) {
        case 'add': {
          if (next.has(edit.name))
            throw steerError(this.name, `add: node "${edit.name}" already exists`);
          let node: DagNode;
          if (edit.node) {
            node = normalize(edit.node);
          } else if (edit.template) {
            const template = this.#templates.get(edit.template);
            if (!template)
              throw steerError(
                this.name,
                `add: unknown template "${edit.template}" (registered: ${[...this.#templates.keys()].join(', ') || 'none'})`,
              );
            node = normalize(template(edit.params));
            if (edit.needs) node = { ...node, needs: [...edit.needs] };
            if (edit.priority !== undefined)
              node = { ...node, priority: edit.priority };
          } else {
            throw steerError(
              this.name,
              `add: node "${edit.name}" needs a "node" (in-process) or a "template" (out-of-process)`,
            );
          }
          if (typeof node.job !== 'function')
            throw steerError(
              this.name,
              `add: node "${edit.name}" has no runnable job — a JSON steer must use a registered template`,
            );
          next.set(edit.name, node);
          break;
        }
        case 'remove': {
          if (!next.has(edit.name))
            throw steerError(this.name, `remove: unknown node "${edit.name}"`);
          next.delete(edit.name);
          nextCancelled.delete(edit.name);
          break;
        }
        case 'rewire': {
          const node = next.get(edit.name);
          if (!node)
            throw steerError(this.name, `rewire: unknown node "${edit.name}"`);
          next.set(edit.name, { ...node, needs: [...edit.needs] });
          break;
        }
        case 'cancel': {
          if (!next.has(edit.name))
            throw steerError(this.name, `cancel: unknown node "${edit.name}"`);
          nextCancelled.add(edit.name);
          break;
        }
        case 'reprioritise': {
          const node = next.get(edit.name);
          if (!node)
            throw steerError(
              this.name,
              `reprioritise: unknown node "${edit.name}"`,
            );
          next.set(edit.name, { ...node, priority: edit.priority });
          break;
        }
      }
    }
    validateGraph(this.name, next, nextCancelled);
    for (const guard of this.#guards) {
      const veto = guard(edits);
      if (veto) throw steerError(this.name, veto);
    }
    this.#nodes = next;
    this.#cancelled = nextCancelled;
    this.#version += 1;
    const change: PlanChange = { version: this.#version, edits };
    for (const listener of this.#listeners) listener(change);
    return change;
  }

  /** Attach an executor guard; returns a detach function. */
  attachGuard(guard: PlanGuard): () => void {
    this.#guards.add(guard);
    return () => this.#guards.delete(guard);
  }

  /** Subscribe to accepted batches; returns an unsubscribe function. */
  subscribe(listener: PlanListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** Build a live plan (and register it for out-of-process steering). */
export function livePlan(config: LivePlanConfig): LivePlan {
  return new LivePlan(config);
}
