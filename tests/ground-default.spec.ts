import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  agentJob,
  readLedger,
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
    return 'captured turn';
  });
  return { engine, last: () => seen };
}

describe('run-level ground default (RunOptions.ground)', () => {
  it('grounds an agentJob that sets no ground of its own', async () => {
    const repo = await tmpRepo();
    const cap = capturing();
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => cap.engine },
      cwd: repo,
      ground: true,
    };
    await run(agentJob({ label: 'work', prompt: 'DO THE TASK' }), opts);

    // The grounding preamble ran: the handoff contract is the stable marker.
    const prompt = cap.last();
    expect(prompt).toContain('===HANDOFF===');
    expect(prompt).toContain('DO THE TASK');
    // And the reply was auto-captured into working memory.
    expect(readLedger(ws(repo))).toContain('captured turn');
  });

  it('an explicit per-job ground: false opts out of the run default', async () => {
    const repo = await tmpRepo();
    const cap = capturing();
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => cap.engine },
      cwd: repo,
      ground: true,
    };
    await run(
      agentJob({ label: 'work', prompt: 'PLAIN TURN', ground: false }),
      opts,
    );
    // No grounding sections, and nothing captured.
    expect(cap.last()).toBe('PLAIN TURN');
    expect(readLedger(ws(repo))).toBe('');
  });

  it('a per-job object config wins over a run-level true', async () => {
    const repo = await tmpRepo();
    // a committed milestone so grounding has a commit log to show
    write(repo, 'a.ts', 'x\n');
    await stageAll({ cwd: repo });
    await commit(
      { subject: 'feat: milestone', body: 'shipped it' },
      { cwd: repo },
    );

    const cap = capturing();
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => cap.engine },
      cwd: repo,
      ground: true,
    };
    await run(
      agentJob({
        label: 'work',
        prompt: 'GO',
        ground: { recordInstruction: false },
      }),
      opts,
    );
    const prompt = cap.last();
    // Grounded with the JOB's tuning: commit log present, handoff contract off —
    // a run-level `true` would have included it.
    expect(prompt).toContain('feat: milestone');
    expect(prompt).not.toContain('===HANDOFF===');
  });

  it('no run default and no per-job ground → ungrounded, unchanged', async () => {
    const repo = await tmpRepo();
    const cap = capturing();
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => cap.engine },
      cwd: repo,
    };
    await run(agentJob({ label: 'work', prompt: 'BARE' }), opts);
    expect(cap.last()).toBe('BARE');
    expect(readLedger(ws(repo))).toBe('');
  });
});
