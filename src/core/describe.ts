/**
 * Job introspection. The builders register a `JobMeta` for the `Job` they return
 * (and a short label for the conditions they build) in a side table, so a loop's
 * shape can be read back without running it. This is what powers `loops validate`
 * and `loops describe`: an agent authors a loop, then sees what it actually built.
 *
 * Kept in `WeakMap`s rather than on the function objects, so the `Job`/`Condition`
 * types stay plain functions and nothing downstream has to know meta exists.
 */

import type { Job, JobMeta, ConditionInput } from './types.ts';
import type { AgentContractSummary } from './agent.ts';

const META = new WeakMap<object, JobMeta>();
const LABEL = new WeakMap<object, string>();

/** Register a Job's shape and return the same Job (used inline at a builder's return). */
export function setMeta<T extends object>(target: T, meta: JobMeta): T {
  META.set(target, meta);
  return target;
}

/** Read a Job's registered shape, if it has one (a hand-written Job has none). */
export function jobMeta(job: Job): JobMeta | undefined {
  return typeof job === 'function' ? META.get(job) : undefined;
}

/** Register a one-line label for a condition (used by the gate-describing path). */
export function setLabel<T extends object>(cond: T, label: string): T {
  LABEL.set(cond, label);
  return cond;
}

function condLabel(input: unknown): string {
  if (typeof input === 'function') {
    const l = LABEL.get(input);
    if (l) return l;
  }
  return 'check';
}

/** Flatten a gate input (`until`/`start`/`stopOn`) into one label per condition. */
export function describeConditions(input?: ConditionInput): string[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input.flatMap(describeConditions);
  return [condLabel(input)];
}

const count = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Per-node shape `dag()` writes into its meta's `nodes` array. */
export interface NodeMeta {
  name: string;
  needs?: string[];
  isolate?: boolean;
  optional?: boolean;
  /** Condition labels for the node's `when` gate, when one is configured. */
  when?: string[];
  job?: JobMeta;
}

// `meta.contract` is only ever set by `agentJob` to the value `agentContract()`
// produced — a clean `AgentContractSummary` with empty fields already dropped. So
// read it back as that type rather than re-normalising a shape the core built (the
// `--json` path already emits it verbatim). A hand-written job has no contract.
function renderContract(value: unknown): string | undefined {
  const c = value as AgentContractSummary | undefined;
  if (!c || typeof c !== 'object') return undefined;
  const bits: string[] = [];
  if (c.tier) bits.push(`tier ${c.tier}`);
  if (c.outputs?.length) bits.push(`outputs ${c.outputs.join(', ')}`);
  if (c.capabilities?.length) bits.push(`capabilities ${c.capabilities.join(', ')}`);
  if (c.requiresSkills?.length) bits.push(`requires ${c.requiresSkills.join(', ')}`);
  if (c.usesSkills?.length) bits.push(`uses ${c.usesSkills.join(', ')}`);
  if (c.humanGates?.length) bits.push(`gates ${c.humanGates.join(', ')}`);
  if (c.failureModes?.length) bits.push(`failure modes ${c.failureModes.join(', ')}`);
  return bits.join('; ');
}

/**
 * Render a `JobMeta` tree to indented lines: the loop's name and cap, its gate
 * and convergence actions, and its body / dag nodes recursively. A Job with no
 * meta (hand-written) renders as a single opaque line.
 */
export function renderPlan(meta: JobMeta | undefined, indent = ''): string[] {
  if (!meta) return [`${indent}(a runnable job, shape not introspectable)`];
  const nm = meta.name ? ` "${meta.name}"` : '';
  const out: string[] = [];
  switch (meta.kind) {
    case 'loop': {
      const caps: string[] = [];
      if (typeof meta.max === 'number') caps.push(`max ${meta.max}`);
      if (typeof meta.noProgress === 'number')
        caps.push(`stall after ${meta.noProgress} flat`);
      const max = caps.length ? ` (${caps.join('; ')})` : '';
      out.push(`${indent}loop${nm}${max}`);
      const start = meta.start as string[] | undefined;
      const gate = meta.gate as string[] | undefined;
      const stopOn = meta.stopOn as string[] | undefined;
      if (start?.length) out.push(`${indent}  start: ${start.join(', ')}`);
      if (gate?.length) out.push(`${indent}  gate: ${gate.join(', ')}`);
      if (stopOn?.length) out.push(`${indent}  stopOn: ${stopOn.join(', ')}`);
      const tail = [meta.review ? 'review' : null, meta.commit ? 'commit' : null].filter(Boolean);
      if (tail.length) out.push(`${indent}  on convergence: ${tail.join(' + ')}`);
      out.push(`${indent}  body:`);
      out.push(...renderPlan(meta.body as JobMeta | undefined, `${indent}    `));
      break;
    }
    case 'dag': {
      const nodes = (meta.nodes as NodeMeta[] | undefined) ?? [];
      out.push(`${indent}dag${nm} (${count(nodes.length, 'node')})`);
      for (const node of nodes) {
        const bits: string[] = [];
        if (node.needs?.length) bits.push(`needs ${node.needs.join(', ')}`);
        if (node.optional) bits.push('optional');
        if (node.when?.length) bits.push(`when: ${node.when.join(', ')}`);
        if (node.isolate) bits.push('isolated');
        out.push(`${indent}  - ${node.name}${bits.length ? ` (${bits.join('; ')})` : ''}`);
        out.push(...renderPlan(node.job, `${indent}      `));
      }
      break;
    }
    case 'agent':
      out.push(`${indent}agent${nm}${meta.ground ? ' (grounded)' : ''}`);
      {
        const contract = renderContract(meta.contract);
        if (contract) out.push(`${indent}  contract: ${contract}`);
      }
      break;
    case 'fn':
      out.push(`${indent}fn${nm}`);
      break;
    default:
      out.push(`${indent}${meta.kind}${nm}`);
  }
  return out;
}
