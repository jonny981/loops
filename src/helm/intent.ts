/**
 * The helm's structured-intent contract. A driver model answers every turn
 * with one JSON intent; the harness is **lenient about the wrapper** (prose
 * around the object and markdown fences are tolerated) and **strict about the
 * content** (an unknown action or malformed field is a hard failure, never a
 * guess). The split is deliberate: "produced JSON at all" and "produced a
 * valid intent" are separate failure modes, and the driver eval scores them
 * separately (`score.ts`).
 */

import { z } from 'zod';

import { SEMANTIC_RECORD_FILTER_KINDS } from '../runtime/semantic-schema.ts';

/** The registry id alphabet (`newRunId`); also rejects traversal attempts. */
const RUN_ID = /^[a-z0-9][a-z0-9-]*$/;

const runIdField = z
  .string()
  .regex(RUN_ID, 'a run id (lowercase letters, digits, hyphens)');

/** `records` filter kinds, mirroring `loops records --kind`. */
export const HELM_RECORD_KINDS = SEMANTIC_RECORD_FILTER_KINDS;

/** Free-text the driver may attach to any intent; `say` is surfaced to the
 *  user, `rationale` is audit-only (never control flow). */
const voice = {
  say: z.string().optional(),
  rationale: z.string().optional(),
};

export const helmIntentSchema = z.discriminatedUnion('action', [
  // Reply without touching the workspace. Load-bearing for the cost thesis: a
  // good driver does NOT dispatch a run for trivia.
  z.object({ action: z.literal('answer'), say: z.string().min(1), rationale: voice.rationale }),
  // Write a `.loop.ts` recipe; the bridge validates it immediately so a broken
  // recipe comes back as a fix-oriented observation, not a wasted run.
  z.object({
    action: z.literal('author'),
    file: z.string().min(1),
    source: z.string().min(1),
    ...voice,
  }),
  // The offline pre-flight: load + print the recipe's shape, no model calls.
  z.object({ action: z.literal('validate'), file: z.string().min(1), ...voice }),
  // Dispatch a supervised background run. Returns a run id immediately;
  // dispatch is a pause-point (fire-and-poll), not an await.
  z.object({
    action: z.literal('run'),
    file: z.string().min(1),
    args: z.array(z.string()).optional(),
    ...voice,
  }),
  // Observe: one run's live rollup, or the registry when no id is given.
  z.object({ action: z.literal('status'), runId: runIdField.optional(), ...voice }),
  // Observe: the semantic decision stream of a run.
  z.object({
    action: z.literal('records'),
    runId: runIdField,
    kind: z.enum(HELM_RECORD_KINDS).optional(),
    last: z.number().int().positive().optional(),
    ...voice,
  }),
  // Lift a human gate on a run this session dispatched (resumes it).
  z.object({
    action: z.literal('ack'),
    runId: runIdField,
    gate: z.string().min(1),
    ...voice,
  }),
  // Abort a running dispatch.
  z.object({ action: z.literal('stop_run'), runId: runIdField, ...voice }),
  // The objective is met (or nothing is left to do): end the turn loop.
  z.object({ action: z.literal('done'), ...voice }),
]);

export type HelmIntent = z.infer<typeof helmIntentSchema>;
export type HelmAction = HelmIntent['action'];

export const HELM_ACTIONS = [
  'answer',
  'author',
  'validate',
  'run',
  'status',
  'records',
  'ack',
  'stop_run',
  'done',
] as const satisfies readonly HelmAction[];

/** No JSON object could be extracted from the reply at all. */
export class HelmParseError extends Error {
  override readonly name = 'HelmParseError';
}

/** A JSON object was extracted but it is not a valid intent. */
export class HelmIntentError extends Error {
  override readonly name = 'HelmIntentError';
}

/**
 * Escape raw control characters that appear *inside* JSON string literals
 * (models writing multi-line `source` fields emit literal newlines). Walks the
 * text with string/escape state so structural whitespace is untouched.
 */
export function escapeControlInStrings(text: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) {
        esc = false;
        out += ch;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        out += ch;
        continue;
      }
      if (ch === '"') inStr = false;
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** A balanced `{…}` span found by the string-aware scanner. */
function balancedSpan(text: string, from: number): string | undefined {
  const start = text.indexOf('{', from);
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** How many balanced-object candidates the extractor will try before giving
 *  up. Keeps a pathological reply O(candidates), not O(n²). */
const MAX_CANDIDATES = 8;

/**
 * Extract the first parseable JSON object from a model reply. Fenced blocks
 * are preferred (the fence is an explicit signal); otherwise successive
 * balanced `{…}` spans are tried in order, with a control-character repair
 * pass per candidate, so prose like "the config is {a: 1}" before the real
 * intent does not sink the turn.
 */
export function extractFirstJson(text: string): unknown {
  const candidates: string[] = [];
  if (text.includes('```')) {
    for (const part of text.split('```')) {
      const body = part.replace(/^[a-zA-Z0-9_-]*\s*\n?/, '');
      if (body.trimStart().startsWith('{')) candidates.push(body);
    }
  }
  let cursor = 0;
  while (candidates.length < MAX_CANDIDATES) {
    const span = balancedSpan(text, cursor);
    if (!span) break;
    candidates.push(span);
    cursor = text.indexOf(span, cursor) + 1;
  }
  if (!candidates.length) {
    throw new HelmParseError('no JSON object found in the reply');
  }
  let lastError = 'invalid JSON';
  for (const candidate of candidates) {
    const span = candidate.trimStart().startsWith('{')
      ? balancedSpan(candidate, 0)
      : undefined;
    if (!span) continue;
    for (const attempt of [span, escapeControlInStrings(span)]) {
      try {
        return JSON.parse(attempt);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  throw new HelmParseError(`invalid JSON: ${lastError}`);
}

/**
 * Parse a driver reply into a validated intent. Throws `HelmParseError` when
 * no JSON object can be extracted, `HelmIntentError` when the object is not a
 * valid intent — callers (and the eval's scorer) treat those as distinct
 * failure modes.
 */
export function parseHelmIntent(text: string): HelmIntent {
  const raw = extractFirstJson(text);
  const result = helmIntentSchema.safeParse(raw);
  if (!result.success) {
    const action =
      raw && typeof raw === 'object' && 'action' in raw
        ? String((raw as { action: unknown }).action)
        : undefined;
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    const known =
      action && !(HELM_ACTIONS as readonly string[]).includes(action)
        ? `unknown action "${action}" (valid: ${HELM_ACTIONS.join(' | ')})`
        : issues;
    throw new HelmIntentError(known || issues);
  }
  return result.data;
}
