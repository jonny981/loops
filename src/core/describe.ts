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

interface NodeMeta {
  name: string;
  needs?: string[];
  isolate?: boolean;
  job?: JobMeta;
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
      const max = typeof meta.max === 'number' ? ` (max ${meta.max})` : '';
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
        if (node.isolate) bits.push('isolated');
        out.push(`${indent}  - ${node.name}${bits.length ? ` (${bits.join('; ')})` : ''}`);
        out.push(...renderPlan(node.job, `${indent}      `));
      }
      break;
    }
    case 'agent':
      out.push(`${indent}agent${nm}${meta.ground ? ' (grounded)' : ''}`);
      break;
    case 'fn':
      out.push(`${indent}fn${nm}`);
      break;
    default:
      out.push(`${indent}${meta.kind}${nm}`);
  }
  return out;
}
