/**
 * Consolidation — the "sleep-time" / roadmap step (Letta's reflection, DiffMem's
 * consolidate). A long run accumulates many milestone commits; consolidation
 * folds them into a concise, rolling ROADMAP: what is done, the current state,
 * the open threads. That roadmap is the COARSE level of memory — the milestone
 * commits are the mid level and the draft is the fine level, so multi-granularity
 * falls out of git rather than a new tier to maintain.
 *
 * It is a committed file (`LEDGER.md` by default), so it is durable and the
 * retrieval grounding can surface it like any other commit. Small on purpose: one
 * model call that MERGES new milestones into the prior roadmap, not a changelog.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Job, JobContext, Outcome } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { log, stageAll, commit } from './git.ts';
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
  /** Roadmap file, relative to the workspace. Default `LEDGER.md`. */
  file?: string;
  /** Commit subject. Default `docs(ledger): roadmap`. */
  subject?: string;
}

/**
 * Consolidate and commit the roadmap. Reads the prior roadmap from `file`, folds
 * in the recent ledger, writes it back, and commits — so the coarse memory is
 * durable and grounded-on like any milestone.
 */
export function consolidateJob(config: ConsolidateJobConfig = {}): Job {
  return async (ctx) => {
    const label = config.label ?? 'consolidate';
    const path = [...ctx.path];
    const file = config.file ?? 'LEDGER.md';
    const abs = join(ctx.workspace.dir, file);
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
    try {
      let prior: string | undefined;
      try {
        prior = readFileSync(abs, 'utf8');
      } catch {
        /* first roadmap */
      }
      const roadmap = await consolidate(ctx, { ...config, prior });
      writeFileSync(abs, `${roadmap}\n`);
      await stageAll({ cwd: ctx.workspace.dir, signal: ctx.signal });
      const sha = await commit(
        { subject: config.subject ?? 'docs(ledger): roadmap', body: '' },
        { cwd: ctx.workspace.dir, signal: ctx.signal },
      );
      const outcome: Outcome = {
        status: 'pass',
        summary: sha ? `roadmap ${sha.slice(0, 7)}` : 'roadmap unchanged',
        data: { sha: sha ?? null, file },
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
