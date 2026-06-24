import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  agentJob,
  appendDraft,
  stageAll,
  commit,
  MockEngine,
} from '../src/api.ts';
import type { RunOptions, Workspace, AgentRequest } from '../src/api.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const ws = (dir: string): Workspace => ({ dir });

/** A mock engine that records the prompt it was handed. */
function capturing(): { engine: MockEngine; last: () => string } {
  let seen = '';
  const engine = new MockEngine((req: AgentRequest) => {
    seen = req.prompt;
    return 'done';
  });
  return { engine, last: () => seen };
}

describe('grounded agentJob (read automation)', () => {
  it('prepends the committed ledger and the live draft to the prompt', async () => {
    const repo = await tmpRepo();
    // a prior milestone in the log
    write(repo, 'a.ts', 'x\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: prior milestone', body: '## Why\n\nshipped A' }, { cwd: repo });
    // and this run's accumulated why in the draft
    appendDraft(ws(repo), { heading: 'Why', body: 'mid-run: trying approach B' });

    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(
      agentJob({ label: 'work', prompt: 'CONTINUE THE TASK', ground: true }),
      opts,
    );

    const prompt = cap.last();
    expect(prompt).toContain('the ledger');
    expect(prompt).toContain('feat: prior milestone');
    expect(prompt).toContain('shipped A');
    expect(prompt).toContain('why so far');
    expect(prompt).toContain('mid-run: trying approach B');
    expect(prompt).toContain('Record your reasoning');
    // the caller's prompt is still there, last
    expect(prompt).toContain('CONTINUE THE TASK');
    expect(prompt.indexOf('the ledger')).toBeLessThan(prompt.indexOf('CONTINUE THE TASK'));
  });

  it('is just the prompt on a fresh branch with no ledger or draft', async () => {
    const repo = await tmpRepo({ initialCommit: false });
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(
      agentJob({
        label: 'work',
        prompt: 'FIRST TURN',
        ground: { recordInstruction: false },
      }),
      opts,
    );
    const prompt = cap.last();
    expect(prompt).toBe('FIRST TURN');
  });

  it('does not ground when `ground` is unset', async () => {
    const repo = await tmpRepo();
    appendDraft(ws(repo), 'some why');
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(agentJob({ label: 'work', prompt: 'PLAIN' }), opts);
    expect(cap.last()).toBe('PLAIN');
  });
});
