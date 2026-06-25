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

import { log, type CommitRecord } from './git.ts';
import type { JobContext, Workspace } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';

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

// ── Retrieval grounding ─────────────────────────────────────────────────────
// Recent-N grounding is noisy when the branch log carries unrelated work (e.g. a
// shared monorepo). Retrieval fixes that the way DiffMem/GCC do — selectively —
// but stays in the git grain: a cheap model reads the candidate commit SUBJECTS
// and picks the shas relevant to the task; only those bodies are injected. No
// embeddings, no index file — git's own log IS the index.

export interface RetrieveOptions {
  /** The task/intent to find relevant prior commits for. */
  intent: string;
  /**
   * The recall window: how many recent commits to offer the selector as
   * candidates. A relevant commit OLDER than this is invisible — retrieval is not
   * unbounded, it just has a bigger window than recent-N. Reading subjects is
   * cheap, so this can be generous. For a log longer than any practical window,
   * run consolidation: the rolling roadmap commit stays in-window and indexes the
   * old history. Default 100.
   */
  candidates?: number;
  /** Max commits to inject. Default 8. */
  max?: number;
  /** Truncate each injected body. Default 1200. */
  bodyChars?: number;
  /** Engine for the (cheap) selection call. Default the run engine. */
  engine?: EngineRef;
  /** Model for the selection call (a small one is plenty). */
  model?: string;
}

const SELECT_SYSTEM =
  'You select which past commits are relevant CONTEXT for a task. Be selective: ' +
  'return only genuinely relevant commits, fewer is better. Output ONLY shas, ' +
  'comma-separated, most relevant first — or the single word NONE.';

/** Match the model's reply back to candidate commits, preserving its order. */
function pickShas(text: string, records: CommitRecord[]): CommitRecord[] {
  const ids = text.toLowerCase().match(/[0-9a-f]{7,40}/g) ?? [];
  const out: CommitRecord[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const rec = records.find((r) => r.sha.startsWith(id));
    if (rec && !seen.has(rec.sha)) {
      seen.add(rec.sha);
      out.push(rec);
    }
  }
  return out;
}

/**
 * Render only the prior commits a cheap model judges relevant to `intent`.
 * Returns '' when nothing is on the branch or nothing is judged relevant.
 */
export async function retrieveLedger(
  ctx: JobContext,
  opts: RetrieveOptions,
): Promise<string> {
  const records = await log({
    cwd: ctx.workspace.dir,
    max: opts.candidates ?? 100,
    signal: ctx.signal,
  });
  if (!records.length) return '';

  const list = records
    .map((r) => `${r.sha.slice(0, 9)}: ${r.subject}`)
    .join('\n');
  const engine = opts.engine ? ctx.resolveEngine(opts.engine) : ctx.engine;
  const result = await engine.run(
    {
      prompt:
        `TASK:\n${opts.intent}\n\n` +
        `CANDIDATE COMMITS (sha: subject):\n${list}\n\n` +
        `Return the shas relevant to the TASK (up to ${opts.max ?? 8}), or NONE.`,
      system: SELECT_SYSTEM,
      model: opts.model,
      maxTokens: 200,
    },
    () => {},
    ctx.signal,
  );

  const picked = pickShas(result.text, records).slice(0, opts.max ?? 8);
  if (!picked.length) return '';

  const where = ctx.workspace.branch ? `\`${ctx.workspace.branch}\`` : 'this branch';
  const header =
    `## Relevant prior work on ${where} (retrieved for this task)\n` +
    `Commits a search judged relevant — read them before working.`;
  const bodyChars = opts.bodyChars ?? 1200;
  const entries = picked.map((r) => {
    const head = `### ${r.sha.slice(0, 7)}  ${r.subject}`;
    return r.body ? `${head}\n\n${truncate(r.body, bodyChars)}` : head;
  });
  return `${header}\n\n${entries.join('\n\n')}`;
}
