import type { AgentRequest, AgentResult } from '../engines/engine.ts';
import { scrubCapture } from './redact.ts';
import type { JobContext } from './types.ts';

function leafId(ctx: JobContext, label: string): string {
  const raw = [...ctx.path, label, String(ctx.iteration)].join('/');
  return (
    raw.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/(^-+|-+$)/g, '') ||
    'leaf'
  );
}

export function loopsRequestMeta(
  ctx: JobContext,
  label: string,
): AgentRequest['loops'] {
  return {
    leaf: true,
    runId: ctx.runId,
    leafId: leafId(ctx, label),
    path: [...ctx.path],
    label,
    iteration: ctx.iteration,
  };
}

/** Surface a completed engine turn's non-fatal backend warning through run logs. */
export function logEngineWarning(
  ctx: JobContext,
  result: Pick<AgentResult, 'warning'>,
  env?: Record<string, string>,
): void {
  if (!result.warning) return;
  ctx.log(scrubCapture(result.warning, env, 1000), 'warn');
}
