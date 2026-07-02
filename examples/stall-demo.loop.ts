/**
 * Offline example — no engine needed. A worker that makes real progress for
 * four iterations, then silently gets stuck (the classic doomed-but-busy loop).
 * Without `noProgress` it would burn all 20 iterations; with it, the loop ends
 * `exhausted` a window after the work flatlines, and the outcome carries the
 * evidence (`Outcome.stall`). Run it:
 *
 *   npm run example:stall
 *
 * The custom `signal` here stands in for any observable progress measure (a
 * passing-test count, a queue length). In a real coding loop you usually need
 * no signal at all: the workspace fingerprint (what the agent actually changed
 * in git) is read automatically, and the gate's confidence trend joins it.
 */

import { defineJob, loop, fnJob } from '../src/api.ts';

let attempt = 0;

export default defineJob(
  loop({
    name: 'stall-demo',
    body: fnJob('work', async () => {
      attempt += 1;
      const fixed = Math.min(attempt, 4); // fixes a test per turn, then stalls
      return { status: 'fail', summary: `tests fixed: ${fixed}/10` };
    }),
    max: 20,
    noProgress: {
      window: 3,
      workspace: false, // demo state lives in the signal, not the worktree
      signal: () => Math.min(attempt, 4),
    },
    onComplete: (outcome) => {
      console.error(`\nfinished: ${outcome.status} — ${outcome.summary}`);
      if (outcome.stall) {
        console.error(`evidence: ${outcome.stall.evidence.join('; ')}`);
        console.error(
          `stalled iterations: ${outcome.stall.iterations.join(', ')} (of max 20)`,
        );
      }
    },
  }),
);
