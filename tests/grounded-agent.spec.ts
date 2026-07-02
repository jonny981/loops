import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  agentJob,
  appendPrompt,
  appendLedger,
  readLedger,
  readPrompt,
  stageAll,
  commit,
  parseHandoff,
  HANDOFF_MARK,
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
    // the handoff contract — the guiding question + the parse marker
    expect(prompt).toContain('lost all memory of it');
    expect(prompt).toContain('===HANDOFF===');
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

  it('splits the reply at the handoff marker: handoff → prompt.md, work → ledger.md', async () => {
    const repo = await tmpRepo();
    const reply =
      'I traced the bug to a missing None check and guarded it.\n\n' +
      '===HANDOFF===\n## Why\nparse_url raised on a missing scheme\n## What\nguarded the call\n## Next\nnothing left';
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => new MockEngine(() => reply) },
      cwd: repo,
    };
    await run(agentJob({ label: 'fix', prompt: 'Fix it.', ground: true }), opts);

    // The structured handoff lands in prompt.md — marker stripped, work-log excluded.
    const handoff = readPrompt(ws(repo));
    expect(handoff).toContain('## Why');
    expect(handoff).toContain('parse_url raised on a missing scheme');
    expect(handoff).not.toContain('===HANDOFF===');
    expect(handoff).not.toContain('I traced the bug');

    // The working log keeps the pre-marker reasoning, not the handoff sections.
    const led = readLedger(ws(repo));
    expect(led).toContain('I traced the bug to a missing None check');
    expect(led).not.toContain('## Why');
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

describe('parseHandoff', () => {
  it('splits work from handoff at the marker', () => {
    const { work, handoff } = parseHandoff(
      `did the thing\n${HANDOFF_MARK}\n## Why\nbecause`,
    );
    expect(work).toBe('did the thing');
    expect(handoff).toBe('## Why\nbecause');
  });

  it('matches the marker leniently (case + internal whitespace)', () => {
    const { work, handoff } = parseHandoff('log line\n=== handoff ===\nnotes');
    expect(work).toBe('log line');
    expect(handoff).toBe('notes');
  });

  it('the LAST marker wins when the reply restates it', () => {
    const { work, handoff } = parseHandoff(
      `work mentions\n${HANDOFF_MARK}\nfirst block\n${HANDOFF_MARK}\nsecond block`,
    );
    expect(work).toBe(`work mentions\n${HANDOFF_MARK}\nfirst block`);
    expect(handoff).toBe('second block');
  });

  it('no marker → the whole reply is work', () => {
    expect(parseHandoff('  just work\nno marker here\n')).toEqual({
      work: 'just work\nno marker here',
    });
  });

  it('a trailing marker with nothing after it → handoff undefined', () => {
    const { work, handoff } = parseHandoff(`all work\n${HANDOFF_MARK}\n   `);
    expect(work).toBe('all work');
    expect(handoff).toBeUndefined();
  });

  it('marker on the first line → empty work', () => {
    const { work, handoff } = parseHandoff(`${HANDOFF_MARK}\nonly handoff`);
    expect(work).toBe('');
    expect(handoff).toBe('only handoff');
  });
});

describe('outcome mapper `parts` (pre-handoff text)', () => {
  // A decision token in the work, restated inside the handoff's ## Next — the
  // false-scoring trap `parts.work` exists to avoid.
  const reply = 'DECISION: NO\n===HANDOFF===\n## Next\nDECISION: YES restated';

  const optsFor = (repo: string): RunOptions => ({
    engine: 'mock',
    engines: { mock: () => new MockEngine(() => reply) },
    cwd: repo,
  });

  it('hands the mapper the handoff-stripped work on a grounded turn', async () => {
    const repo = await tmpRepo();
    let seenText = '';
    let seenParts: { work: string; handoff?: string } | undefined;
    await run(
      agentJob({
        label: 'judge',
        prompt: 'decide',
        ground: true,
        outcome: (text, _ctx, parts) => {
          seenText = text;
          seenParts = parts;
          return { status: 'pass' };
        },
      }),
      optsFor(repo),
    );
    expect(seenParts!.work).toContain('DECISION: NO');
    expect(seenParts!.work).not.toContain('restated');
    expect(seenParts!.handoff).toContain('DECISION: YES restated');
    // text is still the raw reply, handoff block included
    expect(seenText).toContain('DECISION: NO');
    expect(seenText).toContain('DECISION: YES restated');
  });

  it('hands the mapper the same parts when ground is off', async () => {
    const repo = await tmpRepo();
    let seenText = '';
    let seenParts: { work: string; handoff?: string } | undefined;
    await run(
      agentJob({
        label: 'judge',
        prompt: 'decide',
        outcome: (text, _ctx, parts) => {
          seenText = text;
          seenParts = parts;
          return { status: 'pass' };
        },
      }),
      optsFor(repo),
    );
    expect(seenParts!.work).toContain('DECISION: NO');
    expect(seenParts!.work).not.toContain('restated');
    expect(seenText).toContain('DECISION: YES restated');
    // ungrounded: parsed for the mapper only, never captured
    expect(readLedger(ws(repo))).toBe('');
  });

  it('a two-param mapper still compiles and runs', async () => {
    const repo = await tmpRepo();
    const { outcome } = await run(
      agentJob({
        label: 'compat',
        prompt: 'go',
        outcome: (text, ctx) => ({
          status: 'pass',
          summary: `${text.length}@${ctx.iteration}`,
        }),
      }),
      optsFor(repo),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe(`${reply.length}@0`);
  });
});
