/**
 * Curated grounding: the progression of the grounding read from "prepend the
 * recent ledger" to "have a cheap agent compose the right context". Three
 * layers, each inert unless configured:
 *
 * 1. **Sources** (`GroundConfig.sources`) — declared files the grounding read
 *    may include beside the commit log: the spec, the ADRs, a TASK.md. Paths
 *    are contained to the workspace.
 * 2. **Curation** (`GroundConfig.curate`) — one cheap turn that reads the
 *    task, the ledger, and the source excerpts, and returns a structured
 *    verdict: a short brief for the worker plus which sources actually
 *    matter. Fail-closed: an unparseable verdict falls back to plain
 *    grounding, never to a guess.
 * 3. **The ladder** (`AgentJobConfig.ladder`) — declared engine/model rungs
 *    the same verdict may pick from, cheapest first. The curator chooses a
 *    rung *from the declared set only*; rung 0 is the lane used whenever
 *    routing is off, disabled (`--no-ladder`), or the verdict fails.
 *
 * The verdict is parsed with the helm's lenient extractor (prose and fences
 * tolerated) and validated strictly, and every decision is emitted as a log
 * event so `loops tail` shows why a turn ran where it ran. The A/B contract:
 * `--no-curate` / `--no-ladder` flip each layer off at run level, so the same
 * recipe benchmarks with and without.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import type { JobContext } from './types.ts';
import type { EngineRef } from '../engines/engine.ts';
import { groundingText } from './ground.ts';
import { globToRegExp } from './guards.ts';
import { truncate } from './text.ts';
import { extractFirstJson } from '../helm/intent.ts';
import { loopsRequestMeta } from './engine-meta.ts';

export type SourceSpec = string | { path: string; maxChars?: number };

export interface LadderRung {
  engine?: EngineRef;
  model?: string;
  /** One line the curator sees when weighing this rung (e.g. "cheap, small edits"). */
  hint?: string;
}

export interface CurateConfig {
  /** The curator's lane — keep it cheap. Defaults to the run engine. */
  engine?: EngineRef;
  model?: string;
  maxTokens?: number;
  /** Cap on the composed brief. Default 2000 chars. */
  briefChars?: number;
  timeoutMs?: number;
}

export interface SourceText {
  path: string;
  text: string;
}

/** Per-source excerpt cap (chars) unless the spec overrides it. */
const SOURCE_CHARS = 4000;
/** Cap on files a glob may expand to, so `**` on a big tree stays sane. */
const GLOB_CAP = 20;

/**
 * Resolve declared sources to texts. Containment mirrors the helm bridge:
 * relative paths only, no escaping the workspace. A missing file is skipped
 * (declared sources are optional context, not preconditions); a traversal
 * attempt throws (that is a recipe bug, not a missing file).
 */
export function readSources(
  ctx: Pick<JobContext, 'workspace'>,
  sources: SourceSpec[],
): SourceText[] {
  const root = resolve(ctx.workspace.dir);
  const out: SourceText[] = [];
  for (const spec of sources) {
    const { path, maxChars } =
      typeof spec === 'string' ? { path: spec, maxChars: undefined } : spec;
    if (isAbsolute(path) || path.startsWith('~')) {
      throw new Error(`ground source must be workspace-relative, got "${path}"`);
    }
    const resolved = resolve(root, path);
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || rel.split(sep).includes('..')) {
      throw new Error(`ground source escapes the workspace: "${path}"`);
    }
    const cap = maxChars ?? SOURCE_CHARS;
    for (const file of expand(root, path)) {
      try {
        out.push({
          path: file,
          text: truncate(readFileSync(resolve(root, file), 'utf8'), cap),
        });
      } catch {
        /* a declared-but-absent source is skipped, not fatal */
      }
    }
  }
  return out;
}

/** Expand one spec: a literal path, or a glob walked from its static prefix. */
function expand(root: string, path: string): string[] {
  if (!path.includes('*') && !path.includes('?')) return [path];
  const pattern = globToRegExp(path);
  // Walk from the deepest static directory prefix of the glob.
  const staticPrefix = path.split(/[*?]/)[0]!;
  const start = staticPrefix.includes('/')
    ? staticPrefix.slice(0, staticPrefix.lastIndexOf('/'))
    : '';
  const matches: string[] = [];
  const walk = (dir: string): void => {
    if (matches.length >= GLOB_CAP) return;
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (matches.length >= GLOB_CAP) return;
      if (entry === '.git' || entry === 'node_modules') continue;
      const relPath = dir ? `${dir}/${entry}` : entry;
      try {
        if (statSync(join(root, relPath)).isDirectory()) walk(relPath);
        else if (pattern.test(relPath)) matches.push(relPath);
      } catch {
        /* unreadable entry: skip */
      }
    }
  };
  walk(start);
  return matches;
}

const verdictSchema = z.object({
  brief: z.string().min(1),
  sources: z.array(z.string()).optional(),
  rung: z.number().int().min(0).optional(),
  rationale: z.string().optional(),
});

export interface CurateVerdict {
  /** The composed brief the worker prompt opens with. */
  brief: string;
  /** The declared sources the curator kept (paths, subset of the input). */
  sources?: string[];
  /** The ladder rung it picked, when a ladder was offered. */
  rung?: number;
}

const CURATOR_SYSTEM =
  'You prepare the working context for another agent. You never do the task ' +
  'yourself. Reply with exactly one JSON object: {"brief": "...", "sources": ' +
  '["path", ...], "rung": n}. The brief is the distilled context the worker ' +
  'should start from: what matters, what prior work decided, what to avoid — ' +
  'no filler, no restating the task. Keep only sources that materially help; ' +
  'drop the rest. Pick the CHEAPEST rung that can genuinely do the task.';

export interface CurateInput {
  /** The worker's task (the user prompt, pre-grounding). */
  intent: string;
  sources: SourceText[];
  /** Rungs on offer, cheapest first; omitted when routing is off. */
  ladder?: LadderRung[];
  config: CurateConfig;
}

/**
 * The curation turn. Returns undefined on ANY failure — engine error,
 * unparseable reply, out-of-range selections — so the caller falls back to
 * plain grounding and the default rung. A curator that cannot be read must
 * never steer the run.
 */
export async function curateContext(
  ctx: JobContext,
  input: CurateInput,
): Promise<CurateVerdict | undefined> {
  const briefChars = input.config.briefChars ?? 2000;
  const ledger = await groundingText(ctx.workspace, {
    max: 8,
    bodyChars: 400,
    signal: ctx.signal,
  }).catch(() => '');
  const rungs = input.ladder
    ?.map(
      (rung, i) =>
        `${i}: ${rungName(rung)}${rung.hint ? ` — ${rung.hint}` : ''}`,
    )
    .join('\n');
  const sourceBlocks = input.sources
    .map((s) => `### ${s.path}\n${truncate(s.text, 1500)}`)
    .join('\n\n');
  const prompt =
    `TASK (for the worker, not for you):\n${truncate(input.intent, 2000)}\n\n` +
    (ledger ? `${ledger}\n\n` : '') +
    (sourceBlocks ? `DECLARED SOURCES (keep only what helps):\n${sourceBlocks}\n\n` : '') +
    (rungs ? `LADDER (pick the cheapest sufficient rung):\n${rungs}\n\n` : '') +
    `Return the JSON verdict now (brief <= ${briefChars} chars).`;

  try {
    const engine = input.config.engine
      ? ctx.resolveEngine(input.config.engine)
      : ctx.engine;
    const result = await engine.run(
      {
        prompt,
        system: CURATOR_SYSTEM,
        model: input.config.model,
        maxTokens: input.config.maxTokens ?? 1200,
        timeoutMs: input.config.timeoutMs,
        leaf: true,
        loops: loopsRequestMeta(ctx, 'curate'),
      },
      () => {},
      ctx.signal,
    );
    const parsed = verdictSchema.safeParse(extractFirstJson(result.text));
    if (!parsed.success) {
      ctx.log(`curate: unreadable verdict — plain grounding (fail-closed)`, 'warn');
      return undefined;
    }
    const declared = new Set(input.sources.map((s) => s.path));
    const kept = parsed.data.sources?.filter((p) => declared.has(p));
    const rung =
      input.ladder &&
      parsed.data.rung !== undefined &&
      parsed.data.rung < input.ladder.length
        ? parsed.data.rung
        : undefined;
    return {
      brief: truncate(parsed.data.brief, briefChars),
      sources: kept,
      rung,
    };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(
      `curate: turn failed (${e instanceof Error ? e.message : String(e)}) — plain grounding (fail-closed)`,
      'warn',
    );
    return undefined;
  }
}

export function rungName(rung: LadderRung): string {
  const engine =
    typeof rung.engine === 'string'
      ? rung.engine
      : (rung.engine?.name ?? 'default engine');
  return rung.model ? `${engine} (${rung.model})` : engine;
}

/** Render the kept sources as a prompt block ('' when none). */
export function sourcesBlock(sources: SourceText[]): string {
  if (!sources.length) return '';
  const body = sources
    .map((s) => `### ${basename(s.path)} (${s.path})\n\n${s.text}`)
    .join('\n\n');
  return `## Declared sources\n\n${body}`;
}

/** Render the curated brief as the highest-priority context block. */
export function briefBlock(brief: string): string {
  return `## Curated brief (a cheap curator distilled the context — verify against the workspace)\n\n${brief}`;
}
