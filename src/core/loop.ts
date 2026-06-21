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
 */

import type { JobContext, LoopConfig, Outcome, Job } from './types.ts';
import { childContext } from './context.ts';
import { toCondition } from './condition.ts';
import { LoopError } from './errors.ts';

export function loop(config: LoopConfig): Job {
  const start = config.start ? toCondition(config.start) : undefined;
  const until = config.until ? toCondition(config.until) : undefined;
  const stopOn = config.stopOn ? toCondition(config.stopOn) : undefined;
  const onError = config.retry?.onError ?? 'continue';

  return async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();

    let lastReview: Outcome | undefined;
    const ctxAt = (iteration: number, lastOutcome?: Outcome): JobContext =>
      childContext(parent, { depth, path, iteration, lastOutcome, lastReview });

    parent.emit({ kind: 'loop:start', ts: ts(), path, depth, max: config.max });

    const finish = async (outcome: Outcome, iterations: number): Promise<Outcome> => {
      parent.emit({ kind: 'loop:end', ts: ts(), path, outcome, iterations });
      if (config.onComplete) await config.onComplete(outcome, ctxAt(iterations));
      return outcome;
    };

    // 1. start gate
    if (start) {
      const r = await start(ctxAt(0), undefined);
      parent.emit({ kind: 'loop:condition', ts: ts(), path, which: 'start', result: r });
      if (!r.met) return finish({ status: 'aborted', summary: `start gate not met: ${r.reason}` }, 0);
    }

    let iteration = 0;
    let last: Outcome | undefined;
    let consecutiveErrors = 0;
    let consecutiveReviewFails = 0;

    // 2. iterate
    while (true) {
      if (parent.signal.aborted) return finish({ status: 'aborted', summary: 'aborted by signal' }, iteration);
      if (config.max != null && iteration >= config.max) {
        return finish(
          { status: 'exhausted', summary: last?.summary ?? `reached max iterations (${config.max})`, confidence: last?.confidence, data: last?.data },
          iteration,
        );
      }

      iteration += 1;
      const ctx = ctxAt(iteration, last);
      parent.emit({ kind: 'loop:iteration', ts: ts(), path, iteration });

      // run the body (fresh context this turn)
      try {
        last = await config.body(ctx);
        consecutiveErrors = 0;
      } catch (e) {
        const error = LoopError.from(e, { code: 'BODY', phase: 'body', path, iteration });
        parent.emit({ kind: 'error', ts: ts(), path, message: error.message, code: error.code });
        consecutiveErrors += 1;
        const tooMany = config.retry?.maxConsecutive != null && consecutiveErrors >= config.retry.maxConsecutive;
        if (onError === 'fail' || tooMany) return finish({ status: 'fail', summary: error.message, error }, iteration);
        last = { status: 'fail', summary: error.message, error };
        if (config.retry?.backoffMs) await delay(config.retry.backoffMs, parent.signal);
      }
      if (config.onIteration) await config.onIteration(last, ctx);

      // hard early-exit
      if (stopOn) {
        const r = await stopOn(ctx, last);
        parent.emit({ kind: 'loop:condition', ts: ts(), path, which: 'stopOn', result: r });
        if (r.met) return finish({ status: 'aborted', summary: `stopOn met: ${r.reason}`, data: last?.data }, iteration);
      }

      // convergence check: explicit `until`, else "did the body pass?"
      const conv = until
        ? await until(ctx, last)
        : { met: last.status === 'pass', confidence: last.confidence, reason: `body status = ${last.status}` };
      if (until) parent.emit({ kind: 'loop:condition', ts: ts(), path, which: 'until', result: conv });

      if (conv.met) {
        if (!config.review) {
          return finish({ status: 'pass', confidence: conv.confidence ?? last.confidence, summary: last.summary, data: last.data }, iteration);
        }
        const reviewOutcome = await config.review(ctxAt(iteration, last));
        parent.emit({ kind: 'loop:review', ts: ts(), path, outcome: reviewOutcome });
        if (reviewOutcome.status === 'pass') {
          consecutiveReviewFails = 0;
          return finish(
            { status: 'pass', confidence: reviewOutcome.confidence ?? conv.confidence, summary: reviewOutcome.summary ?? last.summary, data: last.data },
            iteration,
          );
        }
        // review rejected — thread the verdict to the next iteration and bound the cycle
        consecutiveReviewFails += 1;
        lastReview = reviewOutcome;
        parent.state.lastReview = reviewOutcome;
        parent.log(`review did not pass (${reviewOutcome.summary ?? reviewOutcome.status}); re-entering ${config.name}`, 'warn');
        if (config.maxReviewRestarts != null && consecutiveReviewFails >= config.maxReviewRestarts) {
          return finish(
            { status: 'exhausted', summary: `review rejected ${consecutiveReviewFails}× (maxReviewRestarts)`, data: last.data },
            iteration,
          );
        }
      }

      if (config.delayMs) await delay(config.delayMs, parent.signal);
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
