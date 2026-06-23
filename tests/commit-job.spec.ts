import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  loop,
  sequence,
  fnJob,
  commitJob,
  predicate,
  log,
  MockEngine,
} from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { tmpRepo, tmpBareDir, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('commitJob', () => {
  it('commits the workspace with the way welded to the diff', async () => {
    const repo = await tmpRepo();
    write(repo, 'feature.ts', 'export const x = 1;\n');
    const { outcome } = await run(
      commitJob({
        subject: 'feat: add x',
        body: '## Why\n\nbecause\n\n## Next\n\nship it',
      }),
      { ...base, cwd: repo },
    );
    expect(outcome.status).toBe('pass');
    expect((outcome.data as { sha?: string }).sha).toBeTruthy();
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('feat: add x');
    expect(top?.body).toContain('## Why');
    expect(top?.body).toContain('## Next');
  });

  it('is a no-op pass when there is nothing to commit', async () => {
    const repo = await tmpRepo();
    const { outcome } = await run(commitJob({ subject: 'feat: noop' }), {
      ...base,
      cwd: repo,
    });
    expect(outcome.status).toBe('pass');
    expect((outcome.data as { sha?: string | null }).sha).toBeNull();
    const all = await log({ cwd: repo });
    expect(all.length).toBe(1); // only the initial commit
  });

  it('fails loudly (non-retryable CONFIG) outside a git repo', async () => {
    const bare = tmpBareDir();
    const { outcome } = await run(commitJob({ subject: 'feat: x' }), {
      ...base,
      cwd: bare,
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('CONFIG');
    expect(outcome.error?.retryable).toBe(false);
  });

  it('accumulates one commit per iteration — the convergence ledger', async () => {
    const repo = await tmpRepo();
    let n = 0;
    const job = loop({
      name: 'build',
      body: sequence(
        'iter',
        fnJob('work', async () => {
          n += 1;
          write(repo, `step-${n}.txt`, `iteration ${n}\n`);
          return { status: 'pass', summary: `did step ${n}` };
        }),
        commitJob({ subject: 'feat: step' }),
      ),
      until: predicate(() => n >= 3, 'n>=3'),
      max: 5,
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
    const steps = (await log({ cwd: repo })).filter(
      (c) => c.subject === 'feat: step',
    );
    expect(steps.length).toBe(3);
  });
});
