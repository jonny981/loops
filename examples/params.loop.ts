/**
 * Offline recipe-params example.
 *
 *   loops run examples/params.loop.ts --oem Sigenergy --device battery --skip go-live-chaos --no-tui
 */

import { defineJob, defineParams, fnJob, loop, predicate } from '../src/api.ts';

export const params = defineParams({
  oem: { type: 'string', required: true, help: 'OEM name' },
  device: {
    type: 'choice',
    choices: ['battery', 'inverter'],
    default: 'battery',
    help: 'Device type',
  },
  skip: { type: 'string[]', default: [], help: 'Stage to skip' },
  repoRoot: { type: 'string', defaultFrom: 'gitRoot', help: 'Repository root' },
});

let checks = 0;

export default defineJob(
  loop({
    name: 'params-demo',
    body: fnJob('check-params', async (ctx) => {
      checks += 1;
      return {
        status: checks >= 2 ? 'pass' : 'fail',
        summary: JSON.stringify(ctx.params),
      };
    }),
    until: predicate(() => checks >= 2, 'params checked twice'),
    max: 3,
  }),
);
