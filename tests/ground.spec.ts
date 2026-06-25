import { describe, it, expect, afterAll } from 'vitest';

import { groundingText, stageAll, commit, headSha } from '../src/api.ts';
import type { Workspace } from '../src/api.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const ws = (dir: string, branch = 'main'): Workspace => ({ dir, branch });

async function makeCommit(
  dir: string,
  file: string,
  subject: string,
  body?: string,
): Promise<void> {
  write(dir, file, `${subject}\n`);
  await stageAll({ cwd: dir });
  await commit({ subject, body }, { cwd: dir });
}

describe('grounding (the read side)', () => {
  it('renders the branch-local ledger, newest first, with bodies', async () => {
    const repo = await tmpRepo();
    await makeCommit(repo, 'a.ts', 'feat: a', '## Why\n\ntried approach A');
    await makeCommit(repo, 'b.ts', 'feat: b', '## Why\n\nA failed, switched to B');

    const text = await groundingText(ws(repo));
    expect(text).toContain('the commit log');
    expect(text).toContain('`main`');
    // newest first: feat: b appears before feat: a
    expect(text.indexOf('feat: b')).toBeLessThan(text.indexOf('feat: a'));
    expect(text).toContain('A failed, switched to B');
    expect(text).toContain('tried approach A');
  });

  it('scopes to this run with `since` (the run window)', async () => {
    const repo = await tmpRepo();
    await makeCommit(repo, 'a.ts', 'feat: a');
    const start = await headSha({ cwd: repo });
    await makeCommit(repo, 'b.ts', 'feat: b');
    await makeCommit(repo, 'c.ts', 'feat: c');

    const text = await groundingText(ws(repo), { since: start });
    expect(text).toContain('feat: b');
    expect(text).toContain('feat: c');
    expect(text).not.toContain('feat: a');
  });

  it('returns empty on a fresh branch with nothing to ground on', async () => {
    const repo = await tmpRepo({ initialCommit: false });
    const text = await groundingText(ws(repo));
    expect(text).toBe('');
  });

  it('bounds the body so the commit log does not re-rot the context', async () => {
    const repo = await tmpRepo();
    const big = 'x'.repeat(5000);
    await makeCommit(repo, 'a.ts', 'feat: big', big);
    const text = await groundingText(ws(repo), { bodyChars: 200 });
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(2000);
  });

  it('caps the number of commits with `max`', async () => {
    const repo = await tmpRepo();
    for (let i = 0; i < 5; i += 1) {
      await makeCommit(repo, `f${i}.ts`, `feat: step ${i}`);
    }
    const text = await groundingText(ws(repo), { max: 2 });
    expect(text).toContain('feat: step 4');
    expect(text).toContain('feat: step 3');
    expect(text).not.toContain('feat: step 2');
  });
});
