import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { modelFor } from '../src/engines/engine.ts';
import { buildCodexArgs, CodexEngine } from '../src/engines/codex.ts';

describe('buildCodexArgs', () => {
  it('defaults to a read-only ephemeral exec and writes the last message', () => {
    const args = buildCodexArgs({ prompt: 'review this' }, {}, '/tmp/out.txt');
    expect(args.slice(0, 4)).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '--color']);
    expect(args).toContain('read-only');
    expect(args).toContain('-o');
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/out.txt');
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('review this');
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
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('be careful\n\n---\n\ngo');
  });

  it('does not inherit another engine default model', () => {
    const leaf = buildCodexArgs(
      { prompt: 'review with codex' },
      { defaultEngine: 'agent-sdk', defaultModel: 'claude-sonnet-4-5' },
      '/tmp/out.txt',
    );
    expect(leaf).not.toContain('-m');

    const root = buildCodexArgs(
      { prompt: 'review with codex' },
      { defaultEngine: 'codex', defaultModel: 'gpt-5.4' },
      '/tmp/out.txt',
    );
    expect(root[root.indexOf('-m') + 1]).toBe('gpt-5.4');
  });

  it('shares default models across Claude engines but not into Codex', () => {
    expect(
      modelFor(
        { prompt: 'judge' },
        { defaultEngine: 'agent-sdk', defaultModel: 'claude-opus-4-5' },
        'anthropic-api',
      ),
    ).toBe('claude-opus-4-5');
    expect(
      modelFor(
        { prompt: 'judge' },
        { defaultEngine: 'agent-sdk', defaultModel: 'claude-opus-4-5' },
        'codex',
      ),
    ).toBeUndefined();
    expect(
      modelFor(
        { prompt: 'judge' },
        { defaultEngine: 'codex', defaultModel: 'gpt-5.4' },
        'anthropic-api',
      ),
    ).toBeUndefined();
  });

  it('sends the composed prompt through stdin to the codex subprocess', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loops-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    const stdinFile = join(dir, 'stdin.txt');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
writeFileSync(${JSON.stringify(stdinFile)}, readFileSync(0, 'utf8'));
writeFileSync(out, 'stub final');
`,
    );
    chmodSync(bin, 0o755);

    const engine = new CodexEngine({ cliBinary: bin });
    const result = await engine.run(
      { prompt: 'do the work', system: 'system rules' },
      () => {},
      new AbortController().signal,
    );

    expect(result.text).toBe('stub final');
    expect(readFileSync(stdinFile, 'utf8')).toBe('system rules\n\n---\n\ndo the work');
  });
});
