/**
 * The draft — loops' staged commit body, the write-ahead log for the "way".
 *
 * `commitJob` writes the way welded to the diff, but the way cannot be trusted
 * to survive in a single agent's head: context decays over a long unit of work,
 * and when work fans out to sub-agents no one holds all the reasoning at the
 * end. So the why is captured durably, AS IT HAPPENS, in a file every agent on a
 * team reads and appends to. `commitJob` composes the commit body FROM this
 * file, then clears it at the boundary (crystallise, then reset).
 *
 * This is Tandem's progress.md, minus the hook scaffolding (the loop enforces
 * the commit boundary the Stop/guard hooks were simulating), plus worktree
 * isolation: the draft lives in the workspace, so concurrent teams get isolated
 * drafts automatically while sub-agents within a team share one.
 *
 * The whole `.loops/` scratch dir is kept out of git (self-managed .gitignore),
 * so `commitJob`'s `git add -A` never stages the draft. The draft is the draft;
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
import { join, dirname } from 'node:path';

import type { Workspace } from './types.ts';

const DRAFT_DIR = '.loops';
const DRAFT_FILE = 'progress.md';

/** Absolute path to a workspace's draft (the staged commit body). */
export function draftPath(workspace: Workspace): string {
  return join(workspace.dir, DRAFT_DIR, DRAFT_FILE);
}

/** Create `.loops/` and keep it (and everything in it) out of git. */
function ensureDir(workspace: Workspace): string {
  const path = draftPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  ensureIgnored(workspace);
  return path;
}

/**
 * Guarantee `.loops/.gitignore` ignores everything, so the draft is never
 * staged — even if an agent wrote it directly rather than via `appendDraft`.
 * No-op when `.loops/` does not exist.
 */
export function ensureIgnored(workspace: Workspace): void {
  const dir = join(workspace.dir, DRAFT_DIR);
  if (!existsSync(dir)) return;
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
}

export interface DraftNote {
  /** Optional section heading (Why / Alternatives / Constraints / Next…). */
  heading?: string;
  /** The reasoning to record — the "why". */
  body: string;
  /** Who recorded it, so a fanned-out team's why stays attributable. */
  author?: string;
}

/**
 * Append a note to the staged commit body. Durable and append-only: many agents
 * on one team add to the same draft as they work, and the order is preserved.
 * Uses an O_APPEND write, so concurrent appends do not clobber each other.
 */
export function appendDraft(workspace: Workspace, note: DraftNote | string): void {
  const path = ensureDir(workspace);
  const n = typeof note === 'string' ? { body: note } : note;
  const header = n.heading
    ? `## ${n.heading}${n.author ? ` — ${n.author}` : ''}\n\n`
    : n.author
      ? `_${n.author}:_ `
      : '';
  appendFileSync(path, `${header}${n.body.trim()}\n\n`);
}

/** Read the staged commit body, or '' when nothing has been drafted. */
export function readDraft(workspace: Workspace): string {
  try {
    return readFileSync(draftPath(workspace), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Clear the draft at the commit boundary (the atomicity rule: then reset). */
export function resetDraft(workspace: Workspace): void {
  try {
    rmSync(draftPath(workspace), { force: true });
  } catch {
    /* best-effort */
  }
}
