/**
 * The scratch files (`.loops/`): two transient buffers that carry a unit of
 * work's memory forward, split by audience.
 *
 * - `ledger.md` is working memory, for the agent(s) working now. The running log
 *   of what is being tried, for the agent itself and any concurrent peers on the
 *   same team. The harness appends to it after each turn (auto-capture), so the
 *   reasoning is recorded even when an agent's context decays.
 *
 * - `prompt.md` is the handoff, for the next agent(s): the why, what was ruled
 *   out, the constraints, what is left. Grounding injects it into the next
 *   context as the start of its prompt; `commitJob` folds it into the commit body
 *   (alongside a compacted ledger).
 *
 * The commit body is `prompt.md` plus a compacted `ledger.md`, committed with its
 * diff. It does not expire at the next turn: it is a permanent record in git
 * history that any later agent can read (recent-N grounding surfaces nearby
 * commits, retrieval selects relevant ones however old, and an agent can walk the
 * log itself). Both files reset once the commit lands; the record they became
 * lives on in the history.
 *
 * The whole `.loops/` dir is kept out of git (self-managed `.gitignore`), so
 * `commitJob`'s `git add -A` never stages either file. The files are the draft;
 * the commit is the record.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { Workspace } from './types.ts';

const SCRATCH_DIR = '.loops';
const LEDGER_FILE = 'ledger.md';
const PROMPT_FILE = 'prompt.md';
const LEDGER_CHAR_CAP = 64_000;
const PROMPT_CHAR_CAP = 32_000;
const OMITTED_PREFIX = '[older scratch omitted to keep this file bounded]\n\n';

/** Absolute path to a workspace's working memory (`ledger.md`). */
export function ledgerPath(workspace: Workspace): string {
  return join(workspace.dir, SCRATCH_DIR, LEDGER_FILE);
}

/** Absolute path to a workspace's handoff (`prompt.md`, the staged commit body). */
export function promptPath(workspace: Workspace): string {
  return join(workspace.dir, SCRATCH_DIR, PROMPT_FILE);
}

/** Create `.loops/` and keep it (and everything in it) out of git. */
export function ensureScratchDir(workspace: Workspace): void {
  assertSafeScratchDir(workspace);
  mkdirSync(join(workspace.dir, SCRATCH_DIR), { recursive: true });
  assertSafeScratchDir(workspace);
  ensureIgnored(workspace);
}

export function ensureScratchSubdir(
  workspace: Workspace,
  name: string,
): string {
  ensureScratchDir(workspace);
  const dir = join(workspace.dir, SCRATCH_DIR, name);
  assertSafeDir(workspace, dir, `${SCRATCH_DIR}/${name}`);
  mkdirSync(dir, { recursive: true });
  assertSafeDir(workspace, dir, `${SCRATCH_DIR}/${name}`);
  return dir;
}

export function assertSafeScratchPath(
  workspace: Workspace,
  targetPath: string,
): void {
  const scratch = join(resolve(workspace.dir), SCRATCH_DIR);
  const target = resolve(workspace.dir, targetPath);
  const rel = relative(scratch, target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return;
  assertSafeScratchDir(workspace);
  const dir = dirname(target);
  const dirRel = relative(scratch, dir);
  if (!(dirRel === '' || dirRel === '..' || dirRel.startsWith(`..${sep}`))) {
    let current = scratch;
    for (const part of dirRel.split(sep)) {
      current = join(current, part);
      if (lstatIfExists(current)) assertSafeDir(workspace, current, current);
    }
  }
  if (lstatIfExists(target)) assertSafeFile(workspace, target, target);
}

function assertSafeScratchDir(workspace: Workspace): void {
  const dir = join(workspace.dir, SCRATCH_DIR);
  if (!lstatIfExists(dir)) return;
  assertSafeDir(workspace, dir, SCRATCH_DIR);
}

function assertSafeDir(workspace: Workspace, dir: string, label: string): void {
  const stat = lstatIfExists(dir);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe ${label}: must be a real directory inside the workspace`);
  }
  const root = realpathSync(workspace.dir);
  const real = realpathSync(dir);
  const rel = relative(root, real);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`unsafe ${label}: resolves outside the workspace`);
  }
}

function assertSafeFile(workspace: Workspace, file: string, label: string): void {
  const stat = lstatIfExists(file);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`unsafe ${label}: must be a regular file inside the workspace`);
  }
  const root = realpathSync(workspace.dir);
  const real = realpathSync(file);
  const rel = relative(root, real);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`unsafe ${label}: resolves outside the workspace`);
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Guarantee `.loops/.gitignore` ignores everything, so neither scratch file is ever
 * staged — even if an agent wrote one directly rather than through these helpers.
 * No-op when `.loops/` does not exist.
 */
export function ensureIgnored(workspace: Workspace): void {
  const dir = join(workspace.dir, SCRATCH_DIR);
  if (!existsSync(dir)) return;
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
}

function read(path: string, maxChars?: number): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return maxChars === undefined ? text : capText(text, maxChars);
  } catch {
    return '';
  }
}

function reset(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - OMITTED_PREFIX.length);
  return `${OMITTED_PREFIX}${text.slice(-keep).trimStart()}`;
}

function capEntry(text: string, maxChars: number): string {
  const maxEntry = Math.max(0, maxChars - OMITTED_PREFIX.length - 4);
  if (text.length <= maxEntry) return text;
  const marker = '\n[entry middle omitted]\n';
  const keep = Math.max(0, maxEntry - marker.length);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-tail).trimStart()}`;
}

// ── The handoff (`prompt.md`) ────────────────────────────────────────────────

export interface PromptNote {
  /** Optional section heading (Why / Alternatives / Constraints / Next…). */
  heading?: string;
  /** The reasoning to record. */
  body: string;
  /** Who recorded it, so a team's notes stay attributable. */
  author?: string;
}

/**
 * Append a note to the handoff. Durable and append-only: many agents on one team
 * add to the same handoff as they work, and the order is preserved. Uses an
 * O_APPEND write, so concurrent appends do not clobber each other.
 */
export function appendPrompt(workspace: Workspace, note: PromptNote | string): void {
  ensureScratchDir(workspace);
  const n = typeof note === 'string' ? { body: note } : note;
  const header = n.heading
    ? `## ${n.heading}${n.author ? ` — ${n.author}` : ''}\n\n`
    : n.author
      ? `_${n.author}:_ `
      : '';
  const path = promptPath(workspace);
  appendFileSync(path, `${capEntry(`${header}${n.body.trim()}`, PROMPT_CHAR_CAP)}\n\n`);
}

/** Read the handoff, or '' when nothing has been drafted. */
export function readPrompt(workspace: Workspace): string {
  assertSafeScratchPath(workspace, promptPath(workspace));
  return read(promptPath(workspace), PROMPT_CHAR_CAP);
}

/** Clear the handoff at the commit boundary. */
export function resetPrompt(workspace: Workspace): void {
  assertSafeScratchPath(workspace, promptPath(workspace));
  reset(promptPath(workspace));
}

// ── Working memory (`ledger.md`) ─────────────────────────────────────────────

export interface LedgerEntry {
  /** The job/agent label for the turn. */
  label?: string;
  /** The iteration number, when inside a loop. */
  iteration?: number;
  /** The agent's own reasoning text for the turn. */
  text?: string;
  /** Tool actions taken this turn, pre-summarised (e.g. `['Edit×2', 'Bash']`). */
  tools?: string[];
}

/**
 * Append a turn to the working memory. This is the auto-capture sink: the harness
 * records each grounded turn here (reasoning + a summary of actions), and agents can
 * jot their own notes too. Append-only and O_APPEND, so concurrent peers don't
 * clobber each other.
 */
export function appendLedger(workspace: Workspace, entry: LedgerEntry | string): void {
  ensureScratchDir(workspace);
  const path = ledgerPath(workspace);
  if (typeof entry === 'string') {
    const body = entry.trim();
    if (body) {
      appendFileSync(path, `${capEntry(body, LEDGER_CHAR_CAP)}\n\n`);
    }
    return;
  }
  const head = entry.label
    ? `### ${entry.label}${entry.iteration ? `  ·  iteration ${entry.iteration}` : ''}`
    : entry.iteration
      ? `### iteration ${entry.iteration}`
      : '';
  const lines: string[] = [];
  if (head) lines.push(head);
  if (entry.text?.trim()) lines.push(entry.text.trim());
  if (entry.tools?.length) lines.push(`_actions: ${entry.tools.join(', ')}_`);
  if (!lines.length) return;
  appendFileSync(path, `${capEntry(lines.join('\n\n'), LEDGER_CHAR_CAP)}\n\n`);
}

/** Read the working memory, or '' when nothing has been logged. */
export function readLedger(workspace: Workspace): string {
  assertSafeScratchPath(workspace, ledgerPath(workspace));
  return read(ledgerPath(workspace), LEDGER_CHAR_CAP);
}

/** Clear the working memory at the commit boundary. */
export function resetLedger(workspace: Workspace): void {
  assertSafeScratchPath(workspace, ledgerPath(workspace));
  reset(ledgerPath(workspace));
}
