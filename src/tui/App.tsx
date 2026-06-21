/**
 * The Ink TUI. It subscribes to the event hub, folds events into a small view
 * model in a ref (synchronous, no per-token re-render), and repaints on a timer
 * — so a fast token stream never thrashes React. Shows the live loop/dag tree,
 * a streaming pane for the active job, and a stats footer. `q`/Esc/Ctrl-C abort.
 */

import React, { useEffect, useReducer, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

import type { Hub } from '../runtime/hub.ts';
import type { LoopEvent, Outcome } from '../core/types.ts';
import { statusColor, statusGlyph, glyph } from './theme.ts';

interface NodeView {
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

interface ViewModel {
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

function emptyVM(): ViewModel {
  return { nodes: new Map(), order: [], stream: '', tokensIn: 0, tokensOut: 0, calls: 0, errors: [], startedAt: Date.now() };
}

const STREAM_CAP = 1600;

function reduce(vm: ViewModel, e: LoopEvent): void {
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

export interface AppProps {
  hub: Hub;
  title: string;
  onAbort: () => void;
}

export function App({ hub, title, onAbort }: AppProps): React.ReactElement {
  const vm = useRef<ViewModel>(emptyVM());
  const [, repaint] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const unsubscribe = hub.subscribe((event) => reduce(vm.current, event));
    const timer = setInterval(repaint, 90);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [hub]);

  useInput((input, k) => {
    if (input === 'q' || k.escape || (k.ctrl && input === 'c')) onAbort();
  });

  const m = vm.current;
  const elapsed = ((Date.now() - m.startedAt) / 1000).toFixed(1);
  const streamLines = m.stream.split('\n').slice(-8);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{glyph.loop} {title}</Text>
        <Text color="gray">{elapsed}s · q to stop</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {m.order.length === 0 && <Text color="gray">starting…</Text>}
        {m.order.map((key) => {
          const n = m.nodes.get(key)!;
          const g = n.type === 'dag' ? glyph.dag : glyph.loop;
          const reviews = n.reviewPass + n.reviewFail;
          return (
            <Text key={key}>
              {'  '.repeat(Math.max(0, n.depth - 1))}
              <Text color={statusColor(n.status)}>{n.status ? statusGlyph(n.status) : g} </Text>
              <Text bold>{n.name}</Text>
              {n.type === 'loop' && <Text color="gray"> iter {n.iteration}{n.max ? `/${n.max}` : ''}</Text>}
              {reviews > 0 && <Text color="gray"> · review {n.reviewPass}✔/{n.reviewFail}✘</Text>}
            </Text>
          );
        })}
      </Box>

      {m.activeLabel && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="magenta">{m.activeLabel}</Text>
          {streamLines.map((l, i) => (
            <Text key={i} color="white" wrap="truncate-end">{l || ' '}</Text>
          ))}
        </Box>
      )}

      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray">{m.calls} call(s) · {m.tokensIn} in / {m.tokensOut} out tok</Text>
        {m.errors.length > 0 ? <Text color="red">{m.errors.length} error(s)</Text> : <Text color="green"> </Text>}
      </Box>
    </Box>
  );
}
