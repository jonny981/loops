/**
 * Amps glue (NOT part of the agnostic loops core): load a Claude Code agent or
 * skill markdown file and run it as a loops.js `agentJob`.
 *
 * The insight is that a `.claude/agents/<name>.md` (or a `SKILL.md`) is just a
 * system prompt + a model/tool config. So loops.js can run the SAME hard-won
 * agents Claude Code's Task tool runs — loops.js becomes the orchestrator that
 * fans out to single-agent leaves, which is exactly what the orchestration
 * discipline requires (a dispatched leaf must never fan out further).
 */

import { readFileSync } from 'node:fs';

import { agentJob, type AgentJobConfig } from '../../src/api.ts';

interface Def {
  name: string;
  /** The markdown body — the agent/skill's system prompt, verbatim. */
  system: string;
  model?: string;
  /** Parsed from the frontmatter `tools:` list, if present. */
  allowedTools?: string[];
}

/** Minimal frontmatter split. Agent/skill frontmatter is simple `key: value`. */
function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { data: {}, body: raw.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) data[key] = val;
  }
  return { data, body: m[2]!.trim() };
}

/** Load an agent/skill definition file into `{ system, model, allowedTools }`. */
export function loadDef(path: string): Def {
  const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const tools = data.tools;
  return {
    name: data.name || path,
    system: body,
    model: data.model || undefined,
    allowedTools: tools
      ? tools
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined,
  };
}

/**
 * Build an `agentJob` that runs an agent definition as its system prompt via the
 * claude-cli engine (which loads the project's CLAUDE.md / skills / references
 * from `cwd` natively). `dropTools` defaults to removing the dispatch tools, so
 * a leaf structurally cannot fan out — it runs its stage inline, as required.
 */
export function agentJobFromDef(
  path: string,
  prompt: AgentJobConfig['prompt'],
  extra: Partial<AgentJobConfig> & { dropTools?: string[] } = {},
): ReturnType<typeof agentJob> {
  const def = loadDef(path);
  const { dropTools = ['Task', 'Agent'], ...jobExtra } = extra;
  const allowedTools = def.allowedTools?.filter((t) => !dropTools.includes(t));
  return agentJob({
    label: def.name,
    engine: 'claude-cli',
    system: def.system,
    model: def.model,
    allowedTools,
    prompt,
    ...jobExtra,
  });
}
