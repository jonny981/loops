import type { Condition, Job, JobContext, Outcome } from './types.ts';
import { parseHandoff } from './job.ts';

export interface LastGateBriefOptions {
  maxOutputChars?: number;
}

export interface ConfidenceConditionOptions {
  threshold?: number;
  token?: string;
}

function stripHandoff(text: string): string {
  return parseHandoff(text).work;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function lastDecisionLine(
  text: string,
  token: string,
  values?: readonly string[],
): string | undefined {
  const work = stripHandoff(text);
  const tag = escapeRegExp(token);
  const allowed = values?.map((value) => value.toLowerCase());
  const line = work
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return undefined;
  const xml = new RegExp(`^<${tag}>\\s*([^<]+?)\\s*</${tag}>$`, 'i').exec(line);
  const colon = new RegExp(`^${tag}\\s*:\\s*(.+?)\\s*$`, 'i').exec(line);
  const value = (xml?.[1] ?? colon?.[1])?.trim();
  if (!value) return undefined;
  if (allowed && !allowed.includes(value.toLowerCase())) return undefined;
  return value;
}

export function confidenceFromText(
  text: string,
  token = 'confidence',
): number | undefined {
  const raw = lastDecisionLine(text, token);
  if (!raw) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(%)?$/.exec(raw);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  const value = match[2] || n > 1 ? n / 100 : n;
  if (value < 0 || value > 1) return undefined;
  return value;
}

function outcomeText(outcome: Outcome): string {
  const candidates = [
    typeof outcome.data === 'string' ? outcome.data : undefined,
  ].filter((value): value is string => Boolean(value));
  if (!candidates.length && outcome.summary) candidates.push(outcome.summary);
  return candidates.join('\n');
}

export function confidenceCondition(
  job: Job,
  opts: ConfidenceConditionOptions = {},
): Condition {
  const threshold = opts.threshold ?? 0.8;
  const token = opts.token ?? 'confidence';
  return async (ctx: JobContext) => {
    const outcome = await job(ctx);
    const output = outcomeText(outcome);
    const confidence = confidenceFromText(output, token);
    const met = outcome.status === 'pass' && confidence !== undefined && confidence >= threshold;
    return {
      met,
      confidence: confidence ?? 0,
      reason:
        confidence === undefined
          ? `missing ${token} decision token`
          : `${token} ${confidence.toFixed(2)} ${met ? 'meets' : 'below'} threshold ${threshold.toFixed(2)}`,
      output,
    };
  };
}

export function lastGateBrief(
  ctx: Pick<JobContext, 'lastGate'>,
  opts: LastGateBriefOptions = {},
): string {
  const gate = ctx.lastGate;
  if (!gate || gate.met) return '';
  const lines = [`Previous gate failed: ${gate.reason}`];
  if (gate.output) {
    const cap = opts.maxOutputChars ?? 2000;
    const output =
      gate.output.length <= cap
        ? gate.output
        : `${gate.output.slice(0, cap).trimEnd()}\n[gate output truncated]`;
    lines.push('', output);
  }
  return lines.join('\n');
}
