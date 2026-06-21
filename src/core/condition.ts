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
import type { EngineRef } from '../engines/engine.ts';
import { LoopError } from './errors.ts';

/**
 * Coerce any `ConditionInput` — a `Condition`, a bare predicate, or an array
 * mixing both — into the single `Condition` primitive. This is what lets
 * `until`/`start`/`stopOn` accept one or many items of either flavour.
 *
 * Arrays default to `all` (every item must hold); pass `'any'` for or-semantics.
 */
export function toCondition(input: ConditionInput, combine: 'all' | 'any' = 'all'): Condition {
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
    const r = await (fn as (c: JobContext, l: Outcome | undefined) => unknown)(ctx, last);
    if (typeof r === 'boolean') {
      return { met: r, reason: `predicate: ${r}` };
    }
    if (r && typeof r === 'object' && 'met' in r) {
      return r as ConditionResult;
    }
    return { met: Boolean(r), reason: `coerced: ${String(r)}` };
  };
}

/** Deterministic predicate over context + last outcome. */
export function predicate(
  fn: (ctx: JobContext, last: Outcome | undefined) => boolean | Promise<boolean>,
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

export const always: Condition = async () => ({ met: true, reason: 'always' });
export const never: Condition = async () => ({ met: false, reason: 'never' });

// ── Combinators ───────────────────────────────────────────────────────────

export function not(c: ConditionInput): Condition {
  const cond = toCondition(c);
  return async (ctx, last) => {
    const r = await cond(ctx, last);
    return { met: !r.met, confidence: r.confidence, reason: `not(${r.reason})` };
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
    return { met: true, reason: `all(${results.map((r) => r.reason).join(' & ')})` };
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
      if (r.met) return { met: true, confidence: r.confidence, reason: `any -> ${r.reason}` };
    }
    return { met: false, reason: `any(${reasons.join(' | ')})` };
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
  if (last?.data !== undefined) parts.push(`Last outcome data: ${safeJson(last.data)}`);
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

/** Extract the first balanced JSON object from a model reply. */
function parseVerdict(text: string): Verdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new LoopError({ code: 'VALIDATION', message: `validator returned no JSON: ${text.slice(0, 200)}` });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new LoopError({ code: 'VALIDATION', message: 'validator JSON did not parse', cause: e });
  }
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict === 'yes' ? 'yes' : 'no';
  const confidence = clamp01(typeof obj.confidence === 'number' ? obj.confidence : 0);
  const reason = typeof obj.reason === 'string' ? obj.reason : '(no reason given)';
  return { verdict, confidence, reason };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

const VALIDATOR_SYSTEM =
  'You are a strict, sceptical evaluator. You judge whether a stated condition ' +
  'is truly met given the evidence. Do not be generous. Respond with ONLY a ' +
  'single JSON object and no other text:\n' +
  '{"verdict":"yes"|"no","confidence":<number 0..1>,"reason":"<one sentence>"}';

/**
 * A Condition decided by a (preferably small) model. The gate opens only when
 * the verdict is "yes" AND confidence >= threshold.
 */
export function agentCheck(config: AgentCheckConfig): Condition {
  const threshold = config.threshold ?? 0.8;
  return async (ctx, last) => {
    const engine = config.engine ? ctx.resolveEngine(config.engine) : ctx.engine;
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
            ctx.emit({ kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: e.model, usage: e.usage });
          }
        },
        ctx.signal,
      );
    } catch (e) {
      throw LoopError.from(e, { code: 'ENGINE', phase: 'until', path: ctx.path });
    }

    const v = parseVerdict(result.text);
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
    const r = await cond(ctx, ctx.state.lastOutcome as Outcome | undefined);
    const outcome: Outcome = {
      status: r.met ? 'pass' : 'fail',
      confidence: r.confidence,
      summary: r.reason,
    };
    ctx.emit({ kind: 'job:end', ts: Date.now(), path: [...ctx.path], label, outcome });
    return outcome;
  };
}
