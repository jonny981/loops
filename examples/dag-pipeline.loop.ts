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
          until: agentCheck({
            engine: 'anthropic-api',
            model: SMALL,
            question: 'Implementation complete?',
            threshold: 0.85,
          }),
        }),
      },

      test: {
        needs: ['implement'],
        job: agentJob({
          label: 'test',
          prompt: 'Run the test suite and report results.',
        }),
      },

      review: {
        needs: ['test'],
        job: gateJob(
          'review',
          agentCheck({
            engine: 'anthropic-api',
            model: SMALL,
            question: 'Ready to ship with no blockers?',
            threshold: 0.9,
          }),
        ),
      },
    },
  }),
);
