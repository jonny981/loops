/**
 * The headline example: the exact "loops within loops" scenario.
 *
 *   - a worker job runs each iteration with a fresh context (agent-sdk);
 *   - `until` gates on BOTH a deterministic signal (the test suite actually
 *     passes) AND a small-model judge — never the judge's word alone, because
 *     self-reported confidence is a weak signal. An array `until` is `all`, so
 *     both must hold;
 *   - when it does, a REVIEW runs: here, two reviewers in PARALLEL (a dag);
 *   - if any reviewer fails, the main loop runs again.
 *
 * Needs network (agent-sdk for the worker, anthropic-api for the small checks).
 * Run it:  npm run example:gate
 */

import {
  defineJob,
  loop,
  agentJob,
  agentCheck,
  commandSucceeds,
  gateJob,
  parallel,
} from '../src/api.ts';

const SMALL = 'claude-haiku-4-5-20251001';

export default defineJob(
  loop({
    name: 'build-feature',
    max: 20,

    body: agentJob({
      label: 'worker',
      engine: 'agent-sdk',
      prompt: (ctx) =>
        `Iteration ${ctx.iteration}. Continue implementing the feature described in TASK.md. ` +
        `Make concrete, committed progress this turn and report exactly what changed.`,
    }),

    // Stop only when the tests ACTUALLY pass AND a small model agrees the work
    // matches TASK.md. The deterministic gate is the ground truth; the judge
    // guards intent. Gating on the judge alone would trust an uncalibrated
    // self-report; gating on tests alone would miss "passes but wrong".
    until: [
      commandSucceeds('npm', ['test']),
      agentCheck({
        engine: 'anthropic-api',
        model: SMALL,
        question:
          'Does the implementation fully satisfy what TASK.md asked for (not just compile)?',
        threshold: 0.85,
      }),
    ],

    // Review = two reviewers in parallel; both must pass or the loop restarts.
    review: parallel('reviewers', {
      security: gateJob(
        'security',
        agentCheck({
          engine: 'anthropic-api',
          model: SMALL,
          question:
            'Is the implementation free of security issues (authz, injection, secrets)?',
          threshold: 0.9,
        }),
      ),
      quality: gateJob(
        'quality',
        agentCheck({
          engine: 'anthropic-api',
          model: SMALL,
          question:
            'Does the code meet a strict senior-engineer quality bar with no blockers?',
          threshold: 0.85,
        }),
      ),
    }),
  }),
);
