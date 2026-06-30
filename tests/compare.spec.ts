import { describe, expect, it } from 'vitest';

import { EVIDENCE, renderComparison } from '../bench/compare.ts';

describe('benchmark comparison report', () => {
  it('renders the core comparison claims', () => {
    const out = renderComparison();
    expect(out).toContain('Loops Evidence Map');
    expect(out).toContain('OFF 0/10 versus ON 9/10');
    expect(out).toContain('raw full git-log dump');
    expect(out).toContain('Do not claim');
  });

  it('includes reproduction commands for every evidence row', () => {
    for (const row of EVIDENCE) {
      expect(row.reproduce.length).toBeGreaterThan(0);
    }
  });
});
