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
import { resolveEnv } from './env-overlay.ts';
import { setLabel, setMeta } from './describe.ts';
import { assertBudget } from './budget.ts';
import { resolveSystem, type AgentDef } from './agent.ts';
import { GhForge } from './forge.ts';
import { truncate } from './text.ts';
import { redactSecrets, redactEnvValues, scrubCapture } from './redact.ts';

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
 * `opts.env` pins vars for this one gate command; it is the most specific
 * layer, over any `withEnv` overlay and the running environment's vars.
 */
export function commandSucceeds(
  command: string,
  args: string[] = [],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Condition {
  return setLabel(async (ctx) => {
    try {
      const env = resolveEnv(ctx, opts.env);
      const r = await execa(command, args, {
        cwd: opts.cwd ?? ctx.workspace.dir,
        timeout: opts.timeoutMs,
        cancelSignal: ctx.signal,
        reject: false,
        stdin: 'ignore',
        env,
      });
      if (r.exitCode === 0) {
        return { met: true, reason: `\`${command}\` exited 0` };
      }
      return {
        met: false,
        reason: `\`${command}\` exited ${r.exitCode ?? '?'}`,
        // The evidence behind the failure, in the same shape `reviewContext`
        // gives a judge. Scrubbed (`scrubCapture`) because it flows into JSONL
        // event records — a failing command often echoes its config, and a
        // pinned credential's shape is unknowable to pattern scrubbing.
        output:
          `exit: ${r.exitCode ?? '(command did not run)'}\n\n` +
          `stdout:\n${scrubCapture(r.stdout ?? '', env, 4000)}\n\n` +
          `stderr:\n${scrubCapture(r.stderr ?? '', env, 4000)}`,
      };
    } catch (e) {
      return {
        met: false,
        reason: `\`${command}\` failed to run: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }, `${command}${args.length ? ` ${args.join(' ')}` : ''}`);
}

/**
 * True when the branch's open PR has all required checks green — a synchronous
 * "CI is green" gate over the `Forge`. Use it as `mergeJob`'s `when`, or anywhere a
 * `Condition` is taken, for the blocking path; prefer `mergeJob({ auto: true })` to
 * hand the same gate to GitHub non-blockingly. No PR / no branch → not met.
 */
export function forgeChecks(): Condition {
  return async (ctx) => {
    const branch = ctx.workspace.branch;
    if (!branch) return { met: false, reason: 'no branch checked out' };
    const forge = ctx.forge ?? new GhForge();
    const fopts = { cwd: ctx.workspace.dir, signal: ctx.signal };
    const pr = await forge.viewPr(branch, fopts);
    if (!pr) return { met: false, reason: `no open PR for "${branch}"` };
    const ok = await forge.checksPass(pr, fopts);
    return {
      met: ok,
      reason: ok ? 'required checks pass' : 'required checks not green',
    };
  };
}

export const always: Condition = async () => ({ met: true, reason: 'always' });
export const never: Condition = async () => ({ met: false, reason: 'never' });

// ── Combinators ───────────────────────────────────────────────────────────

/** Inverts a condition. The inner result's `output` is carried through unchanged. */
export function not(c: ConditionInput): Condition {
  const cond = toCondition(c);
  return async (ctx, last) => {
    const r = await cond(ctx, last);
    return {
      met: !r.met,
      confidence: r.confidence,
      reason: `not(${r.reason})`,
      output: r.output,
    };
  };
}

/**
 * Met only when every input holds (short-circuits on the first failure).
 * On failure the FAILING item's `output` is carried; a success carries none.
 */
export function all(...inputs: ConditionInput[]): Condition {
  const conds = inputs.map((i) => toCondition(i));
  return async (ctx, last) => {
    const results: ConditionResult[] = [];
    for (const c of conds) {
      const r = await c(ctx, last);
      results.push(r);
      if (!r.met)
        return {
          met: false,
          reason: `all -> failed: ${r.reason}`,
          output: r.output,
        };
    }
    return {
      met: true,
      reason: `all(${results.map((r) => r.reason).join(' & ')})`,
    };
  };
}

/**
 * Met when any input holds (short-circuits on the first success).
 * On success THAT item's `output` is carried; on failure, the first defined
 * `output` among the collected failures.
 */
export function any(...inputs: ConditionInput[]): Condition {
  const conds = inputs.map((i) => toCondition(i));
  return async (ctx, last) => {
    const reasons: string[] = [];
    let output: string | undefined;
    for (const c of conds) {
      const r = await c(ctx, last);
      reasons.push(r.reason);
      if (r.met)
        return {
          met: true,
          confidence: r.confidence,
          reason: `any -> ${r.reason}`,
          output: r.output,
        };
      output ??= r.output;
    }
    return { met: false, reason: `any(${reasons.join(' | ')})`, output };
  };
}

/**
 * Met when at least `k` of the inputs hold. The honest hedge against a single
 * agent judge's self-reported confidence: ask N independent judges and require a
 * quorum (e.g. `quorum(2, j, j, j)`). All inputs run in parallel; a judge that
 * throws counts as a "no" vote rather than sinking the whole gate. Each input
 * may hit a model, so size N with cost in mind. Reported confidence is the mean
 * of the holding inputs' confidences. On failure the first defined `output`
 * among the non-holding voters is carried; a success carries none.
 */
export function quorum(k: number, ...inputs: ConditionInput[]): Condition {
  if (k < 1 || k > inputs.length)
    throw new LoopError({
      code: 'CONFIG',
      message: `quorum requires 1 <= k <= inputs (got k=${k}, n=${inputs.length})`,
    });
  const conds = inputs.map((i) => toCondition(i));
  return setLabel(async (ctx, last) => {
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
    const met = held.length >= k;
    return {
      met,
      confidence,
      reason: `quorum ${held.length}/${inputs.length} held (need ${k})`,
      output: met
        ? undefined
        : results.find((r) => !r.met && r.output !== undefined)?.output,
    };
  }, `quorum ${k}/${inputs.length}`);
}

// ── Agent-validated condition ──────────────────────────────────────────────

export interface AgentCheckConfig {
  /** The yes/no question the validator must answer. */
  question: string;
  /** Open the gate only at/above this confidence (0..1). Default 0.8. */
  threshold?: number;
  /** Small/cheap model recommended. A bare string — provider-agnostic. */
  model?: string;
  /**
   * Give the judge a persona — an `AgentDef` whose resolved system (persona +
   * skills) is prepended to the validator's scoring instructions, so a reviewer
   * can be a named specialist (e.g. an adversarial reviewer) instead of an
   * anonymous yes/no. The validator's output contract stays authoritative (it
   * comes last); `model` falls back to the agent's `model`. Mirrors `agentJob`.
   */
  agent?: AgentDef;
  /** Engine for validation: a registered name, your own `Engine`, or default. */
  engine?: EngineRef;
  /**
   * Working directory for the judge's engine turn — a tool-using judge may
   * need the workspace to read the artifact it is ruling on. Absent means the
   * engine's default; deliberately NOT defaulted to the loop workspace.
   */
  cwd?: string;
  /**
   * Time cap on the judge turn, passed through to the engine. The
   * anthropic-api engine ignores it.
   */
  timeoutMs?: number;
  /**
   * What the validator sees. By default: the last outcome's summary/data plus
   * the shared state. Override to feed something bespoke — may be async, since a
   * judge often gathers evidence (read the artifact, ground on the history, run a
   * probe) before ruling. A blind judge cannot honestly confirm correctness, so
   * give it the thing it is meant to be reviewing.
   */
  context?: (ctx: JobContext, last: Outcome | undefined) => string | Promise<string>;
  maxTokens?: number;
  /**
   * Score these named dimensions (0..1 each) instead of a single yes/no
   * confidence. The gate opens when the GEOMETRIC MEAN of the scores is
   * >= `threshold`, so one weak dimension drags the whole verdict down. A more
   * honest judge than a lone self-reported number, e.g.
   * `['intent match', 'evidence quality', 'outcome coherence']`.
   */
  dimensions?: string[];
  /**
   * Parse a free-form review that closes with `<confidence>N%</confidence>`
   * (N is 0-100) instead of forcing a JSON shape. The gate opens at/above
   * `threshold`; the reviewer's prose before the tag becomes the gate's `reason`,
   * so a failing review carries its findings to the next iteration (`lastReview`).
   * More robust than scraping JSON, and the natural fit for a report-then-rate
   * reviewer persona. Takes precedence over `dimensions`.
   */
  confidenceTag?: boolean;
  /**
   * Cap on the findings excerpt embedded in the `confidenceTag` gate `reason`.
   * Default 280. The FULL findings always travel via `ConditionResult.output`.
   */
  maxReasonChars?: number;
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

const CONFIDENCE_TAG_SYSTEM =
  'You are a rigorous, report-only reviewer. Do not edit anything and do not imply you ' +
  'will. Assess the evidence against the stated condition, listing each concern tied to a ' +
  'concrete location and a concrete failure scenario (not a vibe). Judge against the stated ' +
  'contract, not an ideal: do not penalise the absence of hardening the contract does not ' +
  'require, and when the evidence meets the contract and you cannot name a concrete fault, ' +
  'say so plainly. Close with a single final line and nothing after it: ' +
  '`<confidence>N%</confidence>` — N is an integer 0-100, where 100 means you found no ' +
  'genuine contract violation or real bug, and below 100 means at least one concrete, ' +
  'addressable concern is open.';

/**
 * Pull the last `<confidence>N%</confidence>` from a review. The prose before the
 * tag is the findings, carried into the gate `reason` so a failing review delivers
 * its concerns to the next iteration. `N` may be a percent (0-100) or a fraction.
 */
function parseConfidenceTag(
  text: string,
): { confidence: number; findings: string } | null {
  const re = /<confidence>\s*([0-9]+(?:\.[0-9]+)?)\s*%?\s*<\/confidence>/gi;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  let n = parseFloat(last[1]!);
  if (n > 1) n = n / 100; // percent → fraction
  return { confidence: clamp01(n), findings: text.slice(0, last.index).trim() };
}

/** System prompt for the multi-dimension scoring variant of `agentCheck`. */
function validatorScoreSystem(dimensions: string[]): string {
  return (
    'You are a strict, sceptical evaluator. Score how well the condition is met ' +
    'on EACH named dimension, from 0 (not at all) to 1 (fully). Do not be ' +
    'generous; when in doubt score low. Respond with ONLY a single JSON object ' +
    'and no other text:\n' +
    `{"scores":{${dimensions.map((d) => `"${d}":<0..1>`).join(',')}},"reason":"<one sentence>"}`
  );
}

/** Geometric mean — any zero (a fully-failed dimension) drags the result to 0. */
function geometricMean(values: number[]): number {
  if (!values.length) return 0;
  if (values.some((v) => v <= 0)) return 0;
  return Math.exp(values.reduce((a, b) => a + Math.log(b), 0) / values.length);
}

interface ScoreVerdict {
  score: number;
  scores: Record<string, number>;
  reason: string;
}

/** Cap on a judge reply / findings carried in `ConditionResult.output`. */
const JUDGE_OUTPUT_CAP = 20_000;

/**
 * Scrub + cap a judge's (already env-scrubbed) reply before it becomes
 * `ConditionResult.output`, which flows into JSONL event records.
 */
function judgeOutput(text: string): string {
  return scrubCapture(text, undefined, JUDGE_OUTPUT_CAP);
}

/** Pull per-dimension scores from a model reply; any missing dimension is 0. */
function parseScores(text: string, dimensions: string[]): ScoreVerdict {
  for (const candidate of balancedObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      continue;
    const raw = (parsed as Record<string, unknown>).scores;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const scoreObj = raw as Record<string, unknown>;
    const scores: Record<string, number> = {};
    for (const d of dimensions) {
      const val = scoreObj[d];
      scores[d] = typeof val === 'number' ? clamp01(val) : 0;
    }
    const reasonField = (parsed as Record<string, unknown>).reason;
    return {
      score: geometricMean(dimensions.map((d) => scores[d]!)),
      scores,
      reason:
        typeof reasonField === 'string' ? reasonField : '(no reason given)',
    };
  }
  throw new LoopError({
    code: 'VALIDATION',
    message: `validator returned no JSON scores: ${text.slice(0, 200)}`,
  });
}

/**
 * A Condition decided by a (preferably small) model. With a single yes/no
 * question the gate opens when the verdict is "yes" AND confidence >= threshold.
 * With `dimensions`, the model scores each dimension 0..1 and the gate opens
 * when their geometric mean >= threshold — a more honest judge than one number.
 */
export function agentCheck(config: AgentCheckConfig): Condition {
  const threshold = config.threshold ?? 0.8;
  const confidenceTag = config.confidenceTag === true;
  const maxReasonChars = config.maxReasonChars ?? 280;
  const dimensions =
    !confidenceTag && config.dimensions?.length ? config.dimensions : undefined;
  return setLabel(async (ctx, last) => {
    const engine = config.engine
      ? ctx.resolveEngine(config.engine)
      : ctx.engine;
    const contextText = await (config.context ?? defaultContext)(ctx, last);
    const closing = confidenceTag
      ? 'Write your review now, then close with `<confidence>N%</confidence>`.'
      : `Return the JSON ${dimensions ? 'scores' : 'verdict'} now.`;
    const prompt =
      `CONDITION TO EVALUATE:\n${config.question}\n\n` +
      `EVIDENCE:\n${contextText}\n\n` +
      closing;

    // The validator's output contract stays authoritative (last); an optional
    // agent persona is prepended so the judge has a stance, not just a question.
    const baseSystem = confidenceTag
      ? CONFIDENCE_TAG_SYSTEM
      : dimensions
        ? validatorScoreSystem(dimensions)
        : VALIDATOR_SYSTEM;
    const system = config.agent ? `${resolveSystem(config.agent)}\n\n${baseSystem}` : baseSystem;

    // A tool-using judge needs the same pinned vars as the work it rules on.
    const env = resolveEnv(ctx);
    let result;
    try {
      assertBudget(ctx); // count validator calls against the run's token budget
      result = await engine.run(
        {
          prompt,
          system,
          model: config.model ?? config.agent?.model,
          // A report-then-rate reviewer needs room for findings before the tag.
          maxTokens: config.maxTokens ?? (confidenceTag ? 2048 : 512),
          cwd: config.cwd,
          timeoutMs: config.timeoutMs,
          env,
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

    // A judge's reply flows into `reason`/`output` (persisted records), and a
    // tool-using judge may echo the pinned vars it was handed — scrub their
    // exact values once, up front, so every downstream path is clean.
    const text = redactEnvValues(result.text, env);

    if (confidenceTag) {
      const parsed = parseConfidenceTag(text);
      if (!parsed)
        return {
          met: false,
          confidence: 0,
          reason: `no <confidence> tag: ${redactSecrets(text).slice(0, 140)}`,
          output: judgeOutput(text),
        };
      const pct = Math.round(parsed.confidence * 100);
      const need = Math.round(threshold * 100);
      // `reason` flows into the same persisted records as `output`, so it gets
      // the same scrub — redacted BEFORE excerpting, so a secret split at the
      // cut cannot survive.
      const findings = redactSecrets(parsed.findings);
      return {
        met: parsed.confidence >= threshold,
        confidence: parsed.confidence,
        reason: `confidence ${pct}% (need ${need}%)${findings ? ` — ${findings.slice(0, maxReasonChars)}` : ''}`,
        // The FULL findings — what lets a failing check brief a fix-up body
        // without re-running the judge. A tag-only reply has no evidence to carry.
        output: findings ? truncate(findings, JUDGE_OUTPUT_CAP) : undefined,
      };
    }

    if (dimensions) {
      let sv: ScoreVerdict;
      try {
        sv = parseScores(text, dimensions);
      } catch {
        return {
          met: false,
          confidence: 0,
          reason: `unparseable scores: ${redactSecrets(text).slice(0, 120)}`,
          output: judgeOutput(text),
        };
      }
      const detail = dimensions
        .map((d) => `${d}=${sv.scores[d]!.toFixed(2)}`)
        .join(', ');
      return {
        met: sv.score >= threshold,
        confidence: sv.score,
        // The judge's free-prose reason gets the same scrub as `output` — it
        // flows into the same persisted records.
        reason: `geo ${sv.score.toFixed(2)} (need ${threshold}) [${detail}] — ${redactSecrets(sv.reason)}`,
        output: judgeOutput(text),
      };
    }

    let v: Verdict;
    try {
      v = parseVerdict(text);
    } catch {
      // A flaky or malformed verdict must not crash the whole run; fail
      // sceptically (gate stays closed) and let the loop continue/exhaust.
      return {
        met: false,
        confidence: 0,
        reason: `unparseable verdict: ${redactSecrets(text).slice(0, 120)}`,
        output: judgeOutput(text),
      };
    }
    const met = v.verdict === 'yes' && v.confidence >= threshold;
    return {
      met,
      confidence: v.confidence,
      reason: `${v.verdict} @ ${v.confidence.toFixed(2)} (need ${threshold}) — ${redactSecrets(v.reason)}`,
      output: judgeOutput(text),
    };
  }, `judge "${config.question}" >=${threshold}`);
}

/**
 * Lift a Condition (or one-or-many `ConditionInput`) into a Job: `pass` when
 * met, `fail` otherwise. This is how a reviewer becomes a drop-in `review` job
 * (`gateJob('review', agentCheck(...))`). The condition's diagnostic `output`
 * rides `Outcome.data`, so it survives the Job boundary.
 */
export function gateJob(label: string, condition: ConditionInput): Job {
  const cond = toCondition(condition);
  return setMeta(async (ctx) => {
    ctx.emit({ kind: 'job:start', ts: Date.now(), path: [...ctx.path], label });
    const r = await cond(ctx, ctx.lastOutcome);
    const outcome: Outcome = {
      status: r.met ? 'pass' : 'fail',
      confidence: r.confidence,
      summary: r.reason,
    };
    if (r.output !== undefined) outcome.data = r.output;
    ctx.emit({
      kind: 'job:end',
      ts: Date.now(),
      path: [...ctx.path],
      label,
      outcome,
    });
    return outcome;
  }, { kind: 'gate', name: label });
}
