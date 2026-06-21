/** Shared colour + glyph vocabulary for the TUI. */

import type { Outcome } from '../core/types.ts';

export const glyph = {
  loop: '↻',
  dag: '▤',
  job: '•',
  pass: '✔',
  fail: '✘',
  aborted: '◼',
  exhausted: '⊘',
  running: '◐',
} as const;

export function statusColor(status: Outcome['status'] | undefined): string {
  switch (status) {
    case 'pass':
      return 'green';
    case 'fail':
      return 'red';
    case 'exhausted':
      return 'yellow';
    case 'aborted':
      return 'gray';
    default:
      return 'cyan';
  }
}

export function statusGlyph(status: Outcome['status'] | undefined): string {
  switch (status) {
    case 'pass':
      return glyph.pass;
    case 'fail':
      return glyph.fail;
    case 'exhausted':
      return glyph.exhausted;
    case 'aborted':
      return glyph.aborted;
    default:
      return glyph.running;
  }
}
