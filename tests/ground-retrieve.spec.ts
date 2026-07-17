import { describe, it, expect, afterAll } from 'vitest';

import { run, agentJob, stageAll, commit, MockEngine } from '../src/api.ts';
import type { RunOptions, AgentRequest } from '../src/api.ts';
import { requestEnv } from '../src/engines/engine.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

async function makeCommit(dir: string, file: string, subject: string, body: string) {
  write(dir, file, `${subject}\n`);
  await stageAll({ cwd: dir });
  await commit({ subject, body }, { cwd: dir });
}

/**
 * One mock engine plays both roles: the selection call (it returns the shas of
 * candidates whose subject says "relevant") and the work call (it records the
 * grounded prompt it was handed).
 */
function dualMock(): {
  engine: MockEngine;
  workPrompt: () => string;
  selectReq: () => AgentRequest | undefined;
} {
  let seen = '';
  let select: AgentRequest | undefined;
  const engine = new MockEngine((req: AgentRequest) => {
    if (/Return the shas relevant/i.test(req.prompt)) {
      select = req;
      const shas = [...req.prompt.matchAll(/^([0-9a-f]{7,}): (.+)$/gm)]
        .filter((m) => /relevant/i.test(m[2]!))
        .map((m) => m[1]!);
      return shas.join(', ') || 'NONE';
    }
    seen = req.prompt;
    return 'done';
  });
  return { engine, workPrompt: () => seen, selectReq: () => select };
}

describe('retrieval grounding', () => {
  it('injects only the commits a search judges relevant, not recent-N', async () => {
    const repo = await tmpRepo();
    await makeCommit(repo, 'a.ts', 'feat: relevant auth work', '## Why\n\nbuilt the auth flow');
    await makeCommit(repo, 'b.ts', 'chore: unrelated lockfile bump', '## Why\n\nbumped deps');
    await makeCommit(repo, 'c.ts', 'feat: relevant token refresh', '## Why\n\nadded token refresh');

    const m = dualMock();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => m.engine }, cwd: repo };
    const { stats } = await run(
      agentJob({
        label: 'work',
        prompt: 'Continue the auth feature.',
        ground: { retrieve: true, recordInstruction: false },
        timeoutMs: 12_345,
        timeoutGraceMs: 678,
      }),
      opts,
    );

    const prompt = m.workPrompt();
    expect(prompt).toContain('retrieved for this task');
    // the relevant commits made it in
    expect(prompt).toContain('relevant auth work');
    expect(prompt).toContain('built the auth flow');
    expect(prompt).toContain('relevant token refresh');
    // the unrelated one did NOT
    expect(prompt).not.toContain('unrelated lockfile bump');
    expect(prompt).not.toContain('bumped deps');
    // the caller's prompt is still last
    expect(prompt).toContain('Continue the auth feature.');
    expect(stats.agentCalls).toBe(2);
    expect(stats.totalInputTokens).toBe(20);
    expect(stats.totalOutputTokens).toBe(10);
    expect(m.selectReq()?.leaf).toBe(true);
    expect(m.selectReq()?.tools).toEqual([]);
    expect(m.selectReq()?.systemMode).toBe('replace');
    expect(m.selectReq()?.timeoutMs).toBe(12_345);
    expect(m.selectReq()?.timeoutGraceMs).toBe(678);
    expect(requestEnv(m.selectReq()!)).toMatchObject({
      LOOPS_LEAF: '1',
      LOOPS_LEAF_ID: 'retrieve-ledger/0',
      LOOPS_LEAF_LABEL: 'retrieve-ledger',
    });
  });

  it('falls back to nothing when the search finds no relevant commits', async () => {
    const repo = await tmpRepo();
    await makeCommit(repo, 'a.ts', 'chore: nothing matches', '## Why\n\nnoise');
    const m = dualMock(); // nothing says "relevant" → NONE
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => m.engine }, cwd: repo };
    await run(
      agentJob({
        label: 'work',
        prompt: 'A brand new task.',
        ground: { retrieve: true, recordInstruction: false },
      }),
      opts,
    );
    const prompt = m.workPrompt();
    expect(prompt).not.toContain('retrieved for this task');
    expect(prompt.trim()).toBe('A brand new task.');
  });

  it('exhausts the run budget before dispatching the worker', async () => {
    const repo = await tmpRepo();
    await makeCommit(repo, 'a.ts', 'feat: relevant auth work', '## Why\n\nbuilt auth');
    const m = dualMock();

    const { outcome, budget } = await run(
      agentJob({
        label: 'work',
        prompt: 'Continue the auth feature.',
        ground: { retrieve: true, recordInstruction: false },
      }),
      {
        engine: 'mock',
        engines: { mock: () => m.engine },
        cwd: repo,
        budget: 15,
        onLimit: 'fail',
      },
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('BUDGET');
    expect(budget?.spent).toBe(15);
    expect(m.workPrompt()).toBe('');
  });
});
