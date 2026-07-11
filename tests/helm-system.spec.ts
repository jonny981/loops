import { describe, expect, it } from 'vitest';

import { SEMANTIC_RECORD_FILTER_KINDS } from '../src/api.ts';
import { helmSystemPrompt } from '../src/helm/system.ts';

describe('helm system prompt', () => {
  it('teaches the canonical semantic record kind vocabulary', () => {
    expect(helmSystemPrompt()).toContain(
      `kind: ${SEMANTIC_RECORD_FILTER_KINDS.join('|')}`,
    );
  });
});
