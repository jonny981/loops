/**
 * Offline example — no engine needed. Cross-stage feedback (the Tier 2 kickback):
 * a `marketing` node reviews the work and, finding the headline off-brand, sends
 * it back to `engineering`. The dag re-runs engineering (and its dependents) with
 * the objection threaded in as `ctx.lastReview`, bounded by `maxKickbacks` so the
 * feedback cycle provably terminates. The graph stays acyclic; the cycle is in the
 * re-run. Run it:
 *
 *   npx tsx src/index.ts run examples/feedback.loop.ts --no-tui
 */

import { defineJob, dag, fnJob, kickback } from '../src/api.ts';

let builds = 0;

export default defineJob(
  dag({
    name: 'ship',
    // The re-run budget — and the feedback cycle's termination bound. Without it
    // (the default 0) a kickback is ignored and the dag runs straight through.
    maxKickbacks: 2,
    nodes: {
      engineering: fnJob('engineering', async (ctx) => {
        builds += 1;
        // A kickback's reason arrives as lastReview (grounding renders it "## Next").
        const addressing = ctx.lastReview
          ? ` (addressing: ${ctx.lastReview.summary})`
          : '';
        console.error(`engineering: build attempt ${builds}${addressing}`);
        return { status: 'pass', summary: `built v${builds}` };
      }),

      marketing: {
        needs: ['engineering'],
        job: fnJob('marketing', async () => {
          // First look: the copy is off-brand, send it back. Second look: ship it.
          if (builds < 2) {
            console.error('marketing: headline is off-brand → kicking back');
            return kickback('engineering', 'headline is off-brand, rework it');
          }
          console.error('marketing: approved');
          return { status: 'pass', summary: 'approved' };
        }),
      },
    },
  }),
);
