import { describe, expect, it } from 'vitest';

import { agentSdkSystemPrompt } from '../src/engines/agent-sdk.ts';

describe('agentSdkSystemPrompt', () => {
  it('keeps the Claude Code preset for default and append system text', () => {
    expect(agentSdkSystemPrompt({ system: 'default rules' })).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'default rules',
    });
    expect(agentSdkSystemPrompt({ system: 'append rules', systemMode: 'append' })).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'append rules',
    });
  });

  it('uses raw replacement system text', () => {
    expect(agentSdkSystemPrompt({ system: 'selector only', systemMode: 'replace' })).toBe(
      'selector only',
    );
  });
});
