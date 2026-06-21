/**
 * The TUI view-model — a pure fold of events into render state. Kept free of
 * React/Ink so it is trivially unit-testable; `App.tsx` just renders it.
 */

import type { LoopEvent, Outcome } from '../core/types.ts';

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
  startedAt: number;
}

export const STREAM_CAP = 1600;

export function emptyVM(): ViewModel {
  return { nodes: new Map(), order: [], stream: '', tokensIn: 0, tokensOut: 0, calls: 0, errors: [], startedAt: Date.now() };
}

/** Fold one event into the view-model in place. */
export function reduce(vm: ViewModel, e: LoopEvent): void {
  const key = e.path.join(' / ');
  const ensure = (type: 'loop' | 'dag'): NodeView => {
    let n = vm.nodes.get(key);
    if (!n) {
      n = { key, name: e.path[e.path.length - 1] ?? '(root)', depth: e.path.length, type, iteration: 0, reviewPass: 0, reviewFail: 0 };
      vm.nodes.set(key, n);
      vm.order.push(key);
    }
    return n;
  };
  switch (e.kind) {
    case 'loop:start':
      ensure('loop').max = e.max;
      break;
    case 'loop:iteration':
      ensure('loop').iteration = e.iteration;
      break;
    case 'loop:review':
      if (e.outcome.status === 'pass') ensure('loop').reviewPass += 1;
      else ensure('loop').reviewFail += 1;
      break;
    case 'loop:end':
      ensure('loop').status = e.outcome.status;
      break;
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
    case 'engine:text':
      vm.stream = (vm.stream + e.delta).slice(-STREAM_CAP);
      break;
    case 'engine:usage':
      vm.calls += 1;
      vm.tokensIn += e.usage.inputTokens;
      vm.tokensOut += e.usage.outputTokens;
      break;
    case 'error':
      vm.errors.push(`[${e.code}] ${e.message}`);
      break;
  }
}
