import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  run,
  fnJob,
  mergeSynthesis,
  stageAll,
  commit,
  log,
  MockEngine,
} from '../src/api.ts';
import type { RunOptions, AgentRequest, MergeSynthesisResult } from '../src/api.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const synthMock = () =>
  new MockEngine((req: AgentRequest) => {
    if (/Resolve this git merge conflict/i.test(req.prompt))
      return 'RESOLVED MERGED CONTENT\n';
    if (/MERGE SYNTHESIS/i.test(req.prompt))
      return 'Reconciled the cand and main approaches into one coherent path.';
    return '';
  });

/** Run mergeSynthesis inside a job so it gets a real JobContext + engine. */
async function landSynthesis(repo: string, branch: string) {
  let result: MergeSynthesisResult | undefined;
  const opts: RunOptions = {
    engine: 'mock',
    engines: { mock: () => synthMock() },
    cwd: repo,
  };
  await run(
    fnJob('land', async (ctx) => {
      result = await mergeSynthesis(ctx, { branch });
      return { status: 'pass' };
    }),
    opts,
  );
  return result!;
}

describe('mergeSynthesis', () => {
  it('resolves a real conflict and writes a synthesised body', async () => {
    const repo = await tmpRepo();
    write(repo, 'shared.ts', 'base\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'chore: base' }, { cwd: repo });

    await execa('git', ['checkout', '-b', 'cand'], { cwd: repo });
    write(repo, 'shared.ts', 'CAND VERSION\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: cand change', body: '## Why\n\ncand approach' }, { cwd: repo });

    await execa('git', ['checkout', 'main'], { cwd: repo });
    write(repo, 'shared.ts', 'MAIN VERSION\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: main change', body: '## Why\n\nmain approach' }, { cwd: repo });

    const result = await landSynthesis(repo, 'cand');
    expect(result.ok).toBe(true);
    expect(result.conflict).toBe(true);

    // the conflict was resolved (no markers), with the agent's content
    const content = readFileSync(join(repo, 'shared.ts'), 'utf8');
    expect(content).toContain('RESOLVED MERGED CONTENT');
    expect(content).not.toContain('<<<<<<<');

    // the merge commit carries the synthesised body, not "merge branch X"
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toContain('synthesis');
    expect(top?.body).toContain('Reconciled the cand and main approaches');
  });

  it('handles a clean (non-conflicting) merge with a synthesised body too', async () => {
    const repo = await tmpRepo();
    await execa('git', ['checkout', '-b', 'feature'], { cwd: repo });
    write(repo, 'new.ts', 'x\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: new file', body: '## Why\n\nadded a file' }, { cwd: repo });
    await execa('git', ['checkout', 'main'], { cwd: repo });

    const result = await landSynthesis(repo, 'feature');
    expect(result.ok).toBe(true);
    expect(result.conflict).toBe(false);
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.body).toContain('Reconciled');
  });
});
