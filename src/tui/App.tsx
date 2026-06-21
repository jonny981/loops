/**
 * The Ink TUI. It subscribes to the event hub, folds events into a small view
 * model in a ref (synchronous, no per-token re-render), and repaints on a timer
 * — so a fast token stream never thrashes React. Shows the live loop/dag tree,
 * a streaming pane for the active job, and a stats footer. `q`/Esc/Ctrl-C abort.
 */

import React, { useEffect, useReducer, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

import type { Hub } from '../runtime/hub.ts';
import { statusColor, statusGlyph, glyph } from './theme.ts';
import { emptyVM, reduce, type ViewModel } from './model.ts';

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
