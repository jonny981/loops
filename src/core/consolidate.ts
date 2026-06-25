/**
 * Consolidation — the "sleep-time" / roadmap step (Letta's reflection, DiffMem's
 * consolidate). A long run accumulates many milestone commits; consolidation
 * folds them into a concise, rolling ROADMAP: what is done, the current state,
 * the open threads. That roadmap is the COARSE level of memory — the milestone
 * commits are the mid level and the draft is the fine level, so multi-granularity
 * falls out of git rather than a new tier to maintain.
 *
 * The roadmap is a COMMIT BODY, not a tracked file — the same shape as every other
 * memory in loops (a prompt, the "way", welded to a diff and read back by
 * grounding). Each consolidation commits the updated roadmap as the body of an
 * empty-tree commit, so grounding and retrieval surface it like any milestone; the
 * prior roadmap is read back from the last consolidation commit's body. Small on
 * purpose: one model call that MERGES new milestones into the prior roadmap, not a
 * changelog.
 */

import type { Job, JobContext, Outcome } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { log, commit } from './git.ts';
import { LoopError } from './errors.ts';

const ROADMAP_SYSTEM =
  'You maintain a concise project ROADMAP from a stream of milestone commits. ' +
  'Output short markdown: what is done, the current state, and the open threads. ' +
  'Keep it tight — it is the coarse memory, not a changelog. MERGE the new ' +
  'milestones into the prior roadmap; do not just append.';

export interface ConsolidateOptions {
  /** Recent milestones to fold in. Default 30. */
  max?: number;
  /** The roadmap so far, to update in place. */
  prior?: string;
  /** Engine for the (one) summarisation call. Default the run engine. */
  engine?: EngineRef;
  model?: string;
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim()) ?? '';
}

/**
 * Fold the recent ledger into a concise roadmap (one model call). Returns the
 * roadmap text; the caller decides where it lives (see `consolidateJob`).
 */
export async function consolidate(
  ctx: JobContext,
  opts: ConsolidateOptions = {},
): Promise<string> {
  const records = await log({
    cwd: ctx.workspace.dir,
    max: opts.max ?? 30,
    signal: ctx.signal,
  });
  const milestones = records
    .map(
      (r) =>
        `- ${r.sha.slice(0, 7)} ${r.subject}${r.body ? `: ${firstLine(r.body)}` : ''}`,
    )
    .join('\n');

  const engine = opts.engine ? ctx.resolveEngine(opts.engine) : ctx.engine;
  const result = await engine.run(
    {
      prompt:
        (opts.prior ? `CURRENT ROADMAP:\n${opts.prior}\n\n` : '') +
        `RECENT MILESTONES (newest first):\n${milestones || '(none)'}\n\n` +
        `Output the updated roadmap.`,
      system: ROADMAP_SYSTEM,
      model: opts.model,
      maxTokens: 1000,
    },
    () => {},
    ctx.signal,
  );
  return result.text.trim();
}

export interface ConsolidateJobConfig extends ConsolidateOptions {
  label?: string;
  /** Commit subject; also how the prior roadmap is found. Default `consolidate: roadmap`. */
  subject?: string;
}

/**
 * Consolidate and commit the roadmap AS A COMMIT BODY. Reads the prior roadmap from
 * the last consolidation commit's body, folds in the recent ledger, and commits the
 * updated roadmap as the body of an empty-tree commit — so the coarse memory is
 * durable and grounded-on like any milestone, never a tracked file.
 */
export function consolidateJob(config: ConsolidateJobConfig = {}): Job {
  return async (ctx) => {
    const label = config.label ?? 'consolidate';
    const subject = config.subject ?? 'consolidate: roadmap';
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
    try {
      // The prior roadmap is the body of the most recent consolidation commit —
      // the roadmap lives in git's memory (commit bodies), not a tracked file.
      const recent = await log({ cwd: ctx.workspace.dir, max: 50, signal: ctx.signal });
      const prior = recent.find((r) => r.subject === subject)?.body || undefined;
      const roadmap = await consolidate(ctx, { ...config, prior });
      const sha = await commit(
        { subject, body: roadmap, allowEmpty: true },
        { cwd: ctx.workspace.dir, signal: ctx.signal },
      );
      const outcome: Outcome = {
        status: 'pass',
        summary: sha ? `roadmap ${sha.slice(0, 7)}` : 'roadmap unchanged',
        data: { sha: sha ?? null },
      };
      ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
      return outcome;
    } catch (e) {
      const error = LoopError.from(e, { code: 'BODY', path: ctx.path });
      ctx.emit({
        kind: 'error',
        ts: Date.now(),
        path,
        message: error.message,
        code: error.code,
      });
      const outcome: Outcome = { status: 'fail', summary: error.message, error };
      ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
      return outcome;
    }
  };
}
