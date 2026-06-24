import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { run, tournament, fnJob, log, MockEngine } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { tmpRepo, tmpBareDir, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('tournament (branch-and-select)', () => {
  it('runs N candidates in isolated worktrees and lands only the winner', async () => {
    const repo = await tmpRepo();
    const dirs: string[] = [];
    const job = tournament({
      name: 'approach',
      n: 3,
      candidate: (i) =>
        fnJob(`cand-${i}`, async (ctx) => {
          dirs.push(ctx.workspace.dir);
          write(ctx.workspace.dir, 'result.txt', `candidate ${i}\n`);
          return { status: 'pass', summary: `cand ${i}`, data: { score: i } };
        }),
      // candidate 2 has the highest score
      judge: (o) => (o.data as { score: number }).score,
    });

    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
    expect((outcome.data as { winner: number }).winner).toBe(2);

    // each candidate ran in its OWN worktree, none the shared repo
    expect(new Set(dirs).size).toBe(3);
    expect(dirs).not.toContain(repo);

    // only the winner's work landed on the line
    expect(readFileSync(join(repo, 'result.txt'), 'utf8')).toContain('candidate 2');
    // and the loser branches were cleaned up
    const branches = (await log({ cwd: repo })).map((c) => c.subject);
    expect(branches.some((s) => /land candidate 2/.test(s))).toBe(true);
  });

  it('fails when no candidate passes', async () => {
    const repo = await tmpRepo();
    const job = tournament({
      name: 'all-fail',
      n: 2,
      candidate: (i) => fnJob(`c${i}`, async () => ({ status: 'fail' })),
      judge: () => 1,
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('fail');
  });

  it('requires a git repo', async () => {
    const bare = tmpBareDir();
    const job = tournament({
      name: 't',
      n: 1,
      candidate: () => fnJob('c', async () => ({ status: 'pass', data: { score: 1 } })),
      judge: () => 1,
    });
    const { outcome } = await run(job, { ...base, cwd: bare });
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('CONFIG');
  });
});
