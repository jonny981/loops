/**
 * The no-file path: turn CLI flags into a standard loop (worker → until →
 * review). Validated with zod so a bad invocation fails with a clear message
 * rather than odd runtime behaviour. A definition file bypasses all of this and
 * builds the `Job` directly.
 */

import ms from 'ms';
import { z } from 'zod';

import { loop } from './core/loop.ts';
import { agentJob } from './core/job.ts';
import { agentCheck, bodyPassed, gateJob } from './core/condition.ts';
import type { Job } from './core/types.ts';
import type { EngineName } from './engines/engine.ts';

export const FlagSpec = z.object({
  prompt: z.string().min(1, 'a --prompt or --prompt-file is required when no definition file is given'),
  engine: z.string().optional(),
  workerModel: z.string().optional(),
  validatorModel: z.string().optional(),
  reviewerModel: z.string().optional(),
  max: z.number().int().positive().optional(),
  untilAgent: z.string().optional(),
  threshold: z.number().min(0).max(1).default(0.8),
  startAgent: z.string().optional(),
  review: z.string().optional(),
  reviewThreshold: z.number().min(0).max(1).default(0.85),
  interval: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
});

export type FlagSpec = z.infer<typeof FlagSpec>;

/** Parse a duration like `5m`, `30s`, `1h` (or a bare ms number) to ms. */
export function parseDuration(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const out = ms(value as ms.StringValue);
  if (typeof out !== 'number' || Number.isNaN(out)) {
    throw new Error(`invalid duration: "${value}" (try 30s, 5m, 1h)`);
  }
  return out;
}

/** Build the standard loop from flags. Parses + validates once, here. */
export function buildJobFromFlags(input: z.input<typeof FlagSpec>): Job {
  const spec = FlagSpec.parse(input);
  const engine = spec.engine as EngineName | undefined;

  const worker = agentJob({
    label: 'worker',
    engine,
    model: spec.workerModel,
    maxTokens: spec.maxTokens,
    // On a review-restart, fold the reviewer's objection into the next prompt
    // so the retry is informed rather than a blind repeat.
    prompt: (ctx) =>
      ctx.lastReview
        ? `${spec.prompt}\n\nYour previous attempt was REJECTED in review: ${ctx.lastReview.summary ?? ctx.lastReview.status}. Address that specifically this time.`
        : spec.prompt,
  });

  const until = spec.untilAgent
    ? agentCheck({ question: spec.untilAgent, threshold: spec.threshold, model: spec.validatorModel, engine })
    : bodyPassed();

  const start = spec.startAgent
    ? agentCheck({ question: spec.startAgent, threshold: 0.5, model: spec.validatorModel, engine })
    : undefined;

  const review = spec.review
    ? gateJob('review', agentCheck({ question: spec.review, threshold: spec.reviewThreshold, model: spec.reviewerModel, engine }))
    : undefined;

  return loop({
    name: 'main',
    body: worker,
    start,
    until,
    review,
    max: spec.max,
    delayMs: spec.interval,
  });
}
