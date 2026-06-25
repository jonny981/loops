import { describe, it, expect } from 'vitest';

import { buildClaudeArgs } from '../src/engines/claude-cli.ts';

describe('buildClaudeArgs', () => {
  it('always uses headless stream-json and ends with `-- <prompt>`', () => {
    const args = buildClaudeArgs({ prompt: 'do the thing' }, {});
    expect(args.slice(0, 4)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(args.slice(-2)).toEqual(['--', 'do the thing']);
    expect(args).not.toContain('--permission-mode');
  });

  it('passes --permission-mode when set', () => {
    const args = buildClaudeArgs(
      { prompt: 'go' },
      { permissionMode: 'bypassPermissions' },
    );
    const i = args.indexOf('--permission-mode');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('bypassPermissions');
  });

  it('wires model, system prompt, and tool allowlist', () => {
    const args = buildClaudeArgs(
      {
        prompt: 'go',
        model: 'claude-haiku-4-5-20251001',
        system: 'be terse',
        allowedTools: ['Read', 'Bash'],
      },
      { defaultModel: 'ignored-when-req-has-model' },
    );
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5-20251001');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('be terse');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Bash');
  });

  it('appends caller cliArgs before the `--` prompt guard', () => {
    const args = buildClaudeArgs(
      { prompt: 'go' },
      { cliArgs: ['--add-dir', '/tmp'] },
    );
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('--'));
  });

  it('disallows the sub-agent tool for a leaf agent', () => {
    const args = buildClaudeArgs({ prompt: 'go', leaf: true }, {});
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Task');
    // a non-leaf turn never restricts spawning
    expect(buildClaudeArgs({ prompt: 'go' }, {})).not.toContain('--disallowedTools');
  });
});
