/**
 * The Forge provider — the host where a branch becomes a pull request. It sits
 * alongside Engine (where the agent thinks) and Environment (where the code runs)
 * as a thin, swappable seam: loops owns the interface and the jobs that drive it
 * (`pullRequestJob`, `mergeJob` in `pr.ts`); the default adapter shells out to the
 * GitHub CLI (`gh`), the same subprocess instinct as the `git`/claude-cli engines.
 *
 * Why a seam at all: the squash-merge boundary is where loops' commit-log memory
 * would otherwise be lost. A PR carries a body, and a squash merge can be made to
 * use that body as the merged commit message — so if loops keeps the PR body a
 * faithful synthesis of the branch's commit "ways", the Ledger survives the squash.
 * The Forge is how loops reaches the PR to write that body and (optionally) drive
 * the merge. A `MockForge` keeps the jobs offline-testable, the loops convention.
 */

import { execa } from 'execa';

import { LoopError } from './errors.ts';
import { redactSecrets } from './redact.ts';

/** Identifies a pull request on the host. */
export interface PrRef {
  number: number;
  url: string;
  /** The head branch the PR is for. */
  branch?: string;
}

/** Everything needed to open a PR. */
export interface PrInput {
  title: string;
  body: string;
  /** The branch to merge into (e.g. `main`). */
  base: string;
  /** The branch carrying the work (the PR head). */
  branch: string;
  draft?: boolean;
}

/** A partial update to an existing PR (the body is the synthesis we keep current). */
export interface PrPatch {
  title?: string;
  body?: string;
}

/** Where the host command runs (the repo working dir) + the run's abort signal. */
export interface ForgeOpts {
  cwd: string;
  signal?: AbortSignal;
}

export interface MergeOptions extends ForgeOpts {
  /** Squash merge (default). The whole point — collapse the branch to one commit. */
  squash?: boolean;
  /** The squash commit subject. */
  subject?: string;
  /** The squash commit body — the synthesis, written directly so it cannot be lost. */
  body?: string;
  /** Enqueue GitHub auto-merge: the merge happens once required checks pass. */
  auto?: boolean;
  /** Delete the head branch after merge. */
  deleteBranch?: boolean;
}

/**
 * The host seam. Five operations, each taking an explicit working dir — no hidden
 * global state, mirroring `git.ts`. `viewPr` answers an expected "no" with
 * `undefined` (no PR yet); the mutating ops throw a clear `CONFIG` error when the
 * CLI is missing/unauthed, never a cryptic crash.
 */
export interface Forge {
  readonly name: string;
  /** The open PR whose head is `branch`, or undefined when there is none. */
  viewPr(branch: string, opts: ForgeOpts): Promise<PrRef | undefined>;
  createPr(input: PrInput, opts: ForgeOpts): Promise<PrRef>;
  editPr(pr: PrRef, patch: PrPatch, opts: ForgeOpts): Promise<void>;
  mergePr(pr: PrRef, opts: MergeOptions): Promise<void>;
  /** True when the PR's required checks are all green (for a synchronous gate). */
  checksPass(pr: PrRef, opts: ForgeOpts): Promise<boolean>;
}

/** Duck-type guard: a ready-made `Forge` rather than something else. */
export function isForge(value: unknown): value is Forge {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Forge).name === 'string' &&
    typeof (value as Forge).createPr === 'function'
  );
}

// ── gh argv builders (pure — unit-tested without spawning, like buildClaudeArgs) ──

export function buildViewArgs(branch: string): string[] {
  return ['pr', 'view', branch, '--json', 'number,url,headRefName'];
}

export function buildCreateArgs(input: PrInput): string[] {
  // The body is passed on stdin (`--body-file -`) so an arbitrarily-shaped body
  // never has to survive arg length limits or escaping.
  const args = [
    'pr',
    'create',
    '--base',
    input.base,
    '--head',
    input.branch,
    '--title',
    input.title,
    '--body-file',
    '-',
  ];
  if (input.draft) args.push('--draft');
  return args;
}

export function buildEditArgs(pr: PrRef, patch: PrPatch): string[] {
  const args = ['pr', 'edit', String(pr.number)];
  if (patch.title) args.push('--title', patch.title);
  if (patch.body !== undefined) args.push('--body-file', '-');
  return args;
}

export function buildMergeArgs(pr: PrRef, opts: MergeOptions): string[] {
  const args = ['pr', 'merge', String(pr.number)];
  args.push(opts.squash === false ? '--merge' : '--squash');
  if (opts.auto) args.push('--auto');
  if (opts.subject) args.push('--subject', opts.subject);
  if (opts.body !== undefined) args.push('--body-file', '-');
  if (opts.deleteBranch) args.push('--delete-branch');
  return args;
}

export function buildChecksArgs(pr: PrRef): string[] {
  return ['pr', 'checks', String(pr.number), '--required'];
}

// ── GhForge — the default adapter ────────────────────────────────────────────

async function gh(
  bin: string,
  args: string[],
  opts: ForgeOpts,
  input?: string,
): Promise<{ stdout: string; all: string; exitCode: number }> {
  let r;
  try {
    r = await execa(bin, args, {
      cwd: opts.cwd,
      cancelSignal: opts.signal,
      reject: false,
      all: true,
      stdin: input === undefined ? 'ignore' : undefined,
      input,
    });
  } catch (e) {
    // A spawn failure (ENOENT) means gh is not installed / not on PATH.
    throw new LoopError({
      code: 'CONFIG',
      message:
        `the GitHub CLI (gh) is required for PR operations but could not be run ` +
        `(install it and run \`gh auth login\`): ${(e as Error).message}`,
    });
  }
  return {
    stdout: r.stdout ?? '',
    all: r.all ?? r.stdout ?? '',
    exitCode: r.exitCode ?? 1,
  };
}

/** Throw a clear, redacted error for a mutating op that failed (e.g. unauthed gh). */
function ghOrThrow(
  r: { exitCode: number; all: string },
  action: string,
): void {
  if (r.exitCode !== 0)
    throw new LoopError({
      code: 'CONFIG',
      message: `gh ${action} failed (exit ${r.exitCode}): ${redactSecrets(String(r.all).slice(0, 400))}`,
    });
}

/** The GitHub CLI adapter. Everything `pr.ts` needs, over `gh`. */
export class GhForge implements Forge {
  readonly name = 'gh';
  constructor(private readonly bin = 'gh') {}

  async viewPr(branch: string, opts: ForgeOpts): Promise<PrRef | undefined> {
    const r = await gh(this.bin, buildViewArgs(branch), opts);
    if (r.exitCode !== 0) return undefined; // no PR for this branch — an expected "no"
    try {
      const j = JSON.parse(r.stdout) as {
        number: number;
        url: string;
        headRefName?: string;
      };
      return { number: j.number, url: j.url, branch: j.headRefName };
    } catch {
      return undefined;
    }
  }

  async createPr(input: PrInput, opts: ForgeOpts): Promise<PrRef> {
    const r = await gh(this.bin, buildCreateArgs(input), opts, input.body);
    ghOrThrow(r, 'pr create');
    const url = r.stdout.trim().split('\n').pop() ?? '';
    const m = url.match(/\/pull\/(\d+)/);
    return { number: m ? Number(m[1]) : 0, url, branch: input.branch };
  }

  async editPr(pr: PrRef, patch: PrPatch, opts: ForgeOpts): Promise<void> {
    const r = await gh(this.bin, buildEditArgs(pr, patch), opts, patch.body);
    ghOrThrow(r, 'pr edit');
  }

  async mergePr(pr: PrRef, opts: MergeOptions): Promise<void> {
    const r = await gh(this.bin, buildMergeArgs(pr, opts), opts, opts.body);
    ghOrThrow(r, 'pr merge');
  }

  async checksPass(pr: PrRef, opts: ForgeOpts): Promise<boolean> {
    const r = await gh(this.bin, buildChecksArgs(pr), opts);
    return r.exitCode === 0; // 0 = all required checks green
  }
}

// ── MockForge — scripted, offline (for tests and dry-run examples) ───────────

export interface MockForgeOptions {
  /** Branch → a PR that already exists (so the job takes the update path). */
  existing?: Record<string, PrRef>;
  /** What `checksPass` returns. Default true. */
  checks?: boolean;
}

/** Records every call and keeps a tiny in-memory PR store. No network. */
export class MockForge implements Forge {
  readonly name = 'mock-forge';
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];
  private readonly prs: Map<string, PrRef>;
  private seq = 100;
  constructor(private readonly opts: MockForgeOptions = {}) {
    this.prs = new Map(Object.entries(opts.existing ?? {}));
  }

  async viewPr(branch: string): Promise<PrRef | undefined> {
    this.calls.push({ method: 'viewPr', args: { branch } });
    return this.prs.get(branch);
  }

  async createPr(input: PrInput): Promise<PrRef> {
    this.calls.push({ method: 'createPr', args: { ...input } });
    const number = (this.seq += 1);
    const pr: PrRef = {
      number,
      url: `https://example.test/pull/${number}`,
      branch: input.branch,
    };
    this.prs.set(input.branch, pr);
    return pr;
  }

  async editPr(pr: PrRef, patch: PrPatch): Promise<void> {
    this.calls.push({ method: 'editPr', args: { pr, patch } });
  }

  async mergePr(pr: PrRef, opts: MergeOptions): Promise<void> {
    this.calls.push({
      method: 'mergePr',
      args: {
        pr,
        squash: opts.squash,
        auto: opts.auto,
        subject: opts.subject,
        body: opts.body,
        deleteBranch: opts.deleteBranch,
      },
    });
  }

  async checksPass(): Promise<boolean> {
    this.calls.push({ method: 'checksPass', args: {} });
    return this.opts.checks ?? true;
  }
}
