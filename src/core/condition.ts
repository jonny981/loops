/**
 * Conditions answer a yes/no question against the run context and the latest
 * body outcome. They power a loop's `start`, `until`, and `stopOn` gates.
 *
 * Two flavours, same type:
 *   - deterministic (`predicate`, `bodyPassed`, `maxConfidence`)
 *   - agent-validated (`agentCheck`) — a small model returns a verdict +
 *     confidence, and the gate opens only above a threshold.
 *
 * `gateJob` lifts any Condition into a `Job`, so a reviewer can be expressed
 * as a condition and still slot into `loop({ review })`.
 */

import type {
  Condition,
  ConditionInput,
  ConditionResult,
  Outcome,
  RawPredicate,
  Job,
  JobContext,
} from './types.ts';
import { execa } from 'execa';

import type { EngineRef } from '../engines/engine.ts';
import { LoopError } from './errors.ts';

/**
 * Coerce any `ConditionInput` — a `Condition`, a bare predicate, or an array
 * mixing both — into the single `Condition` primitive. This is what lets
 * `until`/`start`/`stopOn` accept one or many items of either flavour.
 *
 * Arrays default to `all` (every item must hold); pass `'any'` for or-semantics.
 */
export function toCondition(
  input: ConditionInput,
  combine: 'all' | 'any' = 'all',
): Condition {
  if (Array.isArray(input)) {
    const conds = input.map((i) => toCondition(i, combine));
    return combine === 'any' ? any(...conds) : all(...conds);
  }
  return coerceOne(input);
}

/**
 * A single function input is ambiguous at the type level (a `Condition` and a
 * `RawPredicate` are both 2-arg functions), so we disambiguate at call time by
 * inspecting the return value: a boolean is a predicate, a `{met}` object is a
 * full condition result.
 */
function coerceOne(fn: Condition | RawPredicate): Condition {
  return async (ctx, last) => {
    const r = await (fn as (c: JobContext, l: Outcome | undefined) => unknown)(
      ctx,
      last,
    );
    if (typeof r === 'boolean') {
      return { met: r, reason: `predicate: ${r}` };
    }
    if (r && typeof r === 'object' && 'met' in r) {
      const res = r as { met: unknown };
      if (typeof res.met !== 'boolean') {
        throw new LoopError({
          code: 'VALIDATION',
          message: `condition returned a non-boolean "met": ${String(res.met)}`,
        });
      }
      return r as ConditionResult;
    }
    return { met: Boolean(r), reason: `coerced: ${String(r)}` };
  };
}

/** Deterministic predicate over context + last outcome. */
export function predicate(
  fn: (
    ctx: JobContext,
    last: Outcome | undefined,
  ) => boolean | Promise<boolean>,
  reason = 'predicate',
): Condition {
  return async (ctx, last) => {
    const met = await fn(ctx, last);
    return { met, reason: met ? `${reason}: true` : `${reason}: false` };
  };
}

/** Met when the most recent body outcome passed. */
export function bodyPassed(): Condition {
  return async (_ctx, last) => ({
    met: last?.status === 'pass',
    confidence: last?.confidence,
    reason: `last body status = ${last?.status ?? 'none'}`,
  });
}

/** Met when the last outcome carries confidence at or above `threshold`. */
export function minConfidence(threshold: number): Condition {
  return async (_ctx, last) => {
    const c = last?.confidence ?? 0;
    return {
      met: c >= threshold,
      confidence: c,
      reason: `confidence ${c.toFixed(2)} ${c >= threshold ? '>=' : '<'} ${threshold}`,
    };
  };
}

/**
 * Deterministic gate that runs a shell command and is met on exit code 0. This
 * is the honest convergence signal for coding loops: pair it with an `agentCheck`
 * in an `until` array so the loop stops only when the tests ACTUALLY pass AND a
 * judge agrees the work matches intent — never on a model's self-report alone.
 * Runs in `cwd` (default: the process working dir), inherits the run's abort
 * signal, and never throws (a spawn failure counts as "not met").
 */
export function commandSucceeds(
  command: string,
  args: string[] = [],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Condition {
  return async (ctx) => {
    try {
      const r = await execa(command, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        cancelSignal: ctx.signal,
        reject: false,
        stdin: 'ignore',
      });
      return {
        met: r.exitCode === 0,
        reason: `\`${command}\` exited ${r.exitCode ?? '?'}`,
      };
    } catch (e) {
      return {
        met: false,
        reason: `\`${command}\` failed to run: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };
}

export const always: Condition = async () => ({ met: true, reason: 'always' });
export const never: Condition = async () => ({ met: false, reason: 'never' });

// ── Combinators ───────────────────────────────────────────────────────────

export function not(c: ConditionInput): Condition {
  const cond = toCondition(c);
  return async (ctx, last) => {
    const r = await cond(ctx, last);
    return {
      met: !r.met,
      confidence: r.confidence,
      reason: `not(${r.reason})`,
    };
  };
}

/** Met only when every input holds (short-circuits on the first failure). */
export function all(...inputs: ConditionInput[]): Condition {
  const conds = inputs.map((i) => toCondition(i));
  return async (ctx, last) => {
    const results: ConditionResult[] = [];
    for (const c of conds) {
      const r = await c(ctx, last);
      results.push(r);
      if (!r.met) return { met: false, reason: `all -> failed: ${r.reason}` };
    }
    return {
      met: true,
      reason: `all(${results.map((r) => r.reason).join(' & ')})`,
    };
  };
}

/** Met when any input holds (short-circuits on the first success). */
export function any(...inputs: ConditionInput[]): Condition {
  const conds = inputs.map((i) => toCondition(i));
  return async (ctx, last) => {
    const reasons: string[] = [];
    for (const c of conds) {
      const r = await c(ctx, last);
      reasons.push(r.reason);
      if (r.met)
        return {
          met: true,
          confidence: r.confidence,
          reason: `any -> ${r.reason}`,
        };
    }
    return { met: false, reason: `any(${reasons.join(' | ')})` };
  };
}

/**
 * Met when at least `k` of the inputs hold. The honest hedge against a single
 * agent judge's self-reported confidence: ask N independent judges and require a
 * quorum (e.g. `quorum(2, j, j, j)`). All inputs run in parallel; a judge that
 * throws counts as a "no" vote rather than sinking the whole gate. Each input
 * may hit a model, so size N with cost in mind. Reported confidence is the mean
 * of the holding inputs' confidences.
 */
export function quorum(k: number, ...inputs: ConditionInput[]): Condition {
  if (k < 1 || k > inputs.length)
    throw new LoopError({
      code: 'CONFIG',
      message: `quorum requires 1 <= k <= inputs (got k=${k}, n=${inputs.length})`,
    });
  const conds = inputs.map((i) => toCondition(i));
  return async (ctx, last) => {
    const settled = await Promise.allSettled(conds.map((c) => c(ctx, last)));
    const results: ConditionResult[] = settled.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            met: false,
            reason: `judge errored: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
          },
    );
    const held = results.filter((r) => r.met);
    const confs = held
      .map((r) => r.confidence)
      .filter((c): c is number => typeof c === 'number');
    const confidence = confs.length
      ? confs.reduce((a, b) => a + b, 0) / confs.length
      : undefined;
    return {
      met: held.length >= k,
      confidence,
      reason: `quorum ${held.length}/${inputs.length} held (need ${k})`,
    };
  };
}

// ── Agent-validated condition ──────────────────────────────────────────────

export interface AgentCheckConfig {
  /** The yes/no question the validator must answer. */
  question: string;
  /** Open the gate only at/above this confidence (0..1). Default 0.8. */
  threshold?: number;
  /** Small/cheap model recommended. A bare string — provider-agnostic. */
  model?: string;
  /** Engine for validation: a registered name, your own `Engine`, or default. */
  engine?: EngineRef;
  /**
   * What the validator sees. By default: the last outcome's summary/data plus
   * the shared state. Override to feed something bespoke.
   */
  context?: (ctx: JobContext, last: Outcome | undefined) => string;
  maxTokens?: number;
}

interface Verdict {
  verdict: 'yes' | 'no';
  confidence: number;
  reason: string;
}

function defaultContext(ctx: JobContext, last: Outcome | undefined): string {
  const parts: string[] = [];
  if (last?.summary) parts.push(`Last outcome summary: ${last.summary}`);
  if (last?.status) parts.push(`Last outcome status: ${last.status}`);
  if (last?.data !== undefined)
    parts.push(`Last outcome data: ${safeJson(last.data)}`);
  const stateKeys = Object.keys(ctx.state);
  if (stateKeys.length) parts.push(`Shared state: ${safeJson(ctx.state)}`);
  return parts.join('\n') || '(no prior context)';
}

function safeJson(value: unknown, limit = 4000): string {
  try {
    const s = JSON.stringify(value, null, 2) ?? String(value);
    return s.length > limit ? `${s.slice(0, limit)}… (truncated)` : s;
  } catch {
    return String(value);
  }
}

/** Yield each top-level *balanced* JSON object in the text (strings/escapes aware). */
function* balancedObjects(text: string): Generator<string> {
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start === -1) return;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) return; // unbalanced tail — nothing more to find
    yield text.slice(start, end + 1);
    cursor = end + 1;
  }
}

function toVerdict(obj: Record<string, unknown>): Verdict {
  const verdict = obj.verdict === 'yes' ? 'yes' : 'no';
  // Confidence is mandatory (the validator system prompt demands it). A missing
  // or non-numeric confidence is a low-quality verdict, NOT an implicit "fully
  // confident" — so it defaults to 0 and a thresholded gate fails closed. For a
  // convergence/quality gate a false "done" (opening when the work isn't really
  // finished) is worse than one more iteration, so the sceptical default is the
  // correct one; the strengthened prompt keeps a genuine omission rare.
  const confidence =
    typeof obj.confidence === 'number' ? clamp01(obj.confidence) : 0;
  const reason =
    typeof obj.reason === 'string' ? obj.reason : '(no reason given)';
  return { verdict, confidence, reason };
}

/**
 * Pull a verdict from a model reply. Models often wrap JSON in prose or restate
 * the input as a first object, so we scan every balanced object and prefer the
 * one that actually carries a `verdict` key (falling back to the first object).
 */
function parseVerdict(text: string): Verdict {
  let fallback: Record<string, unknown> | undefined;
  for (const candidate of balancedObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      continue;
    const obj = parsed as Record<string, unknown>;
    if ('verdict' in obj) return toVerdict(obj);
    fallback ??= obj;
  }
  if (fallback) return toVerdict(fallback);
  throw new LoopError({
    code: 'VALIDATION',
    message: `validator returned no JSON verdict: ${text.slice(0, 200)}`,
  });
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

const VALIDATOR_SYSTEM =
  'You are a strict, sceptical evaluator. You judge whether a stated condition ' +
  'is truly met given the evidence. Do not be generous. The `confidence` field ' +
  'is MANDATORY: always include a number in 0..1 for how sure you are, and when ' +
  'in doubt give a LOW number — never omit it (an omitted confidence is treated ' +
  'as zero). Respond with ONLY a single JSON object and no other text:\n' +
  '{"verdict":"yes"|"no","confidence":<number 0..1>,"reason":"<one sentence>"}';

/**
 * A Condition decided by a (preferably small) model. The gate opens only when
 * the verdict is "yes" AND confidence >= threshold.
 */
export function agentCheck(config: AgentCheckConfig): Condition {
  const threshold = config.threshold ?? 0.8;
  return async (ctx, last) => {
    const engine = config.engine
      ? ctx.resolveEngine(config.engine)
      : ctx.engine;
    const contextText = (config.context ?? defaultContext)(ctx, last);
    const prompt =
      `CONDITION TO EVALUATE:\n${config.question}\n\n` +
      `EVIDENCE:\n${contextText}\n\n` +
      'Return the JSON verdict now.';

    let result;
    try {
      result = await engine.run(
        {
          prompt,
          system: VALIDATOR_SYSTEM,
          model: config.model,
          maxTokens: config.maxTokens ?? 512,
        },
        (e) => {
          if (e.type === 'usage') {
            ctx.emit({
              kind: 'engine:usage',
              ts: Date.now(),
              path: [...ctx.path],
              model: e.model,
              usage: e.usage,
            });
          }
        },
        ctx.signal,
      );
    } catch (e) {
      // phase is left to the caller (loop.ts) — this condition may be a
      // start/until/stopOn/review gate and cannot know which.
      throw LoopError.from(e, { code: 'ENGINE', path: ctx.path });
    }

    let v: Verdict;
    try {
      v = parseVerdict(result.text);
    } catch {
      // A flaky or malformed verdict must not crash the whole run; fail
      // sceptically (gate stays closed) and let the loop continue/exhaust.
      return {
        met: false,
        confidence: 0,
        reason: `unparseable verdict: ${result.text.slice(0, 120)}`,
      };
    }
    const met = v.verdict === 'yes' && v.confidence >= threshold;
    return {
      met,
      confidence: v.confidence,
      reason: `${v.verdict} @ ${v.confidence.toFixed(2)} (need ${threshold}) — ${v.reason}`,
    };
  };
}

/**
 * Lift a Condition (or one-or-many `ConditionInput`) into a Job: `pass` when
 * met, `fail` otherwise. This is how a reviewer becomes a drop-in `review` job
 * (`gateJob('review', agentCheck(...))`).
 */
export function gateJob(label: string, condition: ConditionInput): Job {
  const cond = toCondition(condition);
  return async (ctx) => {
    ctx.emit({ kind: 'job:start', ts: Date.now(), path: [...ctx.path], label });
    const r = await cond(ctx, ctx.lastOutcome);
    const outcome: Outcome = {
      status: r.met ? 'pass' : 'fail',
      confidence: r.confidence,
      summary: r.reason,
    };
    ctx.emit({
      kind: 'job:end',
      ts: Date.now(),
      path: [...ctx.path],
      label,
      outcome,
    });
    return outcome;
  };
}
