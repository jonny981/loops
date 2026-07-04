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
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Workspace } from './types.ts';

const SCRATCH_DIR = '.loops';
const LEDGER_FILE = 'ledger.md';
const PROMPT_FILE = 'prompt.md';

/** Absolute path to a workspace's working memory (`ledger.md`). */
export function ledgerPath(workspace: Workspace): string {
  return join(workspace.dir, SCRATCH_DIR, LEDGER_FILE);
}

/** Absolute path to a workspace's handoff (`prompt.md`, the staged commit body). */
export function promptPath(workspace: Workspace): string {
  return join(workspace.dir, SCRATCH_DIR, PROMPT_FILE);
}

/** Create `.loops/` and keep it (and everything in it) out of git. */
function ensureDir(workspace: Workspace): void {
  mkdirSync(join(workspace.dir, SCRATCH_DIR), { recursive: true });
  ensureIgnored(workspace);
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

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
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
  ensureDir(workspace);
  const n = typeof note === 'string' ? { body: note } : note;
  const header = n.heading
    ? `## ${n.heading}${n.author ? ` — ${n.author}` : ''}\n\n`
    : n.author
      ? `_${n.author}:_ `
      : '';
  appendFileSync(promptPath(workspace), `${header}${n.body.trim()}\n\n`);
}

/** Read the handoff, or '' when nothing has been drafted. */
export function readPrompt(workspace: Workspace): string {
  return read(promptPath(workspace));
}

/** Clear the handoff at the commit boundary. */
export function resetPrompt(workspace: Workspace): void {
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
  ensureDir(workspace);
  const path = ledgerPath(workspace);
  if (typeof entry === 'string') {
    const body = entry.trim();
    if (body) appendFileSync(path, `${body}\n\n`);
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
  appendFileSync(path, `${lines.join('\n\n')}\n\n`);
}

/** Read the working memory, or '' when nothing has been logged. */
export function readLedger(workspace: Workspace): string {
  return read(ledgerPath(workspace));
}

/** Clear the working memory at the commit boundary. */
export function resetLedger(workspace: Workspace): void {
  reset(ledgerPath(workspace));
}
