/**
 * Offline pipeline DAG — proves the refactored feedback + records model end to
 * end with deterministic jobs (no engine, no API key). Run it, then read the
 * decisions back:
 *
 *   loops validate examples/feedback-pipeline.loop.ts
 *   loops run examples/feedback-pipeline.loop.ts --no-tui --supervise
 *   loops records <runId>                              # the semantic decision stream
 *   loops records <runId> --kind completion            # one clean completion per node
 *   loops records <runId> --kind revision              # the routed feedback
 *
 * What it demonstrates:
 *   - a BARE async-function node gets a clean dag-node completion (it emits no
 *     job:start/job:end of its own, so before the fix it had a dispatch and no
 *     completion — it looked hung).
 *   - a node SKIPPED by `when` is visible in the records (a completion marked
 *     "skipped"), not silently absent.
 *   - reviewPanel: every reviewer is a gate; `pass: 2` clears with one failing
 *     reviewer, whose concern is still surfaced as a finding.
 *   - a downstream kickback re-runs the upstream subgraph; the re-run's records
 *     carry attempt 2, so a re-run is distinguishable from the first pass.
 *   - one revision channel: the kicked-back node reads `ctx.lastReview.revision`.
 */

import { dag, defineJob, fnJob, kickback, reviewPanel } from '../src/api.ts';

let publishAttempts = 0;

export default defineJob(
  dag({
    name: 'ship-post',
    maxKickbacks: 1,
    nodes: {
      // A bare async function as a node. It reacts to a kickback via ctx.lastReview.
      draft: async (ctx) => {
        const redo = ctx.lastReview?.revision?.reason;
        return {
          status: 'pass',
          summary: redo ? `redrafted (${redo})` : 'drafted the post',
        };
      },

      // Skipped by an unmet `when` — still shows up in the records.
      translate: {
        when: async () => ({ met: false, reason: 'i18n disabled for this run' }),
        job: fnJob('translate', async () => ({
          status: 'pass',
          summary: 'translated',
        })),
      },

      // Every reviewer gates. `pass: 2` clears when 2 of the 3 pass, so the failing
      // 'tone' reviewer does not block — but its concern is still a surfaced finding.
      review: {
        needs: ['draft'],
        job: reviewPanel({
          label: 'editorial',
          pass: 2,
          reviewers: [
            {
              name: 'grammar',
              review: async () => ({ met: true, confidence: 0.95, reason: 'Reads clean.' }),
            },
            {
              name: 'facts',
              review: async () => ({ met: true, confidence: 0.9, reason: 'Claims check out.' }),
            },
            {
              name: 'tone',
              review: async () => ({
                met: false,
                confidence: 0.6,
                reason: 'Slightly formal for the blog voice.',
              }),
            },
          ],
        }),
      },

      // Publish kicks the draft back once (a targeted revision on the single
      // `revision` channel), then passes. The kickback re-runs draft → review →
      // publish, so each carries attempt 2.
      publish: {
        needs: ['review'],
        job: fnJob('publish', async () => {
          publishAttempts += 1;
          return publishAttempts === 1
            ? kickback('draft', 'tighten the headline to under 60 chars')
            : { status: 'pass', summary: 'published' };
        }),
      },
    },
  }),
);
