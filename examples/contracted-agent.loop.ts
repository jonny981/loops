/**
 * Offline contracted-agent example.
 *
 * It shows the intended agent contract shape through `describe --json`, then
 * exercises feedback consumption with deterministic jobs so it runs without a
 * model key.
 *
 *   loops validate examples/contracted-agent.loop.ts
 *   loops describe examples/contracted-agent.loop.ts --json
 *   loops run examples/contracted-agent.loop.ts --no-tui --supervise
 */

import {
  agentJob,
  dag,
  defineAgent,
  defineJob,
  defineSkill,
  fnJob,
  loop,
  predicate,
  reviewPanel,
} from '../src/api.ts';

const tdd = defineSkill({
  name: 'tdd',
  instructions: 'Write the failing check first, then make the smallest change that passes it.',
});

const smallDiff = defineSkill({
  name: 'small-diff',
  instructions: 'Keep the patch narrow and explain any boundary you choose not to cross.',
});

const implementationAgent = defineAgent({
  name: 'implementation',
  description: 'Builds the requested change and consumes routed review feedback.',
  system: 'You are the implementation agent. Make focused code changes and leave clear evidence.',
  tier: 'worker',
  capabilities: ['code.implementation', 'feedback.consumption'],
  skills: [tdd],
  requiresSkills: [tdd],
  usesSkills: [smallDiff],
  outputs: [
    { name: 'patch', description: 'Source changes that implement the brief.' },
    { name: 'test-report', description: 'Commands run and their outcomes.' },
  ],
  humanGates: [{ name: 'release-approval', when: 'before production deployment' }],
  failureModes: [
    {
      mode: 'missed-review-feedback',
      recovery: 'Read the feedback block first and address required findings before new work.',
      severity: 'should-fix',
    },
  ],
});

let implementationAttempts = 0;

const offlineImplementation = fnJob('offline-implementation', async (ctx) => {
  implementationAttempts += 1;
  const feedback =
    ctx.lastReview?.revision?.reason ?? ctx.lastReview?.summary ?? 'no feedback yet';
  return {
    status: 'pass',
    summary:
      implementationAttempts === 1
        ? 'drafted parser without empty-input guard'
        : `added empty-input guard after feedback: ${feedback}`,
  };
});

const strictReview = reviewPanel({
  label: 'review-panel',
  reviewers: [
    {
      name: 'correctness',
      severity: 'should-fix',
      review: async () =>
        implementationAttempts > 1
          ? {
              met: true,
              confidence: 0.95,
              reason: 'Parser rejects empty duration strings.',
            }
          : {
              met: false,
              confidence: 0.2,
              reason: 'Parser still accepts empty duration strings.',
            },
    },
    {
      name: 'simplicity',
      severity: 'nice-to-have',
      review: async () => ({
        met: false,
        confidence: 0.7,
        reason: 'The helper name could be clearer in a later cleanup.',
      }),
    },
  ],
});

const offlineFeedbackLoop = loop({
  name: 'feedback-aware-implementation',
  body: offlineImplementation,
  until: predicate(() => true, 'implementation turn completed'),
  review: strictReview,
  max: 3,
});

export default defineJob(
  dag({
    name: 'contracted-agent-example',
    nodes: {
      'implementation-contract': {
        when: predicate(() => false, 'offline example skips the live agent turn'),
        job: agentJob({
          agent: implementationAgent,
          prompt: 'Implement duration parsing from BRIEF.md.',
          consumeFeedback: true,
          graphContext: 'position',
        }),
      },
      'offline-feedback-run': {
        needs: ['implementation-contract'],
        job: offlineFeedbackLoop,
      },
    },
  }),
);
