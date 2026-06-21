/**
 * Offline example — no engine needed. Polls a deterministic check on an
 * interval until it passes (or hits `max`). Run it:
 *
 *   npm run example:poll
 */

import { defineJob, loop, fnJob, predicate } from '../src/api.ts';

let ticks = 0;

export default defineJob(
  loop({
    name: 'poll',
    body: fnJob('check', async () => {
      ticks += 1;
      return { status: ticks >= 3 ? 'pass' : 'fail', summary: `tick ${ticks}/3` };
    }),
    until: predicate(() => ticks >= 3, 'three ticks observed'),
    max: 10,
    delayMs: 250,
    onComplete: (outcome) => console.error(`poll finished: ${outcome.status}`),
  }),
);
