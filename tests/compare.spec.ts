import { describe, expect, it } from 'vitest';

import { EVIDENCE, renderComparison } from '../bench/compare.ts';

describe('benchmark comparison report', () => {
  it('renders the core comparison claims', () => {
    const out = renderComparison();
    expect(out).toContain('Loops: The First-Sight Proof');
    expect(out).toContain('snapshots must start');
    expect(out).toContain('thread back through');
    expect(out).toContain('not just `git log`');
    expect(out).toContain('gated milestone commits');
    expect(out).toContain('how and why the');
    expect(out).toContain('OFF 0/10 versus ON 9/10');
    expect(out).toContain('full-log dump is not a serious operating mode');
    expect(out).toContain('Do not claim');
  });

  it('includes reproduction commands for every evidence row', () => {
    for (const row of EVIDENCE) {
      expect(row.reproduce.length).toBeGreaterThan(0);
    }
  });
});
