/**
 * Pull-request jobs — how a converged branch becomes a PR whose body stays a
 * faithful synthesis of the work, so the commit-log memory survives a squash merge.
 *
 * The squash-merge problem: a branch carries N milestone commits, each with a rich
 * structured "way" (the Ledger). A squash merge collapses them into one commit whose
 * body GitHub defaults to a list of subject lines — the reasoning is lost from the
 * base branch's history. The fix is small because loops already folds many commit
 * bodies into one: `pullRequestJob` sets the PR body to `consolidate(since: base)` —
 * the same decision-preserving fold, scoped to this branch — and keeps it current.
 * `mergeJob` can then squash with that synthesis as the commit body directly.
 *
 * Engine-agnostic and host-agnostic: the host is the injectable `Forge` seam
 * (default `GhForge`), so these jobs run offline against a `MockForge` in tests.
 */

import type { Job, JobContext, Outcome, ConditionInput } from './types.ts';
import { LoopError } from './errors.ts';
import { push } from './git.ts';
import { consolidate } from './consolidate.ts';
import { GhForge, type Forge, type PrRef } from './forge.ts';
import { toCondition } from './condition.ts';

/** Resolve the host: the run's `forge`, else the GitHub CLI adapter. */
function resolveForge(ctx: JobContext): Forge {
  return ctx.forge ?? new GhForge();
}

type Derive<T> =
  | T
  | ((ctx: JobContext, last: Outcome | undefined) => T | Promise<T>);

async function derive<T>(
  value: Derive<T> | undefined,
  ctx: JobContext,
  last: Outcome | undefined,
): Promise<T | undefined> {
  if (value === undefined) return undefined;
  return typeof value === 'function'
    ? await (value as (c: JobContext, l: Outcome | undefined) => T | Promise<T>)(
        ctx,
        last,
      )
    : value;
}

export interface PushJobConfig {
  label?: string;
  /** Remote to push to. Default `origin`. */
  remote?: string;
  /** Branch to push. Default the workspace branch. */
  branch?: string;
  /** Set upstream tracking. Default true. */
  setUpstream?: boolean;
  /** Force-with-lease. Default false. */
  force?: boolean;
}

/** Push the work branch to its remote. Idempotent; a rejected push fails honestly. */
export function pushJob(config: PushJobConfig = {}): Job {
  return async (ctx) => {
    const label = config.label ?? 'push';
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
    const branch = config.branch ?? ctx.workspace.branch;
    const res = await push({
      cwd: ctx.workspace.dir,
      signal: ctx.signal,
      remote: config.remote,
      branch,
      setUpstream: config.setUpstream,
      force: config.force,
    });
    const outcome: Outcome = res.ok
      ? { status: 'pass', summary: `pushed ${branch ?? 'HEAD'}` }
      : {
          status: 'fail',
          summary: `push failed: ${res.output}`,
          error: new LoopError({ code: 'BODY', message: res.output }),
        };
    ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
    return outcome;
  };
}

export interface PullRequestJobConfig {
  label?: string;
  /** PR title, or a function of context. Default: the converged outcome summary. */
  title?: Derive<string>;
  /** Base branch to merge into, and the `since` bound for the body fold. Default `main`. */
  base?: string;
  /** Push the branch first (idempotent). Default true; pass a config to tune. */
  push?: boolean | PushJobConfig;
  /** Open as a draft when first created. */
  draft?: boolean;
  /** Model for the body consolidation call. */
  model?: string;
  /** Max milestones to fold into the body. Default 50. */
  max?: number;
  /** Override the synthesized body (else: consolidate the branch's commit bodies). */
  body?: Derive<string>;
}

/**
 * Raise the PR, or update it if it already exists, with a body synthesized from the
 * branch's commit bodies. Idempotent create-or-update: run it after each milestone
 * (or at convergence) and the PR description stays current — that is what keeps the
 * eventual squash body honest. Returns the `PrRef` in `outcome.data.pr`.
 */
export function pullRequestJob(config: PullRequestJobConfig = {}): Job {
  return async (ctx) => {
    const label = config.label ?? 'pull-request';
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
    try {
      const branch = ctx.workspace.branch;
      if (!branch)
        throw new LoopError({
          code: 'CONFIG',
          message: `pullRequestJob "${label}" needs a branch checked out (detached HEAD or non-repo)`,
        });
      const base = config.base ?? 'main';
      const last = ctx.lastOutcome;

      if (config.push !== false) {
        const res = await push({
          cwd: ctx.workspace.dir,
          signal: ctx.signal,
          branch,
          ...(typeof config.push === 'object' ? config.push : {}),
        });
        if (!res.ok)
          throw new LoopError({
            code: 'BODY',
            message: `push failed: ${res.output}`,
          });
      }

      const body =
        (await derive(config.body, ctx, last)) ??
        (await consolidate(ctx, {
          since: base,
          max: config.max ?? 50,
          model: config.model,
        }));
      const title = (await derive(config.title, ctx, last)) ?? last?.summary ?? branch;

      const forge = resolveForge(ctx);
      const fopts = { cwd: ctx.workspace.dir, signal: ctx.signal };
      const existing = await forge.viewPr(branch, fopts);
      let pr: PrRef;
      if (existing) {
        await forge.editPr(existing, { body }, fopts);
        pr = existing;
      } else {
        pr = await forge.createPr(
          { title, body, base, branch, draft: config.draft },
          fopts,
        );
      }
      const outcome: Outcome = {
        status: 'pass',
        summary: `${existing ? 'updated' : 'opened'} PR #${pr.number}`,
        data: { pr },
      };
      ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
      return outcome;
    } catch (e) {
      const error = LoopError.from(e, {
        code: 'BODY',
        phase: 'body',
        path: ctx.path,
      });
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

export interface MergeJobConfig {
  label?: string;
  /** Base branch — the `since` bound for re-synthesizing the squash body. Default `main`. */
  base?: string;
  /** Squash merge (default true) — the whole reason this exists. */
  squash?: boolean;
  /**
   * Hand the merge to GitHub auto-merge (`gh pr merge --auto`): it lands once the
   * required checks pass. The recommended "merge when CI is green" path — non-blocking.
   */
  auto?: boolean;
  /** Delete the head branch after merge. */
  deleteBranch?: boolean;
  /** Squash commit subject. */
  subject?: Derive<string>;
  /** Squash commit body. Default: re-consolidate the branch (the up-to-date synthesis). */
  body?: Derive<string>;
  model?: string;
  max?: number;
  /**
   * A gate that must hold before loops issues the merge — e.g. `forgeChecks()` for a
   * synchronous "CI is green" check, or any `Condition`. Unmet → the job fails without
   * merging. (For the non-blocking path, prefer `auto: true` and let GitHub gate.)
   */
  when?: ConditionInput;
}

/**
 * Squash-merge the branch's PR with a body synthesized from its commit bodies — so the
 * one commit that lands on the base branch carries the whole "way", not a list of
 * subjects. Opt-in (loops performing an outward merge is high-stakes): gate it with
 * `auto: true` (GitHub merges when checks pass) and/or a `when` condition.
 */
export function mergeJob(config: MergeJobConfig = {}): Job {
  return async (ctx) => {
    const label = config.label ?? 'merge';
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label });
    try {
      const branch = ctx.workspace.branch;
      if (!branch)
        throw new LoopError({
          code: 'CONFIG',
          message: `mergeJob "${label}" needs a branch checked out`,
        });
      const forge = resolveForge(ctx);
      const fopts = { cwd: ctx.workspace.dir, signal: ctx.signal };
      const pr = await forge.viewPr(branch, fopts);
      if (!pr)
        throw new LoopError({
          code: 'CONFIG',
          message: `mergeJob "${label}": no open PR for branch "${branch}" — run pullRequestJob first`,
        });

      if (config.when) {
        const r = await toCondition(config.when)(ctx, ctx.lastOutcome);
        if (!r.met) {
          const outcome: Outcome = {
            status: 'fail',
            summary: `merge gate not met: ${r.reason}`,
            data: { pr },
          };
          ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
          return outcome;
        }
      }

      const last = ctx.lastOutcome;
      const base = config.base ?? 'main';
      // Re-synthesize at merge time so the squash body reflects the final branch.
      const body =
        (await derive(config.body, ctx, last)) ??
        (await consolidate(ctx, {
          since: base,
          max: config.max ?? 50,
          model: config.model,
        }));
      const subject = await derive(config.subject, ctx, last);

      await forge.mergePr(pr, {
        ...fopts,
        squash: config.squash,
        auto: config.auto,
        subject,
        body,
        deleteBranch: config.deleteBranch,
      });
      const outcome: Outcome = {
        status: 'pass',
        summary: `${config.auto ? 'enqueued' : 'merged'} PR #${pr.number}`,
        data: { pr },
      };
      ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
      return outcome;
    } catch (e) {
      const error = LoopError.from(e, {
        code: 'BODY',
        phase: 'body',
        path: ctx.path,
      });
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
