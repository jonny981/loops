/**
 * The git substrate. loops' answer to cross-iteration amnesia is to make the
 * commit log the convergence ledger: each unit of work commits the "way" (a
 * structured body) welded to the "what" (the diff), and the next fresh context
 * reads the log back. This module is the thin, engine-agnostic wrapper that lets
 * the core do that — every function takes an explicit `cwd` (the worktree dir)
 * and never throws for an expected "no" answer.
 *
 * It is deliberately small: a handful of plumbing/porcelain calls over `execa`,
 * the same subprocess primitive `commandSucceeds` already uses. No git library,
 * no parallel state. Git is the state.
 */

import { execa } from 'execa';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One commit as the ledger sees it: the what (sha) plus the way (body). */
export interface CommitRecord {
  sha: string;
  /** Conventional-commit subject line. */
  subject: string;
  /** The structured body (the "way") — everything after the subject. */
  body: string;
  /** ISO author date. */
  date: string;
}

interface GitOpts {
  cwd: string;
  signal?: AbortSignal;
}

// Record-delimited log format: sha, ISO date, subject, body, then a record
// separator. Field separator is the unit-separator (US, 0x1f); records end with
// the record-separator (RS, 0x1e). Both are control chars a commit body will
// never contain, so a body with arbitrary newlines/blank lines parses cleanly.
const FS = '\x1f';
const RS = '\x1e';
const LOG_FORMAT = `%H${FS}%aI${FS}%s${FS}%b${RS}`;

async function git(
  args: string[],
  { cwd, signal }: GitOpts,
  input?: string,
): Promise<{ stdout: string; exitCode: number }> {
  const r = await execa('git', args, {
    cwd,
    cancelSignal: signal,
    reject: false,
    stdin: input === undefined ? 'ignore' : undefined,
    input,
  });
  return { stdout: r.stdout ?? '', exitCode: r.exitCode ?? 1 };
}

/** True when `cwd` is inside a git work tree. Never throws. */
export async function isRepo(opts: GitOpts): Promise<boolean> {
  try {
    const r = await git(['rev-parse', '--is-inside-work-tree'], opts);
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** The checked-out branch name, or undefined on a detached HEAD / non-repo. */
export async function currentBranch(opts: GitOpts): Promise<string | undefined> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  if (r.exitCode !== 0) return undefined;
  const name = r.stdout.trim();
  return name && name !== 'HEAD' ? name : undefined;
}

/** The HEAD commit sha, or undefined when the branch has no commits yet. */
export async function headSha(opts: GitOpts): Promise<string | undefined> {
  const r = await git(['rev-parse', 'HEAD'], opts);
  return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Stage every change in the work tree (`git add -A`). */
export async function stageAll(opts: GitOpts): Promise<void> {
  await git(['add', '-A'], opts);
}

/** True when there is something staged to commit. */
export async function hasStagedChanges(opts: GitOpts): Promise<boolean> {
  // `diff --cached --quiet` exits 1 when the index differs from HEAD.
  const r = await git(['diff', '--cached', '--quiet'], opts);
  return r.exitCode === 1;
}

/** True when the work tree (staged or unstaged) has any change. */
export async function isDirty(opts: GitOpts): Promise<boolean> {
  const r = await git(['status', '--porcelain'], opts);
  return r.stdout.trim().length > 0;
}

export interface CommitInput {
  subject: string;
  /** The structured body — the "way". Joined to the subject with a blank line. */
  body?: string;
  /** Commit even with an empty index (default false). */
  allowEmpty?: boolean;
}

/**
 * Commit the staged index. The message is passed on stdin (`-F -`) so an
 * arbitrarily-shaped body never has to survive shell escaping. The repo's
 * configured author is used — loops never sets an author or a co-author trailer.
 * Returns the new sha, or undefined when there was nothing to commit and
 * `allowEmpty` was not set.
 */
export async function commit(
  input: CommitInput,
  opts: GitOpts,
): Promise<string | undefined> {
  if (!input.allowEmpty && !(await hasStagedChanges(opts))) return undefined;
  const message = input.body
    ? `${input.subject}\n\n${input.body}\n`
    : `${input.subject}\n`;
  const args = ['commit', '-F', '-'];
  if (input.allowEmpty) args.push('--allow-empty');
  const r = await git(args, opts, message);
  if (r.exitCode !== 0) {
    throw new Error(
      `git commit failed (exit ${r.exitCode}): ${r.stdout}`.trim(),
    );
  }
  return headSha(opts);
}

export interface LogQuery extends GitOpts {
  /** Exclusive lower bound: only commits after this ref (e.g. the loop start). */
  since?: string;
  /** Cap the number of commits returned (most recent first). */
  max?: number;
  /** The ref to read (default HEAD) — e.g. a fork branch's own line of work. */
  ref?: string;
}

/**
 * Read the ledger: recent commits, newest first, each with its body (the way).
 * `since` gives the "this run only" window the loop grounds the next iteration
 * on; `max` bounds it so the ledger never re-rots the fresh context.
 */
export async function log(query: LogQuery): Promise<CommitRecord[]> {
  const { cwd, signal, since, max } = query;
  const ref = query.ref ?? 'HEAD';
  const args = ['log', `--format=${LOG_FORMAT}`];
  if (max != null) args.push(`-n${max}`);
  args.push(since ? `${since}..${ref}` : ref);
  const r = await git(args, { cwd, signal });
  if (r.exitCode !== 0) return [];
  return parseLog(r.stdout);
}

/** Parse the record-separated log stream into structured commits. */
function parseLog(stdout: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const chunk of stdout.split(RS)) {
    // git prints a newline between records; strip the leading one.
    const fields = chunk.replace(/^\n+/, '').split(FS);
    if (fields.length < 4 || !fields[0]!.trim()) continue;
    records.push({
      sha: fields[0]!.trim(),
      date: fields[1]!.trim(),
      subject: fields[2]!,
      body: fields[3]!.trim(),
    });
  }
  return records;
}

// ── Worktrees (branches-as-teams) ──────────────────────────────────────────

export interface WorktreeHandle {
  /** The isolated working directory. */
  dir: string;
  /** The branch checked out there. */
  branch: string;
}

/**
 * Fork an isolated worktree on a new branch from `base` (default HEAD). This is
 * how a concurrency boundary becomes a team: each concurrent writer gets its own
 * working dir and branch, so siblings never collide on files or the index.
 */
export async function addWorktree(
  repoDir: string,
  opts: { branch: string; base?: string; signal?: AbortSignal },
): Promise<WorktreeHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'loops-wt-'));
  const r = await git(
    ['worktree', 'add', '-b', opts.branch, dir, opts.base ?? 'HEAD'],
    { cwd: repoDir, signal: opts.signal },
  );
  if (r.exitCode !== 0)
    throw new Error(
      `git worktree add failed (exit ${r.exitCode}): ${r.stdout}`.trim(),
    );
  return { dir, branch: opts.branch };
}

/** Remove a worktree (force-discards anything uncommitted left in it). */
export async function removeWorktree(
  repoDir: string,
  dir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await git(['worktree', 'remove', '--force', dir], {
    cwd: repoDir,
    signal: opts.signal,
  });
}

/** Delete a branch ref (used to clean up a merged fork branch). */
export async function deleteBranch(
  repoDir: string,
  branch: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await git(['branch', '-D', branch], { cwd: repoDir, signal: opts.signal });
}

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
}

/**
 * Land a fork branch back into the branch checked out at `repoDir`, preserving
 * the team shape (`--no-ff`). On conflict the merge is aborted so the target
 * stays clean and the caller can fail the node honestly — loops does not
 * auto-resolve (a merge-resolver is a separate, later layer).
 */
export async function mergeBranch(
  repoDir: string,
  branch: string,
  opts: { signal?: AbortSignal; message?: string } = {},
): Promise<MergeResult> {
  const r = await git(
    ['merge', '--no-ff', '-m', opts.message ?? `merge ${branch}`, branch],
    { cwd: repoDir, signal: opts.signal },
  );
  if (r.exitCode === 0) return { ok: true, conflict: false };
  await git(['merge', '--abort'], { cwd: repoDir, signal: opts.signal });
  return { ok: false, conflict: true };
}

/**
 * Begin a `--no-ff --no-commit` merge WITHOUT aborting on conflict, so a resolver
 * can synthesise the result. `clean` means it merged cleanly (staged, ready to
 * commit); otherwise `conflicted` lists the unresolved paths (with markers).
 */
export async function mergeNoCommit(
  repoDir: string,
  branch: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ clean: boolean; conflicted: string[] }> {
  const r = await git(['merge', '--no-ff', '--no-commit', branch], {
    cwd: repoDir,
    signal: opts.signal,
  });
  if (r.exitCode === 0) return { clean: true, conflicted: [] };
  return { clean: false, conflicted: await conflictedFiles(repoDir, opts) };
}

/** Paths with unresolved merge conflicts. */
export async function conflictedFiles(
  repoDir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U'], {
    cwd: repoDir,
    signal: opts.signal,
  });
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Abort an in-progress merge. */
export async function mergeAbort(
  repoDir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await git(['merge', '--abort'], { cwd: repoDir, signal: opts.signal });
}
