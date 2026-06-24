import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  loop,
  fnJob,
  predicate,
  appendDraft,
  readDraft,
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

describe('loop commit-on-convergence (the milestone)', () => {
  it('commits ONCE at convergence, body composed from the accumulated draft', async () => {
    const repo = await tmpRepo();
    let n = 0;
    const job = loop({
      name: 'feature',
      commit: { subject: 'feat: the feature' },
      body: fnJob('work', async (ctx) => {
        n += 1;
        write(repo, `step-${n}.ts`, `step ${n}\n`);
        appendDraft(ctx.workspace, { heading: 'Why', body: `iteration ${n} did X` });
        return { status: 'fail', summary: `step ${n}` };
      }),
      until: predicate(() => n >= 3, 'n>=3'),
      max: 5,
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');

    const feature = (await log({ cwd: repo })).filter(
      (c) => c.subject === 'feat: the feature',
    );
    expect(feature.length).toBe(1); // one milestone, not three iterations
    // the body carries the why from across all the iterations
    expect(feature[0]?.body).toContain('iteration 1 did X');
    expect(feature[0]?.body).toContain('iteration 3 did X');
    expect(readDraft(ws(repo))).toBe(''); // consumed at the milestone
  });

  it('commit:true derives the subject from the converged outcome', async () => {
    const repo = await tmpRepo();
    const job = loop({
      name: 'derive',
      commit: true,
      body: fnJob('work', async () => {
        write(repo, 'x.ts', 'x\n');
        return { status: 'pass', summary: 'feat: derived subject' };
      }),
      until: predicate(() => true),
      max: 2,
    });
    await run(job, { ...base, cwd: repo });
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('feat: derived subject');
  });

  it('records the milestone only after review passes, once', async () => {
    const repo = await tmpRepo();
    let work = 0;
    let reviews = 0;
    const job = loop({
      name: 'wr',
      commit: { subject: 'feat: reviewed' },
      body: fnJob('b', async (ctx) => {
        work += 1;
        write(repo, `w${work}.ts`, `${work}\n`);
        appendDraft(ctx.workspace, `work ${work}`);
        return { status: 'pass', summary: `w${work}` };
      }),
      until: predicate(() => true),
      review: fnJob('rev', async () => {
        reviews += 1;
        return { status: reviews >= 2 ? 'pass' : 'fail' };
      }),
      max: 5,
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
    expect(reviews).toBe(2);
    const reviewed = (await log({ cwd: repo })).filter(
      (c) => c.subject === 'feat: reviewed',
    );
    expect(reviewed.length).toBe(1); // not on the review-failed convergence
  });

  it('does not commit when `commit` is unset', async () => {
    const repo = await tmpRepo();
    const before = (await log({ cwd: repo })).length;
    const job = loop({
      name: 'plain',
      body: fnJob('work', async () => {
        write(repo, 'y.ts', 'y\n');
        return { status: 'pass' };
      }),
      until: predicate(() => true),
      max: 2,
    });
    await run(job, { ...base, cwd: repo });
    expect((await log({ cwd: repo })).length).toBe(before); // no new commits
  });
});
