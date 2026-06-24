import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execa } from 'execa';
import { join } from 'node:path';

import {
  run,
  commitJob,
  appendDraft,
  readDraft,
  resetDraft,
  draftPath,
  log,
  MockEngine,
} from '../src/api.ts';
import type { RunOptions, Workspace } from '../src/api.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

const ws = (dir: string): Workspace => ({ dir });

describe('draft (staged commit body)', () => {
  it('accumulates appends in order and is gitignored', async () => {
    const repo = await tmpRepo();
    appendDraft(ws(repo), { heading: 'Why', body: 'the gate kept failing on auth' });
    appendDraft(ws(repo), { heading: 'Alternatives', body: 'tried a token refresh first' });
    const draft = readDraft(ws(repo));
    expect(draft.indexOf('## Why')).toBeLessThan(draft.indexOf('## Alternatives'));
    expect(draft).toContain('the gate kept failing on auth');
    // .loops/ is self-ignored, so the draft never enters git.
    const ignore = readFileSync(join(repo, '.loops', '.gitignore'), 'utf8');
    expect(ignore.trim()).toBe('*');
  });

  it('resets to empty', async () => {
    const repo = await tmpRepo();
    appendDraft(ws(repo), 'a note');
    expect(readDraft(ws(repo))).not.toBe('');
    resetDraft(ws(repo));
    expect(readDraft(ws(repo))).toBe('');
    expect(existsSync(draftPath(ws(repo)))).toBe(false);
  });

  it('captures the why from multiple agents and commitJob composes from it', async () => {
    const repo = await tmpRepo();
    // Simulate a fanned-out team: two sub-agents each record their why.
    appendDraft(ws(repo), { heading: 'Why', body: 'connector needed batching', author: 'agent-a' });
    appendDraft(ws(repo), { heading: 'Constraints', body: 'rate limit is 5 req/s', author: 'agent-b' });
    write(repo, 'connector.ts', 'export const batch = true;\n');

    const { outcome } = await run(commitJob({ subject: 'feat: batch connector' }), {
      ...base,
      cwd: repo,
    });
    expect(outcome.status).toBe('pass');

    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('feat: batch connector');
    // The commit body is the trusted draft, not one agent's recollection.
    expect(top?.body).toContain('connector needed batching');
    expect(top?.body).toContain('rate limit is 5 req/s');
    expect(top?.body).toContain('agent-a');

    // Crystallise then reset: the draft is consumed by the commit.
    expect(readDraft(ws(repo))).toBe('');
    // And the draft was never committed.
    const tracked = await execa('git', ['ls-files'], { cwd: repo });
    expect(tracked.stdout).not.toContain('.loops');
  });

  it('falls back to the outcome floor when no draft exists', async () => {
    const repo = await tmpRepo();
    write(repo, 'x.ts', 'export const x = 1;\n');
    const { outcome } = await run(
      commitJob({ subject: 'feat: x' }),
      { ...base, cwd: repo },
    );
    expect(outcome.status).toBe('pass');
    const [top] = await log({ cwd: repo, max: 1 });
    // No draft → the floor is empty here (no last outcome at the root), so the
    // body is just the subject. The point: it committed without a draft.
    expect(top?.subject).toBe('feat: x');
  });
});
