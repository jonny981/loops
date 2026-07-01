/**
 * Offline convergence loop — proves the loop review→re-enter path and the honest
 * accepted/rejected decision in the records. Deterministic (no engine, no key).
 *
 *   loops run examples/converge-review.loop.ts --no-tui --supervise
 *   loops records <runId> --kind revision   # the re-entry is recorded as 'accepted'
 *
 * The body drafts a config; the review rejects the first draft (missing a timeout)
 * and the loop re-enters to fix it, then converges. Because the loop actually
 * re-runs to act on the feedback, the review is recorded as decision:'accepted'.
 * (A review that exhausted the loop without re-running would be 'rejected' — see
 * tests/semantic-records.spec.ts for that case.)
 */

import {
  defineJob,
  fnJob,
  loop,
  predicate,
  revisionRequest,
} from '../src/api.ts';

let attempts = 0;

export default defineJob(
  loop({
    name: 'write-config',
    max: 4,
    body: fnJob('author', async (ctx) => {
      attempts += 1;
      const fix = ctx.lastReview?.revision?.reason;
      return {
        status: 'pass',
        summary: fix ? `added a timeout after: ${fix}` : 'wrote the base config',
      };
    }),
    until: predicate(() => true, 'a draft exists'),
    review: fnJob('review', async () =>
      attempts > 1
        ? { status: 'pass', summary: 'config is complete' }
        : revisionRequest({
            reason: 'Missing a request timeout.',
            findings: [
              {
                reviewer: 'correctness',
                evidence: 'No timeout set; a hung upstream call blocks forever.',
              },
            ],
          }),
    ),
  }),
);
