import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  agentJob,
  appendPrompt,
  appendLedger,
  readLedger,
  stageAll,
  commit,
  MockEngine,
} from '../src/api.ts';
import type { RunOptions, Workspace, AgentRequest, Engine } from '../src/api.ts';
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
  it('prepends the commit log, the live working memory, and the handoff', async () => {
    const repo = await tmpRepo();
    // a prior milestone in the log
    write(repo, 'a.ts', 'x\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: prior milestone', body: '## Why\n\nshipped A' }, { cwd: repo });
    // this run's working memory (fine-grained) and handoff (distilled)
    appendLedger(ws(repo), { label: 'earlier', iteration: 1, text: 'mid-run: trying approach B' });
    appendPrompt(ws(repo), { heading: 'Why', body: 'handoff: B beat A on idempotency' });

    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(
      agentJob({ label: 'work', prompt: 'CONTINUE THE TASK', ground: true }),
      opts,
    );

    const prompt = cap.last();
    // committed memory (the commit log), not called "the ledger" anymore
    expect(prompt).toContain('the commit log');
    expect(prompt).toContain('feat: prior milestone');
    expect(prompt).toContain('shipped A');
    // live working memory
    expect(prompt).toContain('Working memory');
    expect(prompt).toContain('mid-run: trying approach B');
    // live handoff
    expect(prompt).toContain('Handoff so far');
    expect(prompt).toContain('handoff: B beat A on idempotency');
    // the leave-memory instruction (lean)
    expect(prompt).toContain('Leave memory for the next agent');
    // the caller's prompt is still there, last
    expect(prompt).toContain('CONTINUE THE TASK');
    expect(prompt.indexOf('the commit log')).toBeLessThan(prompt.indexOf('CONTINUE THE TASK'));
  });

  it('auto-captures the turn into working memory after a grounded run', async () => {
    const repo = await tmpRepo({ initialCommit: false });
    // an engine that reasons and uses a couple of tools (it emits the tool events
    // agentJob counts for the auto-capture summary)
    const toolEngine: Engine = {
      name: 'mock',
      async run(req: AgentRequest, onEvent, signal) {
        onEvent({ type: 'tool', name: 'Edit', phase: 'use' });
        onEvent({ type: 'tool', name: 'Edit', phase: 'use' });
        onEvent({ type: 'tool', name: 'Bash', phase: 'use' });
        const text = 'I edited the parser and ran the tests';
        onEvent({ type: 'text', delta: text });
        onEvent({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 }, model: 'mock' });
        return { text, usage: { inputTokens: 10, outputTokens: 5 }, model: 'mock', stopReason: 'end_turn' };
      },
    };
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => toolEngine }, cwd: repo };
    await run(agentJob({ label: 'build', prompt: 'do it', ground: true }), opts);

    const led = readLedger(ws(repo));
    expect(led).toContain('### build');
    expect(led).toContain('I edited the parser and ran the tests');
    expect(led).toContain('_actions: Edit×2, Bash_');
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
    appendPrompt(ws(repo), 'some why');
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(agentJob({ label: 'work', prompt: 'PLAIN' }), opts);
    expect(cap.last()).toBe('PLAIN');
  });
});
