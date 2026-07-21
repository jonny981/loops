/**
 * Offline example — no engine needed. A LIVE dag: the graph is a `livePlan`,
 * and the plan is steered while the dag runs (docs/momentum.md).
 *
 *   npm run example:steer
 *
 * What happens, in order:
 *   1. The dag starts with two nodes: `survey` and a deliberately slow
 *      `refactor` that would take its time.
 *   2. `survey` finishes and STEERS the plan — the discovered work arrives as
 *      two `add` edits built from the plan's registered `fix` template, one
 *      reprioritised above the other. This is the Tend move made structural:
 *      the worklist is discovered, not declared.
 *   3. Mid-flight, an "incident" lands: a steer CANCELS the running
 *      `refactor` (its per-node signal aborts it — the rest of the frontier
 *      is untouched) and adds an urgent `hotfix` node in its place.
 *   4. The dag completes when a barrier settles with no new steer: momentum
 *      ran out, and that is the only honest stop.
 *
 * Every steer lands in the event stream as a `dag:edit` — the plan's history
 * is as auditable as the work's. The same edits work from OUTSIDE the process:
 * run any live-dag recipe with `--supervise`, then
 *
 *   loops steer <runId> '[{"op":"add","name":"fix-9","template":"fix","params":{"issue":9}}]'
 *   loops control <runId> pause
 */

import { defineJob, dag, fnJob, livePlan } from '../src/api.ts';
import type { Job } from '../src/api.ts';

const log = (line: string) => console.error(line);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const work = (name: string, ms: number, detail: string): Job =>
  fnJob(name, async (ctx) => {
    log(`  ▸ ${name}: ${detail}`);
    // Honour cancellation: a steered `cancel` aborts this node's signal.
    for (let waited = 0; waited < ms; waited += 25) {
      if (ctx.signal.aborted) {
        log(`  ✂ ${name}: preempted mid-flight`);
        return { status: 'aborted' as const, summary: 'preempted' };
      }
      await sleep(25);
    }
    log(`  ✓ ${name}: crystallized`);
    return { status: 'pass' as const, summary: detail };
  });

const plan = livePlan({
  name: 'sprint',
  templates: {
    // The recipe's vocabulary of steerable work: an out-of-process `add`
    // instantiates one of these by name — JSON cannot carry a function.
    fix: (params) => {
      const issue = (params as { issue?: number } | undefined)?.issue ?? 0;
      return work(`fix-${issue}`, 150, `fixing issue #${issue}`);
    },
    hotfix: () => work('hotfix', 100, 'urgent production fix'),
  },
  nodes: {
    survey: fnJob('survey', async () => {
      log('  ▸ survey: triaging the backlog');
      await sleep(50);
      // The discovered worklist arrives as a steer: one atomic batch,
      // validated by the live toposort, versioned, recorded.
      plan.apply([
        { op: 'add', name: 'fix-1', template: 'fix', params: { issue: 1 } },
        {
          op: 'add',
          name: 'fix-2',
          template: 'fix',
          params: { issue: 2 },
          priority: 5, // jumps the queue among ready nodes
        },
      ]);
      log('  ⇄ survey: steered 2 discovered fixes into the plan');
      return { status: 'pass' as const, summary: 'backlog triaged' };
    }),
    refactor: work('refactor', 100_000, 'a long, interruptible refactor'),
  },
});

// The incident: 250ms in, an operator (here: a timer; in real use,
// `loops steer` from another terminal) cancels the running refactor and
// injects a hotfix — one atomic batch, so the graph is never half-edited.
setTimeout(() => {
  log('  ⚡ incident: cancelling the refactor, steering in a hotfix');
  plan.apply([
    { op: 'cancel', name: 'refactor' },
    { op: 'add', name: 'hotfix', template: 'hotfix' },
  ]);
}, 250).unref();

export default defineJob(dag({ name: 'steer-demo', plan, concurrency: 2 }));
