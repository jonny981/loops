import type { AgentRequest } from '../engines/engine.ts';
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
