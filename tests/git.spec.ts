import { describe, it, expect, afterAll } from 'vitest';

import {
  isRepo,
  currentBranch,
  headSha,
  stageAll,
  hasStagedChanges,
  isDirty,
  commit,
  log,
} from '../src/api.ts';
import { tmpRepo, tmpBareDir, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

describe('git substrate', () => {
  it('detects a repo and reports the branch + head', async () => {
    const repo = await tmpRepo();
    expect(await isRepo({ cwd: repo })).toBe(true);
    expect(await currentBranch({ cwd: repo })).toBe('main');
    expect(await headSha({ cwd: repo })).toBeTruthy();
  });

  it('reports a non-repo directory as not a repo', async () => {
    const bare = tmpBareDir();
    expect(await isRepo({ cwd: bare })).toBe(false);
    expect(await currentBranch({ cwd: bare })).toBeUndefined();
  });

  it('stages and reports staged + dirty state', async () => {
    const repo = await tmpRepo();
    expect(await hasStagedChanges({ cwd: repo })).toBe(false);
    expect(await isDirty({ cwd: repo })).toBe(false);
    write(repo, 'a.txt', 'one\n');
    expect(await isDirty({ cwd: repo })).toBe(true);
    expect(await hasStagedChanges({ cwd: repo })).toBe(false);
    await stageAll({ cwd: repo });
    expect(await hasStagedChanges({ cwd: repo })).toBe(true);
  });

  it('commits the staged index and returns a sha', async () => {
    const repo = await tmpRepo();
    write(repo, 'a.txt', 'one\n');
    await stageAll({ cwd: repo });
    const sha = await commit({ subject: 'feat: a' }, { cwd: repo });
    expect(sha).toBeTruthy();
    expect(await hasStagedChanges({ cwd: repo })).toBe(false);
  });

  it('returns undefined when there is nothing to commit', async () => {
    const repo = await tmpRepo();
    const sha = await commit({ subject: 'feat: noop' }, { cwd: repo });
    expect(sha).toBeUndefined();
  });

  it('round-trips a multi-line body (the way) through the log', async () => {
    const repo = await tmpRepo();
    write(repo, 'a.txt', 'one\n');
    await stageAll({ cwd: repo });
    const body = '## Why\n\nbecause it converges\n\n## Next\n\nground the next turn';
    await commit({ subject: 'feat: a', body }, { cwd: repo });
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('feat: a');
    expect(top?.body).toContain('## Why');
    expect(top?.body).toContain('because it converges');
    expect(top?.body).toContain('## Next');
  });

  it('windows the log with `since` (the this-run-only ledger)', async () => {
    const repo = await tmpRepo();
    write(repo, 'a.txt', 'one\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: a' }, { cwd: repo });
    const start = await headSha({ cwd: repo });
    write(repo, 'b.txt', 'two\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: b' }, { cwd: repo });
    const since = await log({ cwd: repo, since: start });
    expect(since.map((c) => c.subject)).toEqual(['feat: b']);
  });
});
