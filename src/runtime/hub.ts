/**
 * A tiny synchronous fan-out so multiple consumers (stats, the TUI, a JSON
 * reporter) can each observe the same event stream. Not worth a dependency —
 * it is six lines and never the gnarly part.
 */

import type { LoopEvent } from '../core/types.ts';

export type Listener = (event: LoopEvent) => void;

export interface Hub {
  emit: Listener;
  subscribe(listener: Listener): () => void;
}

export function createHub(): Hub {
  const listeners = new Set<Listener>();
  return {
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
