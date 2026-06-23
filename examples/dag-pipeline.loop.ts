/**
 * Stages example: a DAG pipeline (research → implement → test → review) where
 * one node is itself a loop. Shows loops nesting inside a dag; the whole dag is
 * just another Job. Needs network. Run:  loops run examples/dag-pipeline.loop.ts
 */

import {
  defineJob,
  dag,
  loop,
  agentJob,
  agentCheck,
  commandSucceeds,
  quorum,
  gateJob,
} from '../src/api.ts';

const SMALL = 'claude-haiku-4-5-20251001';

export default defineJob(
  dag({
    name: 'ship-feature',
    nodes: {
      research: agentJob({
        label: 'research',
        prompt: 'Research the task and write findings to NOTES.md.',
      }),

      implement: {
        needs: ['research'],
        job: loop({
          name: 'implement',
          max: 10,
          body: agentJob({
            label: 'code',
            prompt: (c) => `Implement increment ${c.iteration} from NOTES.md.`,
          }),
          // Tests are the ground truth; the judge guards "complete vs compiles".
          until: [
            commandSucceeds('npm', ['test']),
            agentCheck({
              engine: 'anthropic-api',
              model: SMALL,
              question: 'Is every increment in NOTES.md implemented?',
              threshold: 0.85,
            }),
          ],
        }),
      },

      test: {
        needs: ['implement'],
        job: agentJob({
          label: 'test',
          prompt: 'Run the test suite and report results.',
        }),
      },

      // Ship is high-stakes, so don't trust one judge: require 2 of 3
      // independent verdicts to clear the bar (a quorum over the weak signal).
      review: {
        needs: ['test'],
        job: gateJob(
          'review',
          quorum(
            2,
            ...Array.from({ length: 3 }, () =>
              agentCheck({
                engine: 'anthropic-api',
                model: SMALL,
                question: 'Ready to ship with no blockers?',
                threshold: 0.9,
              }),
            ),
          ),
        ),
      },
    },
  }),
);
