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

import type { Job, JobContext, Outcome, Workspace } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { log, commit } from './git.ts';
import { LoopError } from './errors.ts';
import { readPrompt, readLedger } from './draft.ts';

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

// ── Fine-grained compaction (the commit body) ───────────────────────────────
// The same fold, one scale down: where `consolidate` compresses a stream of
// milestone commits into a roadmap, `compactLedger` compresses ONE run's verbose
// working log (`ledger.md`) into the tight summary that rides in the commit body.

const COMPACT_SYSTEM =
  'You compress a verbose working log into a few tight lines for the next agent: ' +
  'what was done and why, what was ruled out, what is left. Drop the play-by-play; ' +
  'keep only what someone continuing the work needs. Output short markdown, no preamble.';

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}\n…` : t;
}

export interface CompactOptions {
  engine?: EngineRef;
  model?: string;
  /** Truncation fallback length when the model call is skipped or fails. Default 2000. */
  maxChars?: number;
}

/**
 * Compress a verbose working log (the ledger) into a tight summary for the commit
 * body — one cheap model call. Falls back to truncation when there is no usable
 * reply or the call throws, so a commit never fails on compaction. '' in, '' out.
 */
export async function compactLedger(
  ctx: JobContext,
  text: string,
  opts: CompactOptions = {},
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const max = opts.maxChars ?? 2000;
  try {
    const engine = opts.engine ? ctx.resolveEngine(opts.engine) : ctx.engine;
    const result = await engine.run(
      {
        prompt: `WORKING LOG:\n${trimmed}\n\nOutput the compact summary.`,
        system: COMPACT_SYSTEM,
        model: opts.model,
        maxTokens: 600,
      },
      () => {},
      ctx.signal,
    );
    return result.text.trim() || truncate(trimmed, max);
  } catch {
    return truncate(trimmed, max);
  }
}

/**
 * Compose a commit body from a workspace's scratch files: the handoff (`prompt.md`)
 * verbatim, then a compacted working log (`ledger.md`). The handoff is already
 * curated, so it is not re-summarised; only the verbose ledger is folded. Returns ''
 * when both are empty, so callers can fall back to their own floor.
 */
export async function composeCommitBody(
  ctx: JobContext,
  workspace: Workspace,
  opts: CompactOptions = {},
): Promise<string> {
  const prompt = readPrompt(workspace);
  const ledgerRaw = readLedger(workspace);
  const ledger = ledgerRaw ? await compactLedger(ctx, ledgerRaw, opts) : '';
  const parts: string[] = [];
  if (prompt) parts.push(prompt);
  if (ledger) parts.push(`## Working log\n\n${ledger}`);
  return parts.join('\n\n');
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
