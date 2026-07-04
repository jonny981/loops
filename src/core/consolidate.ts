/**
 * Consolidation folds a long run's many milestone commits into one bounded
 * consolidated ledger: the current state, the open threads, and every binding
 * decision. It is the coarse tier of the ledger; `ledger.md` is the fine tier and the
 * milestone commit bodies are the mid tier, so multi-granularity comes from git rather
 * than a new artifact.
 *
 * It is decision-preserving, not a progress summary: a fresh context must be able to
 * honour every convention and constraint the project settled, so consolidation keeps
 * exact values verbatim while dropping narrative. A naive summary that compresses the
 * decisions away lets downstream work silently violate them.
 *
 * The consolidated ledger is a commit body, not a tracked file, the same shape as
 * every other memory in loops (welded to a diff, read back by grounding). Each
 * consolidation commits the updated ledger as the body of an empty-tree commit, so
 * grounding and retrieval surface it like any milestone; the prior ledger is read
 * back from the last consolidation commit's body. One model call that merges new
 * commits into the prior ledger, not a changelog.
 */

import type { Job, JobContext, Outcome, Workspace } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { log, commit } from './git.ts';
import { LoopError } from './errors.ts';
import { readPrompt, readLedger } from './draft.ts';
import { truncate } from './text.ts';

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
   * Exclusive lower bound: fold only commits after this ref (e.g. the base
   * branch). Scopes the fold to one line of work, the set a squash merge
   * collapses, so the consolidation can stand in as the squash body.
   */
  since?: string;
  /** The consolidated ledger so far, to update in place. */
  prior?: string;
  /** Engine for the (one) consolidation call. Default the run engine. */
  engine?: EngineRef;
  model?: string;
}

/** A heading-stripped snippet of a commit body: the decision content, not the
 *  "## Why" heading a naive first-line grab would return. */
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
 * Fold recent history into one decision-preserving consolidated ledger (a single
 * model call). Returns the ledger text; the caller decides where it lives (see
 * `consolidateJob`). Each commit is offered as its subject plus a body digest, so the
 * exact decisions, not just the headings, reach the consolidation.
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
// milestone commits into a consolidated ledger, `compactLedger` compresses one
// run's verbose working log (`ledger.md`) into the summary that rides in the
// commit body.

const COMPACT_SYSTEM =
  'You write the HANDOFF a future agent reads if it lost ALL memory of this work. Include ' +
  'EVERYTHING it needs to continue safely, as structured markdown: ## Why (the problem and ' +
  'the root cause), ## What (exactly what changed, and where — names, paths, signatures), ' +
  '## Alternatives (what was ruled out and why), ## Constraints (the invariants and limits ' +
  'that shaped it), ## Next (what is left or to watch). Preserve every decision and specific ' +
  'value verbatim. Completeness matters more than brevity — drop only literal repetition and ' +
  'play-by-play narration, never a decision or a detail. Omit a section only if it truly has ' +
  'nothing. No preamble.';

export interface CompactOptions {
  engine?: EngineRef;
  model?: string;
  /**
   * The size budget for the working log in the commit body. A log already within
   * it is kept verbatim (no model call); only a longer one is compacted, with this
   * as the truncation fallback. Default 2000.
   */
  maxChars?: number;
}

/**
 * Compress a verbose working log (the ledger) into a summary for the commit body,
 * one cheap model call. A short log (already within `maxChars`) is kept verbatim:
 * compaction only earns its keep on a long log, and summarising a few lines risks
 * dropping detail the commit body exists to preserve. Falls back to truncation when
 * there is no usable reply or the call throws, so a commit never fails on
 * compaction. '' in, '' out.
 */
export async function compactLedger(
  ctx: JobContext,
  text: string,
  opts: CompactOptions = {},
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const max = opts.maxChars ?? 2000;
  // Already within budget: keep it verbatim, spend no model call.
  if (trimmed.length <= max) return trimmed;
  try {
    const engine = opts.engine ? ctx.resolveEngine(opts.engine) : ctx.engine;
    const result = await engine.run(
      {
        prompt: `WORKING LOG:\n${trimmed}\n\nWrite the complete handoff.`,
        system: COMPACT_SYSTEM,
        model: opts.model,
        maxTokens: 1200,
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
 * Compose the commit body, the handoff: everything the next agent needs if it lost
 * all memory of this work. Two sources: the agent's own handoff (captured verbatim by
 * the handoff contract into `prompt.md`), else a structured handoff distilled from the
 * working log. The second path is the guarantee: loops owns the commit step, so a
 * terse, instruction-skipping agent still leaves a structured record rather than a
 * bare "done". Returns '' only when there is nothing at all, so callers fall back to
 * their floor.
 */
export async function composeCommitBody(
  ctx: JobContext,
  workspace: Workspace,
  opts: CompactOptions = {},
): Promise<string> {
  // Distill from the agent's own handoff and the working log as one body of material:
  // a terse self-handoff must not shadow the richer working log (the agent narrates
  // the work but writes a one-line handoff), and a silent agent still gets a
  // structured record from its log. Short material is kept verbatim.
  const material = [readPrompt(workspace), readLedger(workspace)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
  return material ? await compactLedger(ctx, material, opts) : '';
}

export interface ConsolidateJobConfig extends ConsolidateOptions {
  label?: string;
  /** Commit subject; also how the prior ledger is found. Default `consolidate: ledger`. */
  subject?: string;
}

/**
 * Consolidate and commit the consolidated ledger as a commit body. Reads the prior
 * ledger from the last consolidation commit's body, folds in recent history, and
 * commits the updated ledger as the body of an empty-tree commit, so the coarse
 * memory is durable and grounded-on like any milestone, never a tracked file.
 */
export function consolidateJob(config: ConsolidateJobConfig = {}): Job {
  return async (ctx) => {
    const label = config.label ?? 'consolidate';
    const subject = config.subject ?? 'consolidate: ledger';
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
    try {
      // The prior ledger is the body of the most recent consolidation commit; the
      // consolidated ledger lives in commit bodies, not a tracked file.
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
