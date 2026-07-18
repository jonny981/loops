/**
 * An engineer, end to end — the outer loop picks up the next ready GitHub
 * issue and works it the way an engineer would: research, plan, pause for
 * approval when the plan is high-complexity, build to green against an
 * adversarial review battery, update the docs, raise the PR, tell the team —
 * then pick up the next issue.
 *
 * Needs network, live engines, and the `gh` CLI authenticated for the repo.
 * Check the shape offline first:
 *
 *   loops validate examples/engineer.loop.ts
 *   loops run examples/engineer.loop.ts --supervise --checkpoint .loops/state.json
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineJob,
  loop,
  dag,
  agentJob,
  agentCheck,
  commandSucceeds,
  predicate,
  humanGate,
  reviewPanel,
  pullRequestJob,
} from '../src/api.ts';

// The pickup turn records its complexity call in ISSUE.md; the approval gate
// reads it back. A high-complexity plan waits for a person (exit 75, resume
// with --ack plan-approval); everything else flows straight through.
const highComplexity = predicate((ctx) => {
  try {
    const issue = readFileSync(join(ctx.workspace.dir, 'ISSUE.md'), 'utf8');
    return /^Complexity:\s*high/im.test(issue);
  } catch {
    return true; // no assessment on file ⇒ ask a person
  }
}, 'the issue is marked high-complexity');

// Build until lint and tests pass, then face the review battery. A rejection
// re-enters the loop with the findings in the next prompt; the adversarial
// seat runs on a different vendor's model, so the worker and its harshest
// reviewer don't share blind spots.
const build = loop({
  name: 'build',
  max: 10,
  maxReviewRestarts: 3,
  body: agentJob({
    label: 'implement',
    prompt: 'Implement the next increment from PLAN.md. Small steps, with tests.',
    ground: true,
    consumeFeedback: true,
  }),
  until: [commandSucceeds('npm', ['run', 'lint']), commandSucceeds('npm', ['test'])],
  review: reviewPanel({
    label: 'review',
    reviewers: [
      {
        name: 'adversarial',
        review: agentCheck({ question: 'Challenge the change. What breaks?', engine: 'codex' }),
      },
      {
        name: 'security',
        review: agentCheck({ question: 'Is it safe?', model: 'opus' }),
      },
      {
        name: 'completeness',
        review: agentCheck({ question: 'Is every acceptance criterion in ISSUE.md met?', model: 'sonnet' }),
      },
    ],
  }),
  commit: true, // one milestone commit per converged build
});

// One issue, worked end to end.
const issue = dag({
  name: 'issue',
  nodes: {
    pickup: agentJob({
      label: 'pickup',
      prompt:
        'Pick the oldest open issue labeled "ready" (`gh issue list`). Check ' +
        'out a branch issue/<number> from origin/main. Write ISSUE.md: the ' +
        'number, title, acceptance criteria, and a final line ' +
        '"Complexity: low" or "Complexity: high".',
    }),
    research: {
      needs: ['pickup'],
      job: agentJob({
        label: 'research',
        prompt: 'Read ISSUE.md. Explore the code it touches; record findings and constraints in NOTES.md.',
        ground: true,
      }),
    },
    plan: {
      needs: ['research'],
      job: agentJob({
        label: 'plan',
        prompt: 'Write PLAN.md from ISSUE.md and NOTES.md: increments, tests, risks.',
        ground: true,
      }),
    },
    approval: {
      needs: ['plan'],
      when: highComplexity, // unmet ⇒ the node is skipped and the chain continues
      job: humanGate({ name: 'plan-approval', prompt: 'Read PLAN.md, then approve this plan.' }),
    },
    build: { needs: ['approval'], job: build },
    docs: {
      needs: ['build'],
      job: agentJob({
        label: 'docs',
        prompt: 'Update the docs and changelog for what changed. Keep it to what a reader needs.',
        ground: true,
      }),
    },
    ship: { needs: ['docs'], job: pullRequestJob({ base: 'main' }) },
    notify: {
      needs: ['ship'],
      optional: true, // a failed notification never blocks the work
      job: agentJob({
        label: 'notify',
        prompt: 'Post a one-line summary of the open PR to the team channel, using whatever messaging tool is available.',
      }),
    },
  },
});

// Tend the backlog: work the next issue until none are left.
export default defineJob(
  loop({
    name: 'engineer',
    body: issue,
    until: predicate(() => {
      const open = execSync('gh issue list --label ready --json number --jq length', {
        encoding: 'utf8',
      });
      return open.trim() === '0';
    }, 'the ready backlog is empty'),
    max: 20,
  }),
);
