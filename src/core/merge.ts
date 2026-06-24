/**
 * Merge as synthesis (GCC's `MERGE`). A raw `git merge` either applies cleanly or
 * fails on conflict. `mergeSynthesis` does the thing a teammate does: when two
 * lines of work collide, an agent RESOLVES each conflicted file coherently
 * (preserving both intents), and the merge commit body is a SYNTHESIS of what the
 * two branches were each trying to do — not "merge branch X".
 *
 * It is text-in/text-out, so it works through any `Engine` (no tool-use needed):
 * the conflicted file content goes in, the resolved content comes back. Light: a
 * call per conflicted file plus one for the synthesis body, and nothing when the
 * merge is already clean. The merge is aborted if resolution throws, so the target
 * is never left half-merged.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JobContext } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import {
  mergeNoCommit,
  mergeAbort,
  stageAll,
  commit,
  log,
} from './git.ts';
import { LoopError } from './errors.ts';

export interface MergeSynthesisConfig {
  /** The branch to land into the current workspace. */
  branch: string;
  /** Conventional subject for the merge commit. */
  message?: string;
  engine?: EngineRef;
  model?: string;
}

export interface MergeSynthesisResult {
  ok: boolean;
  /** Whether a conflict had to be resolved. */
  conflict: boolean;
  sha?: string;
}

/** Strip a single wrapping code fence a model sometimes adds around file output. */
function stripFence(s: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(s.trim());
  return `${(m ? m[1]! : s).replace(/\s+$/, '')}\n`;
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim()) ?? '';
}

export async function mergeSynthesis(
  ctx: JobContext,
  config: MergeSynthesisConfig,
): Promise<MergeSynthesisResult> {
  const cwd = ctx.workspace.dir;
  const engine = config.engine ? ctx.resolveEngine(config.engine) : ctx.engine;
  const merge = await mergeNoCommit(cwd, config.branch, { signal: ctx.signal });

  try {
    if (!merge.clean) {
      for (const file of merge.conflicted) {
        const conflicted = readFileSync(join(cwd, file), 'utf8');
        const out = await engine.run(
          {
            prompt:
              `Resolve this git merge conflict in \`${file}\`. Combine both sides ` +
              `coherently, preserving the intent of each. Output ONLY the fully ` +
              `resolved file content — no conflict markers, no commentary, no code ` +
              `fence.\n\n${conflicted}`,
            model: config.model,
            maxTokens: 4000,
          },
          () => {},
          ctx.signal,
        );
        writeFileSync(join(cwd, file), stripFence(out.text));
      }
      await stageAll({ cwd, signal: ctx.signal });
    }

    const body = await synthesiseBody(ctx, engine, config);
    const sha = await commit(
      {
        subject: config.message ?? `merge: ${config.branch} (synthesis)`,
        body,
        allowEmpty: true, // a merge commit may have an empty diff after resolution
      },
      { cwd, signal: ctx.signal },
    );
    return { ok: true, conflict: !merge.clean, sha };
  } catch (e) {
    await mergeAbort(cwd, { signal: ctx.signal }).catch(() => {});
    throw LoopError.from(e, { code: 'BODY', path: ctx.path });
  }
}

/** Compose the merge body from the merged branch's own "ways". */
async function synthesiseBody(
  ctx: JobContext,
  engine: ReturnType<JobContext['resolveEngine']>,
  config: MergeSynthesisConfig,
): Promise<string> {
  const ways = await log({
    cwd: ctx.workspace.dir,
    ref: config.branch,
    max: 8,
    signal: ctx.signal,
  });
  const summary = ways
    .map((w) => `- ${w.subject}${w.body ? `: ${firstLine(w.body)}` : ''}`)
    .join('\n');
  const out = await engine.run(
    {
      prompt:
        `A branch is being merged. Its commits:\n${summary || '(none)'}\n\n` +
        `Write a concise MERGE SYNTHESIS for the commit body: what this line of ` +
        `work accomplished, how it integrates, and any tradeoff reconciled. A few ` +
        `sentences, no preamble.`,
      system: 'You write merge synthesis commit bodies that capture intent.',
      model: config.model,
      maxTokens: 600,
    },
    () => {},
    ctx.signal,
  );
  return out.text.trim();
}
