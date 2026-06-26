/**
 * Consolidation — the "sleep-time" step (Letta's reflection, DiffMem's consolidate).
 * A long run accumulates many milestone commits; consolidation folds them into one
 * bounded CONSOLIDATED LEDGER: the current state, the open threads, and every binding
 * decision preserved. It is the COARSE tier of the ledger — `ledger.md` is the fine
 * tier and the milestone commit bodies are the mid tier, so multi-granularity falls
 * out of git rather than a new artifact to maintain.
 *
 * It is decision-PRESERVING, not a progress summary: a fresh context must be able to
 * honour every convention and constraint the project settled, so consolidation keeps
 * exact values verbatim while dropping narrative. (A naive summary that compresses
 * the decisions away lets downstream work silently violate them — measured: top-k
 * retrieval and a progress summary both miss accrued decisions; only a decision-
 * preserving ledger keeps them in bounded space.)
 *
 * The consolidated ledger is a COMMIT BODY, not a tracked file — the same shape as
 * every other memory in loops (welded to a diff, read back by grounding). Each
 * consolidation commits the updated ledger as the body of an empty-tree commit, so
 * grounding and retrieval surface it like any milestone; the prior ledger is read
 * back from the last consolidation commit's body. One model call that MERGES new
 * commits into the prior ledger, not a changelog.
 */

import type { Job, JobContext, Outcome, Workspace } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { log, commit } from './git.ts';
import { LoopError } from './errors.ts';
import { readPrompt, readLedger } from './draft.ts';

const CONSOLIDATE_SYSTEM =
  "You maintain a project's CONSOLIDATED LEDGER from its commit history — the bounded " +
  'coarse memory a fresh context reads to continue safely. Capture the current state ' +
  'and the open threads, and PRESERVE every binding decision, convention and constraint ' +
  'with its exact values verbatim (downstream work must honour them, so dropping or ' +
  'generalising even one is a failure). Tight markdown; MERGE new commits into the ' +
  'prior ledger, deduplicate, omit only narrative — never omit a decision.';

export interface ConsolidateOptions {
  /** Recent milestones to fold in. Default 30. */
  max?: number;
  /**
   * Exclusive lower bound — fold only commits after this ref (e.g. the base
   * branch). This scopes the fold to one line of work, exactly the set a squash
   * merge collapses, so the consolidation can stand in as the squash body.
   */
  since?: string;
  /** The consolidated ledger so far, to update in place. */
  prior?: string;
  /** Engine for the (one) consolidation call. Default the run engine. */
  engine?: EngineRef;
  model?: string;
}

/** A compact, heading-stripped snippet of a commit body — the decision content, not
 *  the "## Why" heading a naive first-line grab would return. */
function digest(body: string, n = 280): string {
  const text = body
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? `${text.slice(0, n).trimEnd()}…` : text;
}

/**
 * Fold the recent history into one decision-preserving consolidated ledger (a single
 * model call). Returns the ledger text; the caller decides where it lives (see
 * `consolidateJob`). Each commit is offered as its subject plus a body digest, so the
 * exact decisions — not just the headings — reach the consolidation.
 */
export async function consolidate(
  ctx: JobContext,
  opts: ConsolidateOptions = {},
): Promise<string> {
  const records = await log({
    cwd: ctx.workspace.dir,
    max: opts.max ?? 30,
    since: opts.since,
    signal: ctx.signal,
  });
  const entries = records
    .map(
      (r) =>
        `- ${r.sha.slice(0, 7)} ${r.subject}${r.body ? `\n  ${digest(r.body)}` : ''}`,
    )
    .join('\n');

  const engine = opts.engine ? ctx.resolveEngine(opts.engine) : ctx.engine;
  const result = await engine.run(
    {
      prompt:
        (opts.prior ? `CURRENT LEDGER:\n${opts.prior}\n\n` : '') +
        `COMMITS (newest first):\n${entries || '(none)'}\n\n` +
        `Output the updated consolidated ledger.`,
      system: CONSOLIDATE_SYSTEM,
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
// milestone commits into a consolidated ledger, `compactLedger` compresses ONE run's verbose
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
  /**
   * The size budget for the working log in the commit body. A log already within
   * it is kept VERBATIM (no model call); only a longer one is compacted, with this
   * as the truncation fallback. Default 2000.
   */
  maxChars?: number;
}

/**
 * Compress a verbose working log (the ledger) into a tight summary for the commit
 * body — one cheap model call. A short log (already within `maxChars`) is kept
 * verbatim: compaction only earns its keep on a long log, and summarising a few
 * lines just risks dropping the faithful "way" the commit body exists to preserve.
 * Falls back to truncation when there is no usable reply or the call throws, so a
 * commit never fails on compaction. '' in, '' out.
 */
export async function compactLedger(
  ctx: JobContext,
  text: string,
  opts: CompactOptions = {},
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const max = opts.maxChars ?? 2000;
  // Already within budget — keep it verbatim, faithful, and spend no model call.
  if (trimmed.length <= max) return trimmed;
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
  /** Commit subject; also how the prior ledger is found. Default `consolidate: ledger`. */
  subject?: string;
}

/**
 * Consolidate and commit the CONSOLIDATED LEDGER as a commit body. Reads the prior
 * ledger from the last consolidation commit's body, folds in the recent history, and
 * commits the updated ledger as the body of an empty-tree commit — so the coarse
 * memory is durable and grounded-on like any milestone, never a tracked file.
 */
export function consolidateJob(config: ConsolidateJobConfig = {}): Job {
  return async (ctx) => {
    const label = config.label ?? 'consolidate';
    const subject = config.subject ?? 'consolidate: ledger';
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
    try {
      // The prior ledger is the body of the most recent consolidation commit — the
      // consolidated ledger lives in git's memory (commit bodies), not a tracked file.
      const recent = await log({ cwd: ctx.workspace.dir, max: 50, signal: ctx.signal });
      const prior = recent.find((r) => r.subject === subject)?.body || undefined;
      const ledger = await consolidate(ctx, { ...config, prior });
      const sha = await commit(
        { subject, body: ledger, allowEmpty: true },
        { cwd: ctx.workspace.dir, signal: ctx.signal },
      );
      const outcome: Outcome = {
        status: 'pass',
        summary: sha ? `ledger ${sha.slice(0, 7)}` : 'ledger unchanged',
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
