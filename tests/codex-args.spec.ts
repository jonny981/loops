import { describe, it, expect } from 'vitest';

import { buildCodexArgs } from '../src/engines/codex.ts';

describe('buildCodexArgs', () => {
  it('defaults to a read-only ephemeral exec and writes the last message', () => {
    const args = buildCodexArgs({ prompt: 'review this' }, {}, '/tmp/out.txt');
    expect(args.slice(0, 4)).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '--color']);
    expect(args).toContain('read-only');
    expect(args).toContain('-o');
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/out.txt');
    expect(args.at(-1)).toBe('review this');
  });

  it('uses write-capable unattended mode only for bypassPermissions', () => {
    const args = buildCodexArgs(
      { prompt: 'edit files', cwd: '/repo' },
      { permissionMode: 'bypassPermissions' },
      '/tmp/out.txt',
    );
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('read-only');
    expect(args[args.indexOf('-C') + 1]).toBe('/repo');
  });

  it('folds system text into the prompt and passes model plus extra args', () => {
    const args = buildCodexArgs(
      { prompt: 'go', system: 'be careful', model: 'gpt-5.1-codex' },
      { defaultModel: 'ignored', cliArgs: ['--ignore-rules'] },
      '/tmp/out.txt',
    );
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.1-codex');
    expect(args).toContain('--ignore-rules');
    expect(args.at(-1)).toBe('be careful\n\n---\n\ngo');
  });
});
