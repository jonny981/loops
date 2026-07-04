/**
 * The TUI view-model — a pure fold of events into render state. Kept free of
 * React/Ink so it is unit-testable; `App.tsx` just renders it.
 *
 * Each loop node retains a per-iteration history (`IterationRecord[]`) derived
 * entirely from the event stream, so the TUI can browse the result of every
 * iteration after the fact. Attribution is by path: an event at path P updates
 * the loop node whose key === `P.join(' / ')`, and within that loop it lands on
 * the current (latest) iteration record. Nested loops each track their own
 * iterations without colliding: a nested loop's events carry a longer path and
 * so attribute to the nested loop node, not its parent.
 */

import type { LoopEvent, Outcome } from '../core/types.ts';

export type IterationStatus =
  | 'running'
  | 'pass'
  | 'fail'
  | 'aborted'
  | 'exhausted'
  | 'paused';

export interface IterationRecord {
  iteration: number;
  status: IterationStatus;
  bodyStatus?: Outcome['status'];
  bodySummary?: string;
  until?: { met: boolean; reason: string; confidence?: number };
  stopOn?: { met: boolean; reason: string };
  review?: { status: Outcome['status']; summary?: string };
  tokensIn: number;
  tokensOut: number;
  calls: number;
  transcript: string;
  startedAt: number;
  endedAt?: number;
}

export interface NodeView {
  key: string;
  name: string;
  depth: number;
  type: 'loop' | 'dag';
  iteration: number;
  max?: number;
  status?: Outcome['status'];
  reviewPass: number;
  reviewFail: number;
  iterations: IterationRecord[];
}

export interface ViewModel {
  nodes: Map<string, NodeView>;
  order: string[];
  activeLabel?: string;
  stream: string;
  tokensIn: number;
  tokensOut: number;
  calls: number;
  errors: string[];
  /** A pause banner: the run is deliberately held (a human gate awaiting its
   *  acknowledgement, a limit pause). Without this the TUI would show a node
   *  stuck on `paused` with no reason until the exit summary. */
  notice?: string;
  startedAt: number;
}

export const STREAM_CAP = 1600;
/** Per-iteration transcript buffer cap, so history stays bounded under long runs. */
export const TRANSCRIPT_CAP = 2000;

export function emptyVM(): ViewModel {
  return {
    nodes: new Map(),
    order: [],
    stream: '',
    tokensIn: 0,
    tokensOut: 0,
    calls: 0,
    errors: [],
    startedAt: Date.now(),
  };
}

/** The latest (current) iteration record of a loop node, if any. */
function currentIteration(node: NodeView): IterationRecord | undefined {
  return node.iterations[node.iterations.length - 1];
}

/** Fold one event into the view-model in place. */
export function reduce(vm: ViewModel, e: LoopEvent): void {
  const key = e.path.join(' / ');
  const ensure = (type: 'loop' | 'dag'): NodeView => {
    let n = vm.nodes.get(key);
    if (!n) {
      n = {
        key,
        name: e.path[e.path.length - 1] ?? '(root)',
        depth: e.path.length,
        type,
        iteration: 0,
        reviewPass: 0,
        reviewFail: 0,
        iterations: [],
      };
      vm.nodes.set(key, n);
      vm.order.push(key);
    }
    return n;
  };
  /** The loop node owning this event's path, only if one already exists. */
  const loopAt = (): NodeView | undefined => {
    const n = vm.nodes.get(key);
    return n?.type === 'loop' ? n : undefined;
  };

  switch (e.kind) {
    case 'loop:start':
      ensure('loop').max = e.max;
      break;
    case 'loop:iteration': {
      const n = ensure('loop');
      n.iteration = e.iteration;
      // Boundary: finalize the previous running record, then push a new one.
      const prev = currentIteration(n);
      if (prev && prev.status === 'running') {
        prev.status = prev.bodyStatus ?? 'pass';
        prev.endedAt = e.ts;
      }
      n.iterations.push({
        iteration: e.iteration,
        status: 'running',
        tokensIn: 0,
        tokensOut: 0,
        calls: 0,
        transcript: '',
        startedAt: e.ts,
      });
      break;
    }
    case 'loop:condition': {
      const cur = loopAt() && currentIteration(loopAt()!);
      if (cur) {
        if (e.which === 'until')
          cur.until = {
            met: e.result.met,
            reason: e.result.reason,
            confidence: e.result.confidence,
          };
        else if (e.which === 'stopOn')
          cur.stopOn = { met: e.result.met, reason: e.result.reason };
      }
      break;
    }
    case 'loop:review': {
      const n = ensure('loop');
      if (e.outcome.status === 'pass') n.reviewPass += 1;
      else n.reviewFail += 1;
      const cur = currentIteration(n);
      if (cur) {
        cur.review = { status: e.outcome.status, summary: e.outcome.summary };
        // A failing review keeps the iteration "fail"-flavoured even if the body passed.
        if (e.outcome.status !== 'pass') cur.status = 'fail';
      }
      break;
    }
    case 'loop:end': {
      const n = ensure('loop');
      n.status = e.outcome.status;
      const cur = currentIteration(n);
      if (cur && cur.status === 'running') {
        cur.status = e.outcome.status;
        cur.endedAt = e.ts;
      } else if (cur && cur.endedAt == null) {
        cur.endedAt = e.ts;
      }
      break;
    }
    case 'dag:start':
      ensure('dag');
      break;
    case 'dag:end':
      ensure('dag').status = e.outcome.status;
      break;
    case 'job:start':
      vm.activeLabel = e.label;
      vm.stream = '';
      break;
    case 'job:end': {
      // The loop body runs at the loop's own path; attribute its outcome to the
      // current iteration of that loop (when one exists). Jobs at non-loop paths
      // (e.g. DAG nodes) are ignored for iteration purposes.
      const cur = loopAt() && currentIteration(loopAt()!);
      if (cur) {
        cur.bodyStatus = e.outcome.status;
        cur.bodySummary = e.outcome.summary;
      }
      break;
    }
    case 'engine:text': {
      vm.stream = (vm.stream + e.delta).slice(-STREAM_CAP);
      const cur = loopAt() && currentIteration(loopAt()!);
      if (cur)
        cur.transcript = (cur.transcript + e.delta).slice(-TRANSCRIPT_CAP);
      break;
    }
    case 'engine:usage': {
      vm.calls += 1;
      vm.tokensIn += e.usage.inputTokens;
      vm.tokensOut += e.usage.outputTokens;
      const cur = loopAt() && currentIteration(loopAt()!);
      if (cur) {
        cur.calls += 1;
        cur.tokensIn += e.usage.inputTokens;
        cur.tokensOut += e.usage.outputTokens;
      }
      break;
    }
    case 'human:gate':
      vm.notice = `⏸ human gate "${e.name}": ${e.prompt}`;
      break;
    case 'limit:pause':
      vm.notice = `⏸ paused (${e.code}): ${e.reason}`;
      break;
    case 'error':
      vm.errors.push(`[${e.code}] ${e.message}`);
      break;
  }
}
