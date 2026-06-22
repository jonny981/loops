/**
 * The Ink TUI. It subscribes to the event hub, folds events into a small view
 * model in a ref (synchronous, no per-token re-render), and repaints on a timer
 * — so a fast token stream never thrashes React. Shows the live loop/dag tree, a
 * detail panel for the selected loop iteration, and a stats footer.
 *
 * Navigation: up/down (or k/j) move the selection across loop nodes in tree
 * order; left/right (or h/l) step through the selected loop's iterations; f or
 * space toggles follow-live (auto-track the newest loop + iteration). q/Esc/
 * Ctrl-C abort. Selection state lives in a ref so the 90ms repaint timer drives
 * rendering without a re-render per keypress.
 */

import React, { useEffect, useReducer, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

import type { Hub } from '../runtime/hub.ts';
import { statusColor, statusGlyph, glyph } from './theme.ts';
import { emptyVM, reduce, type ViewModel, type NodeView, type IterationRecord } from './model.ts';

export interface AppProps {
  hub: Hub;
  title: string;
  onAbort: () => void;
}

interface Selection {
  loopKey?: string;
  iterationIndex: number;
  followLive: boolean;
}

/** Loop nodes in tree (insertion) order — the navigable set. */
function loopKeys(m: ViewModel): string[] {
  return m.order.filter((k) => m.nodes.get(k)?.type === 'loop');
}

/** The newest loop with at least one iteration, else the newest loop. */
function newestLoopKey(m: ViewModel): string | undefined {
  const keys = loopKeys(m);
  for (let i = keys.length - 1; i >= 0; i--) {
    const n = m.nodes.get(keys[i]!)!;
    if (n.iterations.length > 0) return keys[i];
  }
  return keys[keys.length - 1];
}

/**
 * Reconcile the selection against the current model. When following live, snap
 * to the newest loop + its newest iteration. Otherwise clamp the existing
 * selection so it stays valid as iterations stream in.
 */
function resolveSelection(m: ViewModel, sel: Selection): { node?: NodeView; index: number } {
  const keys = loopKeys(m);
  let key = sel.loopKey;
  if (sel.followLive || !key || !m.nodes.has(key)) key = newestLoopKey(m);
  const node = key ? m.nodes.get(key) : undefined;
  if (!node) return { index: 0 };
  const count = node.iterations.length;
  let index = sel.followLive ? count - 1 : sel.iterationIndex;
  if (index >= count) index = count - 1;
  if (index < 0) index = 0;
  return { node, index };
}

export function App({ hub, title, onAbort }: AppProps): React.ReactElement {
  const vm = useRef<ViewModel>(emptyVM());
  const sel = useRef<Selection>({ iterationIndex: 0, followLive: true });
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
    if (input === 'q' || k.escape || (k.ctrl && input === 'c')) {
      onAbort();
      return;
    }
    const m = vm.current;
    const s = sel.current;
    const keys = loopKeys(m);

    // Toggle follow-live.
    if (input === 'f' || input === ' ') {
      s.followLive = !s.followLive;
      if (!s.followLive) {
        // Freeze on whatever is currently shown.
        const { node, index } = resolveSelection(m, s);
        s.loopKey = node?.key;
        s.iterationIndex = index;
      }
      repaint();
      return;
    }

    // Move selection across loop nodes (tree order).
    const moveLoop = (delta: number): void => {
      if (keys.length === 0) return;
      s.followLive = false;
      const { node } = resolveSelection(m, s);
      const cur = node ? keys.indexOf(node.key) : -1;
      let next = (cur < 0 ? 0 : cur) + delta;
      if (next < 0) next = 0;
      if (next >= keys.length) next = keys.length - 1;
      s.loopKey = keys[next];
      // Land on the newest iteration of the newly-selected loop.
      const n = m.nodes.get(s.loopKey!);
      s.iterationIndex = n ? Math.max(0, n.iterations.length - 1) : 0;
      repaint();
    };

    // Step through iterations of the selected loop.
    const moveIteration = (delta: number): void => {
      s.followLive = false;
      const { node, index } = resolveSelection(m, s);
      if (!node) return;
      s.loopKey = node.key;
      let next = index + delta;
      if (next < 0) next = 0;
      if (next >= node.iterations.length) next = node.iterations.length - 1;
      s.iterationIndex = next;
      repaint();
    };

    if (k.upArrow || input === 'k') moveLoop(-1);
    else if (k.downArrow || input === 'j') moveLoop(1);
    else if (k.leftArrow || input === 'h') moveIteration(-1);
    else if (k.rightArrow || input === 'l') moveIteration(1);
  });

  const m = vm.current;
  const elapsed = ((Date.now() - m.startedAt) / 1000).toFixed(1);
  const { node: selectedNode, index: selectedIndex } = resolveSelection(m, sel.current);
  const selectedRecord: IterationRecord | undefined = selectedNode?.iterations[selectedIndex];
  const following = sel.current.followLive;

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
          const isSelected = n.type === 'loop' && selectedNode?.key === key;
          return (
            <Text key={key}>
              {'  '.repeat(Math.max(0, n.depth - 1))}
              <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '▶ ' : '  '}</Text>
              <Text color={statusColor(n.status)}>{n.status ? statusGlyph(n.status) : g} </Text>
              <Text bold underline={isSelected}>{n.name}</Text>
              {n.type === 'loop' && <Text color="gray"> iter {n.iteration}{n.max ? `/${n.max}` : ''}</Text>}
              {reviews > 0 && <Text color="gray"> · review {n.reviewPass}✔/{n.reviewFail}✘</Text>}
            </Text>
          );
        })}
      </Box>

      {selectedNode && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
          <IterationDetail node={selectedNode} record={selectedRecord} index={selectedIndex} />
        </Box>
      )}

      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray">{m.calls} call(s) · {m.tokensIn} in / {m.tokensOut} out tok</Text>
        {m.errors.length > 0 ? <Text color="red">{m.errors.length} error(s)</Text> : <Text color="green"> </Text>}
      </Box>

      <Box justifyContent="space-between">
        <Text color="gray">↑↓/jk loop · ←→/hl iter · f/space follow · q stop</Text>
        <Text color={following ? 'green' : 'yellow'}>{following ? '● LIVE' : '⏸ BROWSE'}</Text>
      </Box>
    </Box>
  );
}

function IterationDetail({
  node,
  record,
  index,
}: {
  node: NodeView;
  record?: IterationRecord;
  index: number;
}): React.ReactElement {
  const total = node.iterations.length;
  if (!record) {
    return (
      <Text color="gray">loop {node.name} — no iterations yet</Text>
    );
  }
  const durMs = record.endedAt != null ? record.endedAt - record.startedAt : Date.now() - record.startedAt;
  const dur = `${(durMs / 1000).toFixed(1)}s`;
  const transcriptLines = record.transcript.split('\n').slice(-10);

  return (
    <>
      <Text>
        <Text bold>loop {node.name}</Text>
        <Text color="gray"> — iteration {index + 1}/{total} </Text>
        <Text color={statusColor(record.status === 'running' ? undefined : record.status)} bold>
          [{record.status}]
        </Text>
      </Text>

      {record.bodyStatus && (
        <Text>
          <Text color="gray">body </Text>
          <Text color={statusColor(record.bodyStatus)}>{record.bodyStatus}</Text>
          {record.bodySummary ? <Text color="gray"> — {record.bodySummary}</Text> : null}
        </Text>
      )}

      {record.until && (
        <Text>
          <Text color="magenta">until </Text>
          {record.until.met ? <Text color="green">met</Text> : <Text color="gray">not met</Text>}
          <Text color="gray"> — {record.until.reason}</Text>
          {record.until.confidence != null ? <Text color="gray"> ({record.until.confidence.toFixed(2)})</Text> : null}
        </Text>
      )}

      {record.stopOn && (
        <Text>
          <Text color="magenta">stopOn </Text>
          {record.stopOn.met ? <Text color="red">met</Text> : <Text color="gray">not met</Text>}
          <Text color="gray"> — {record.stopOn.reason}</Text>
        </Text>
      )}

      {record.review && (
        <Text>
          <Text color="blue">review </Text>
          <Text color={statusColor(record.review.status)}>{record.review.status}</Text>
          {record.review.summary ? <Text color="gray"> — {record.review.summary}</Text> : null}
        </Text>
      )}

      <Text color="gray">
        {record.tokensIn} in / {record.tokensOut} out tok · {record.calls} call(s) · {dur}
      </Text>

      {transcriptLines.length > 0 && record.transcript.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {transcriptLines.map((l, i) => (
            <Text key={i} color="white" wrap="truncate-end">{l || ' '}</Text>
          ))}
        </Box>
      )}
    </>
  );
}
