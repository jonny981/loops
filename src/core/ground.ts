/**
 * The read side — grounding. Where the draft carries the within-iteration why,
 * grounding carries the cross-iteration memory: before a fresh context does
 * work, it reads the recent commit log so it knows what prior iterations already
 * tried and why, and does not re-walk a dead end. This is the half of the
 * fresh-context bet that kills amnesia (the other half being that fresh context
 * kills rot).
 *
 * The reach is deliberately BRANCH-LOCAL. `git log` on the current branch is the
 * committed truth of this line of work; adjacent active branches are in-flight
 * and may never land, so grounding on them feeds the agent premises that can
 * vanish. When a sibling team's work matters, it lands back into this line and
 * grounding then picks it up naturally — the merge is where work becomes shared
 * truth. Cross-branch awareness, if ever wanted, is a separate, thin, opt-in
 * signal, not this read.
 */

import { log } from './git.ts';
import type { Workspace } from './types.ts';

export interface GroundOptions {
  /**
   * Exclusive lower bound: only commits after this ref. Pass the loop's start
   * ref to scope the ledger to "this run". Omitted reads recent branch history.
   */
  since?: string;
  /** Max commits to include (newest first). Default 10. */
  max?: number;
  /** Truncate each commit body to this many chars, so the ledger never re-rots
   *  the fresh context. Default 1200. */
  bodyChars?: number;
  signal?: AbortSignal;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}\n…` : s;
}

/**
 * Render the recent ledger as a prompt block for the next fresh context. Returns
 * '' when there is nothing yet (a first iteration on a fresh branch), so callers
 * can prepend it unconditionally. Newest commit first.
 */
export async function groundingText(
  workspace: Workspace,
  opts: GroundOptions = {},
): Promise<string> {
  const records = await log({
    cwd: workspace.dir,
    since: opts.since,
    max: opts.max ?? 10,
    signal: opts.signal,
  });
  if (!records.length) return '';

  const where = workspace.branch ? `\`${workspace.branch}\`` : 'this branch';
  const header =
    `## Recent work on ${where} (the ledger)\n` +
    `What prior iterations already did and why — read it before working so you ` +
    `do not repeat a dead end. Most recent first.`;

  const bodyChars = opts.bodyChars ?? 1200;
  const entries = records.map((r) => {
    const head = `### ${r.sha.slice(0, 7)}  ${r.subject}`;
    return r.body ? `${head}\n\n${truncate(r.body, bodyChars)}` : head;
  });

  return `${header}\n\n${entries.join('\n\n')}`;
}
