/**
 * Live engine smoke — the one example that needs a real engine. A coding agent
 * invoked from inside a loop must resolve and feed its reply back to the gate:
 * the gate passes only when the fed-back body outcome carries the agent's
 * text, so a green exit proves the full path (dispatch → subprocess →
 * resolution → gate) end to end. Complements `loops preflight`, which proves
 * the engine lane alone, not the loop-level feedback.
 *
 *   loops run examples/engine-smoke.loop.ts --no-tui                    # codex
 *   LOOPS_SMOKE_ENGINE=claude-cli loops run examples/engine-smoke.loop.ts --no-tui
 */

import { agentJob, defineJob, loop, predicate } from '../src/api.ts';

const engine = process.env.LOOPS_SMOKE_ENGINE ?? 'codex';

export default defineJob(
  loop({
    name: `engine-smoke-${engine}`,
    max: 2,
    body: agentJob({
      label: `smoke-${engine}`,
      engine,
      prompt: 'Reply with exactly: PONG',
      timeoutMs: 180_000,
    }),
    until: predicate(
      (_ctx, last) =>
        typeof last?.data === 'string' && last.data.includes('PONG'),
      'engine reply fed back to the gate',
    ),
  }),
);
