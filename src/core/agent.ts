/**
 * AgentDef — a reusable, job-specific agent definition. The persona and methodology
 * (the prose: `system`, skill `instructions`) live in editable markdown files; the
 * structure and types live here in TypeScript. The `.ts` is the strongly-typed wrapper
 * around the `.md` — author the prompt as markdown, get type safety and validation in code.
 *
 * Grounded in the amps-os agent profile, minus the amps-specific machinery loops already
 * provides: `dag` is the dispatcher, `conditions`/`quorum` are the gates, `Outcome` is the
 * result channel. So AgentDef is just the contract — who the agent is, what it may touch,
 * how it works — that `agentJob` resolves into an engine request.
 */

import { readFileSync } from 'node:fs';

/** A skill is a METHODOLOGY (how to do the work — TDD, writing-plans), not a worker.
 *  An agent composes skills; a skill never dispatches an agent. */
export interface Skill {
  name: string;
  /** The methodology instructions — prepended to the agent's system when it applies them. */
  instructions: string;
}

export interface AgentDef {
  /** Identity (also the default job label). */
  name: string;
  /** What and why — for humans, docs, and (if loops scales) discovery. */
  description?: string;
  /** The system prompt: who the agent is and how it works. Use `fromFile('x.md')`. */
  system: string;
  /** Model id; omitted = inherit the run default. */
  model?: string;
  /** Allowed tool names — the permission boundary. */
  tools?: string[];
  /**
   * Mark this agent a leaf: it may not spawn sub-agents / fan out (the engine disallows
   * the sub-agent tool). Use it to control where a branch of the graph bottoms out — to
   * stop a thorough agent from quietly expanding into a slow, expensive swarm.
   */
  leaf?: boolean;
  /** Structured job descriptions (not prose) — for discovery / docs. */
  capabilities?: string[];
  /** Methodologies the agent applies; their instructions are folded into the system. */
  skills?: Skill[];
  /** Named failure modes + their recovery — first-class contracts, not buried prose. */
  failureModes?: { mode: string; recovery: string }[];
}

/** Read a markdown file as a string — for `system` or skill `instructions`. Pass an
 *  absolute path, or `new URL('./x.md', import.meta.url)` for a path relative to the file. */
export function fromFile(path: string | URL): string {
  return readFileSync(path, 'utf8').trim();
}

/** Define a skill (a methodology). Identity + validation; strongly typed. */
export function defineSkill(skill: Skill): Skill {
  if (!skill.name) throw new Error('defineSkill: `name` is required');
  if (!skill.instructions?.trim()) throw new Error(`defineSkill "${skill.name}": empty instructions`);
  return skill;
}

/** Define an agent. Identity + validation; strongly typed (the wrapper around the md). */
export function defineAgent(def: AgentDef): AgentDef {
  if (!def.name) throw new Error('defineAgent: `name` is required');
  if (!def.system?.trim()) throw new Error(`defineAgent "${def.name}": empty system prompt`);
  def.skills?.forEach((s) => defineSkill(s));
  return def;
}

/**
 * Resolve an agent's system prompt, folding in its skills' methodologies. This is what
 * `agentJob` hands the engine as `system`.
 */
export function resolveSystem(agent: AgentDef): string {
  if (!agent.skills?.length) return agent.system;
  const methods = agent.skills
    .map((s) => `### ${s.name}\n\n${s.instructions.trim()}`)
    .join('\n\n');
  return `${agent.system.trim()}\n\n## Methodologies you apply\n\n${methods}`;
}
