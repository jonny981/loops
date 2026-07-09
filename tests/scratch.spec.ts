import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execa } from 'execa';
import { join } from 'node:path';

import {
  run,
  commitJob,
  appendPrompt,
  readPrompt,
  resetPrompt,
  promptPath,
  appendLedger,
  readLedger,
  resetLedger,
  ledgerPath,
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

describe('prompt.md (the handoff)', () => {
  it('accumulates appends in order and is gitignored', async () => {
    const repo = await tmpRepo();
    appendPrompt(ws(repo), { heading: 'Why', body: 'the gate kept failing on auth' });
    appendPrompt(ws(repo), { heading: 'Alternatives', body: 'tried a token refresh first' });
    const handoff = readPrompt(ws(repo));
    expect(handoff.indexOf('## Why')).toBeLessThan(handoff.indexOf('## Alternatives'));
    expect(handoff).toContain('the gate kept failing on auth');
    // .loops/ is self-ignored, so neither scratch file ever enters git.
    const ignore = readFileSync(join(repo, '.loops', '.gitignore'), 'utf8');
    expect(ignore.trim()).toBe('*');
  });

  it('resets to empty', async () => {
    const repo = await tmpRepo();
    appendPrompt(ws(repo), 'a note');
    expect(readPrompt(ws(repo))).not.toBe('');
    resetPrompt(ws(repo));
    expect(readPrompt(ws(repo))).toBe('');
    expect(existsSync(promptPath(ws(repo)))).toBe(false);
  });

  it('keeps the handoff file bounded and preserves newest notes', async () => {
    const repo = await tmpRepo();
    appendPrompt(ws(repo), 'old note ' + 'x'.repeat(40_000));
    appendPrompt(ws(repo), 'new note ' + 'y'.repeat(40_000));

    const handoff = readPrompt(ws(repo));
    expect(handoff.length).toBeLessThanOrEqual(32_000);
    expect(readFileSync(promptPath(ws(repo)), 'utf8').length).toBeLessThanOrEqual(32_001);
    expect(handoff).toContain('older scratch omitted');
    expect(handoff).toContain('new note');
    expect(handoff).not.toContain('old note');
  });

  it('captures the why from multiple agents and commitJob composes from it', async () => {
    const repo = await tmpRepo();
    // Simulate a fanned-out team: two sub-agents each record their why.
    appendPrompt(ws(repo), { heading: 'Why', body: 'connector needed batching', author: 'agent-a' });
    appendPrompt(ws(repo), { heading: 'Constraints', body: 'rate limit is 5 req/s', author: 'agent-b' });
    write(repo, 'connector.ts', 'export const batch = true;\n');

    const { outcome } = await run(commitJob({ subject: 'feat: batch connector' }), {
      ...base,
      cwd: repo,
    });
    expect(outcome.status).toBe('pass');

    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('feat: batch connector');
    // The handoff is verbatim in the body (it is already curated, not re-summarised).
    expect(top?.body).toContain('connector needed batching');
    expect(top?.body).toContain('rate limit is 5 req/s');
    expect(top?.body).toContain('agent-a');

    // Crystallise then reset: the handoff is consumed by the commit.
    expect(readPrompt(ws(repo))).toBe('');
    // And it was never committed.
    const tracked = await execa('git', ['ls-files'], { cwd: repo });
    expect(tracked.stdout).not.toContain('.loops');
  });

  it('falls back to the outcome floor when no scratch files exist', async () => {
    const repo = await tmpRepo();
    write(repo, 'x.ts', 'export const x = 1;\n');
    const { outcome } = await run(
      commitJob({ subject: 'feat: x' }),
      { ...base, cwd: repo },
    );
    expect(outcome.status).toBe('pass');
    const [top] = await log({ cwd: repo, max: 1 });
    // No handoff or ledger → the floor is empty here (no last outcome at the root),
    // so the body is just the subject. The point: it committed without scratch.
    expect(top?.subject).toBe('feat: x');
  });
});

describe('ledger.md (working memory)', () => {
  it('records turns and freeform notes, then resets', async () => {
    const repo = await tmpRepo();
    appendLedger(ws(repo), { label: 'work', iteration: 1, text: 'tried A, hit a race', tools: ['Read'] });
    appendLedger(ws(repo), 'a freeform note from a peer');
    const led = readLedger(ws(repo));
    expect(led).toContain('### work  ·  iteration 1');
    expect(led).toContain('tried A, hit a race');
    expect(led).toContain('_actions: Read_');
    expect(led).toContain('a freeform note from a peer');
    resetLedger(ws(repo));
    expect(readLedger(ws(repo))).toBe('');
    expect(existsSync(ledgerPath(ws(repo)))).toBe(false);
  });

  it('keeps working memory bounded and preserves newest entries', async () => {
    const repo = await tmpRepo();
    appendLedger(ws(repo), 'old entry ' + 'x'.repeat(70_000));
    appendLedger(ws(repo), 'new entry');

    const ledger = readLedger(ws(repo));
    expect(ledger.length).toBeLessThanOrEqual(64_000);
    expect(readFileSync(ledgerPath(ws(repo)), 'utf8').length).toBeLessThanOrEqual(64_001);
    expect(ledger).toContain('entry middle omitted');
    expect(ledger).toContain('new entry');
  });
});

describe('the commit body (the handoff)', () => {
  const mockOpts = (onWorkingLog?: () => string): RunOptions => ({
    engine: 'mock',
    engines: {
      mock: () =>
        new MockEngine((req) =>
          /WORKING LOG/.test(req.prompt) ? (onWorkingLog ? onWorkingLog() : 'DISTILLED') : '',
        ),
    },
    cwd: '', // set per-test below
  });

  it('distills a structured handoff from the working log when the agent left none', async () => {
    const repo = await tmpRepo();
    // No prompt.md — the agent skipped the handoff. The working log is long enough to fold.
    const longLog = 'verbose play-by-play of what was tried. '.repeat(80); // > 2000 chars
    appendLedger(ws(repo), { label: 'work', iteration: 1, text: longLog, tools: ['Read'] });
    write(repo, 'x.ts', 'export const x = 1;\n');

    let distilled = false;
    const { outcome } = await run(commitJob({ subject: 'feat: x' }), {
      ...mockOpts(() => { distilled = true; return '## Why\nthe root cause\n## What\nthe fix'; }),
      cwd: repo,
    });
    expect(outcome.status).toBe('pass');

    const [top] = await log({ cwd: repo, max: 1 });
    expect(distilled).toBe(true); // loops guarantees a handoff by distilling the log
    expect(top?.body).toContain('## Why\nthe root cause'); // structured, not "done"
    expect(top?.body).not.toContain('verbose play-by-play'); // the raw log is folded away
    expect(readPrompt(ws(repo))).toBe(''); // both scratch files consumed at the milestone
    expect(readLedger(ws(repo))).toBe('');
  });

  it("folds a TERSE self-handoff together with the working log — it must not shadow the log", async () => {
    const repo = await tmpRepo();
    // The agent left a one-line handoff but narrated a lot of work. The body must come from
    // distilling BOTH, not from trusting the terse handoff verbatim.
    appendPrompt(ws(repo), { body: '## Why\nfixed it' });
    appendLedger(ws(repo), { label: 'work', iteration: 1, text: 'verbose reasoning. '.repeat(120), tools: ['Edit'] });
    write(repo, 'x.ts', 'export const x = 1;\n');

    let distilled = false;
    await run(commitJob({ subject: 'feat: x' }), {
      ...mockOpts(() => { distilled = true; return '## Why\nthe real root cause\n## What\nthe fix'; }),
      cwd: repo,
    });

    const [top] = await log({ cwd: repo, max: 1 });
    expect(distilled).toBe(true); // the terse handoff did not shortcut past the rich log
    expect(top?.body).toContain('the real root cause');
  });

  it('keeps short material verbatim (no model call)', async () => {
    const repo = await tmpRepo();
    appendLedger(ws(repo), { label: 'work', iteration: 1, text: 'tried A, hit a race; switched to B', tools: ['Edit×2'] });
    write(repo, 'x.ts', 'export const x = 1;\n');

    let distilled = false;
    await run(commitJob({ subject: 'feat: x' }), {
      ...mockOpts(() => { distilled = true; return 'SHOULD NOT HAPPEN'; }),
      cwd: repo,
    });

    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.body).toContain('tried A, hit a race; switched to B'); // verbatim, faithful
    expect(distilled).toBe(false); // short material → no model call
  });
});
