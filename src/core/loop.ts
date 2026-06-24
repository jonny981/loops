/**
 * The loop primitive. `loop(config)` returns a `Job`, so loops nest by simply
 * passing one as another's `body` or `review`.
 *
 * Lifecycle of one loop:
 *   1. `start` gate (one-or-many conditions) — unmet => `aborted`.
 *   2. repeat, up to `max`:
 *        run `body` (fresh context each turn) → `stopOn`? → `until`?
 *        if `until` is met and there's a `review`, run it:
 *          review `pass`  => loop completes `pass`
 *          review !pass   => re-enter the loop  ← "review fails, run main loop again"
 *      with no `until`, a `pass` body ends the loop; `max` reached => `exhausted`.
 *   3. `onComplete` post-action runs once, whatever the status.
 *
 * The review-restart cycle is bounded: by `max` (shared with ordinary
 * iterations) and, independently, by `maxReviewRestarts`. The failed review is
 * threaded to the next iteration as `ctx.lastReview` so the body can act on it.
 *
 * Every piece of user code (conditions, the body, hooks, the review) is guarded:
 * a throw is classified and ends the loop with `fail`, but `loop:end` and the
 * `onComplete` post-action still run.
 */

import type { JobContext, LoopConfig, Outcome, Job } from './types.ts';
import { childContext } from './context.ts';
import { toCondition } from './condition.ts';
import { commitJob, type CommitJobConfig } from './job.ts';
import { LoopError, type LoopPhase } from './errors.ts';
import { isLimitError, waitMsFor } from './limits.ts';

const VALID_STATUS = new Set<Outcome['status']>([
  'pass',
  'fail',
  'aborted',
  'exhausted',
  'paused',
]);

/** A limit policy's verdict for one limited iteration. */
type LimitAction =
  | { kind: 'wait'; waitMs: number }
  | { kind: 'pause'; reason: string };

/**
 * Decide what to do about a limit error under the run's `onLimit` policy.
 *   - `fail`         → never handled here (caller treats it as fatal).
 *   - `auto`         → wait when the reset is known AND within `maxWaitMs`
 *                      (BUDGET never refreshes, so it always pauses).
 *   - `wait`         → wait whenever the reset is known (no ceiling).
 *   - `exit-resume`  → never wait; always pause.
 */
function decideLimit(error: LoopError, ctx: JobContext): LimitAction {
  const reason = error.message;
  if (ctx.onLimit === 'exit-resume') return { kind: 'pause', reason };
  const waitMs = waitMsFor(error);
  if (waitMs == null) return { kind: 'pause', reason };
  if (ctx.onLimit === 'wait') return { kind: 'wait', waitMs };
  // auto: wait only within the ceiling.
  if (waitMs <= ctx.maxWaitMs) return { kind: 'wait', waitMs };
  return {
    kind: 'pause',
    reason: `${reason} (reset in ${Math.round(waitMs / 1000)}s exceeds maxWait ${Math.round(ctx.maxWaitMs / 1000)}s)`,
  };
}
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

export function loop(config: LoopConfig): Job {
  if (!config.name)
    throw new LoopError({
      code: 'CONFIG',
      message: 'loop() requires a non-empty name',
    });
  const start = config.start ? toCondition(config.start) : undefined;
  const until = config.until ? toCondition(config.until) : undefined;
  const stopOn = config.stopOn ? toCondition(config.stopOn) : undefined;
  const onError = config.retry?.onError ?? 'continue';

  return async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();

    let lastReview: Outcome | undefined;
    let iteration = 0;
    const ctxAt = (iter: number, lastOutcome?: Outcome): JobContext =>
      childContext(parent, {
        depth,
        path,
        iteration: iter,
        lastOutcome,
        lastReview,
      });

    parent.emit({ kind: 'loop:start', ts: ts(), path, depth, max: config.max });

    // At a milestone (the loop converged), record one structured checkpoint
    // commit. `commitJob` composes the body from the draft the iterations
    // accumulated, so the commit carries the reasoned "way", not a per-iteration
    // fragment. Best-effort: a failed recording is surfaced but never undoes a
    // genuine convergence.
    const commitCfg: CommitJobConfig | undefined = config.commit
      ? config.commit === true
        ? {
            label: `${config.name}:checkpoint`,
            subject: (_c, l) =>
              l?.summary?.split('\n')[0]?.trim().slice(0, 72) ||
              `chore(${config.name}): checkpoint`,
          }
        : { label: `${config.name}:checkpoint`, ...config.commit }
      : undefined;
    const checkpoint = commitCfg ? commitJob(commitCfg) : undefined;
    const recordMilestone = async (ctx: JobContext): Promise<void> => {
      if (!checkpoint) return;
      const outcome = await checkpoint(ctx);
      if (outcome.status !== 'pass') {
        parent.emit({
          kind: 'error',
          ts: ts(),
          path,
          message: `checkpoint commit did not pass: ${outcome.summary ?? outcome.status}`,
          code: outcome.error?.code ?? 'UNKNOWN',
        });
      }
    };

    const finish = async (
      outcome: Outcome,
      iterations: number,
    ): Promise<Outcome> => {
      parent.emit({ kind: 'loop:end', ts: ts(), path, outcome, iterations });
      if (config.onComplete) {
        try {
          await config.onComplete(outcome, ctxAt(iterations));
        } catch (e) {
          const error = LoopError.from(e, {
            code: 'BODY',
            phase: 'review',
            path,
            iteration: iterations,
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path,
            message: `onComplete threw: ${error.message}`,
            code: error.code,
          });
        }
      }
      return outcome;
    };

    // Evaluate a gate, classifying any throw with the gate's phase.
    const gate = async (
      cond: NonNullable<typeof until>,
      which: LoopPhase,
      ctx: JobContext,
      last: Outcome | undefined,
    ) => {
      try {
        return await cond(ctx, last);
      } catch (e) {
        throw LoopError.from(e, {
          code: 'VALIDATION',
          phase: which,
          path,
          iteration,
        });
      }
    };

    try {
      // 1. start gate
      if (start) {
        const r = await gate(start, 'start', ctxAt(0), undefined);
        parent.emit({
          kind: 'loop:condition',
          ts: ts(),
          path,
          which: 'start',
          result: r,
        });
        if (!r.met)
          return finish(
            { status: 'aborted', summary: `start gate not met: ${r.reason}` },
            0,
          );
      }

      let last: Outcome | undefined;
      let consecutiveErrors = 0;
      let consecutiveReviewFails = 0;

      // 2. iterate
      while (true) {
        await yieldToLoop(); // ensure an abort/SIGINT can be delivered even with a synchronous body
        if (parent.signal.aborted)
          return finish(
            { status: 'aborted', summary: 'aborted by signal' },
            iteration,
          );
        if (config.max != null && iteration >= config.max) {
          return finish(
            {
              status: 'exhausted',
              summary:
                last?.summary ?? `reached max iterations (${config.max})`,
              confidence: last?.confidence,
              data: last?.data,
            },
            iteration,
          );
        }

        iteration += 1;
        const ctx = ctxAt(iteration, last);
        parent.emit({ kind: 'loop:iteration', ts: ts(), path, iteration });

        // run the body (fresh context this turn)
        let bodyThrew = false;
        try {
          last = await config.body(ctx);
          consecutiveErrors = 0;
        } catch (e) {
          bodyThrew = true;
          const error = LoopError.from(e, {
            code: 'BODY',
            phase: 'body',
            path,
            iteration,
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path,
            message: error.message,
            code: error.code,
          });
          consecutiveErrors += 1;
          // A thrown body error is governed by the retry policy (default: continue).
          const tooMany =
            config.retry?.maxConsecutive != null &&
            consecutiveErrors >= config.retry.maxConsecutive;
          if (onError === 'fail' || tooMany)
            return finish(
              { status: 'fail', summary: error.message, error },
              iteration,
            );
          last = { status: 'fail', summary: error.message, error };
          if (config.retry?.backoffMs)
            await delay(config.retry.backoffMs, parent.signal);
        }

        // a malformed Outcome (e.g. a body that forgot `status`) is a bug — fail loudly, don't spin
        if (!last || !VALID_STATUS.has(last.status)) {
          const error = new LoopError({
            code: 'VALIDATION',
            phase: 'body',
            path,
            iteration,
            message: `body returned an Outcome with no valid "status" (got ${JSON.stringify(last?.status)})`,
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path,
            message: error.message,
            code: error.code,
          });
          return finish(
            { status: 'fail', summary: error.message, error },
            iteration,
          );
        }
        // A rate limit / quota / budget hit is governed by the `onLimit` policy
        // (default `auto`): wait out a known, bounded reset and retry the same
        // step, else checkpoint-and-pause with a resume command. `fail` opts out
        // and lets the generic fatal handling below treat it as terminal.
        if (
          last.status === 'fail' &&
          isLimitError(last.error) &&
          ctx.onLimit !== 'fail'
        ) {
          const action = decideLimit(last.error, ctx);
          if (action.kind === 'wait') {
            const now = ts();
            parent.emit({
              kind: 'limit:wait',
              ts: now,
              path,
              code: last.error.code,
              waitMs: action.waitMs,
              resumeAt: now + action.waitMs,
            });
            await delay(action.waitMs, parent.signal);
            // Don't burn an iteration on a throttled attempt: re-run this step.
            iteration -= 1;
            last = undefined;
            continue;
          }
          parent.emit({
            kind: 'limit:pause',
            ts: ts(),
            path,
            code: last.error.code,
            reason: action.reason,
            resumeCommand: ctx.resumeCommand,
          });
          return finish(
            {
              status: 'paused',
              summary: action.reason,
              error: last.error,
              data: last.data,
            },
            iteration,
          );
        }

        // A *returned* fail outcome carrying an unrecoverable error (e.g. an
        // engine auth/config failure) must not loop to `exhausted`. Thrown
        // errors are excluded — the retry policy above owns those.
        if (
          !bodyThrew &&
          last.status === 'fail' &&
          last.error &&
          !last.error.retryable
        ) {
          return finish(
            { status: 'fail', summary: last.summary, error: last.error },
            iteration,
          );
        }

        if (config.onIteration) {
          try {
            await config.onIteration(last, ctx);
          } catch (e) {
            throw LoopError.from(e, {
              code: 'VALIDATION',
              phase: 'body',
              path,
              iteration,
            });
          }
        }

        // hard early-exit
        if (stopOn) {
          const r = await gate(stopOn, 'stopOn', ctx, last);
          parent.emit({
            kind: 'loop:condition',
            ts: ts(),
            path,
            which: 'stopOn',
            result: r,
          });
          if (r.met)
            return finish(
              {
                status: 'aborted',
                summary: `stopOn met: ${r.reason}`,
                data: last.data,
              },
              iteration,
            );
        }

        // convergence check: explicit `until`, else "did the body pass?"
        const conv = until
          ? await gate(until, 'until', ctx, last)
          : {
              met: last.status === 'pass',
              confidence: last.confidence,
              reason: `body status = ${last.status}`,
            };
        if (until)
          parent.emit({
            kind: 'loop:condition',
            ts: ts(),
            path,
            which: 'until',
            result: conv,
          });

        if (conv.met) {
          if (!config.review) {
            await recordMilestone(ctxAt(iteration, last));
            return finish(
              {
                status: 'pass',
                confidence: conv.confidence ?? last.confidence,
                summary: last.summary,
                data: last.data,
              },
              iteration,
            );
          }
          let reviewOutcome: Outcome;
          try {
            reviewOutcome = await config.review(ctxAt(iteration, last));
          } catch (e) {
            throw LoopError.from(e, {
              code: 'VALIDATION',
              phase: 'review',
              path,
              iteration,
            });
          }
          parent.emit({
            kind: 'loop:review',
            ts: ts(),
            path,
            outcome: reviewOutcome,
          });
          if (reviewOutcome.status === 'pass') {
            await recordMilestone(ctxAt(iteration, last));
            return finish(
              {
                status: 'pass',
                confidence: reviewOutcome.confidence ?? conv.confidence,
                summary: reviewOutcome.summary ?? last.summary,
                data: last.data,
              },
              iteration,
            );
          }
          // review rejected — thread the verdict to the next iteration (context-scoped,
          // not run-global, so concurrent sibling loops don't cross-contaminate) and
          // bound the restart cycle.
          consecutiveReviewFails += 1;
          lastReview = reviewOutcome;
          parent.log(
            `review did not pass (${reviewOutcome.summary ?? reviewOutcome.status}); re-entering ${config.name}`,
            'warn',
          );
          if (
            config.maxReviewRestarts != null &&
            consecutiveReviewFails >= config.maxReviewRestarts
          ) {
            return finish(
              {
                status: 'exhausted',
                summary: `review rejected ${consecutiveReviewFails}× (maxReviewRestarts)`,
                data: last.data,
              },
              iteration,
            );
          }
        }

        if (config.delayMs) await delay(config.delayMs, parent.signal);
      }
    } catch (e) {
      const error = LoopError.from(e, { code: 'UNKNOWN', path, iteration });
      parent.emit({
        kind: 'error',
        ts: ts(),
        path,
        message: error.message,
        code: error.code,
      });
      return finish(
        { status: 'fail', summary: error.message, error },
        iteration,
      );
    }
  };
}

/** Sleep that resolves early (does not reject) when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
