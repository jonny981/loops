import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  push,
  pullRequestJob,
  mergeJob,
  forgeChecks,
  consolidate,
  fnJob,
  MockForge,
  MockEngine,
  buildCreateArgs,
  buildEditArgs,
  buildMergeArgs,
  buildViewArgs,
  buildChecksArgs,
} from '../src/api.ts';
import type { PrRef, RunOptions } from '../src/api.ts';
import { tmpRepo, tmpBareDir, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

/** A repo checked out on a feature branch with one milestone commit since main. */
async function repoOnBranch(branch: string): Promise<string> {
  const repo = await tmpRepo();
  await execa('git', ['checkout', '-b', branch], { cwd: repo });
  writeFileSync(join(repo, 'feature.txt'), 'work\n');
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-m', 'feat: the thing\n\nthe why'], {
    cwd: repo,
  });
  return repo;
}

const mockOpts = (forge: MockForge, cwd: string, body = 'SYNTH BODY'): RunOptions => ({
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => body) },
  forge,
  cwd,
});

describe('gh argv builders', () => {
  it('create passes base/head/title and reads the body from stdin', () => {
    expect(
      buildCreateArgs({
        title: 'feat: x',
        body: 'B',
        base: 'main',
        branch: 'feat/x',
      }),
    ).toEqual([
      'pr', 'create', '--base', 'main', '--head', 'feat/x',
      '--title', 'feat: x', '--body-file', '-',
    ]);
  });

  it('edit targets the PR number and updates the body via stdin', () => {
    const pr: PrRef = { number: 12, url: 'u' };
    expect(buildEditArgs(pr, { body: 'B' })).toEqual([
      'pr', 'edit', '12', '--body-file', '-',
    ]);
  });

  it('merge defaults to squash and threads --auto + body + delete-branch', () => {
    const pr: PrRef = { number: 7, url: 'u' };
    expect(
      buildMergeArgs(pr, {
        cwd: '.',
        auto: true,
        subject: 'feat: x',
        body: 'B',
        deleteBranch: true,
      }),
    ).toEqual([
      'pr', 'merge', '7', '--squash', '--auto',
      '--subject', 'feat: x', '--body-file', '-', '--delete-branch',
    ]);
  });

  it('view and checks target the branch / number', () => {
    expect(buildViewArgs('feat/x')).toEqual([
      'pr', 'view', 'feat/x', '--json', 'number,url,headRefName',
    ]);
    expect(buildChecksArgs({ number: 9, url: 'u' })).toEqual([
      'pr', 'checks', '9', '--required',
    ]);
  });
});

describe('push (real git, offline)', () => {
  it('sends the branch to a bare remote', async () => {
    const repo = await tmpRepo();
    const bare = tmpBareDir();
    await execa('git', ['init', '--bare', '-b', 'main'], { cwd: bare });
    await execa('git', ['remote', 'add', 'origin', bare], { cwd: repo });

    const res = await push({ cwd: repo });
    expect(res.ok).toBe(true);
    const r = await execa('git', ['log', '--oneline'], { cwd: bare });
    expect(r.stdout).toContain('init');
  });

  it('fails honestly when the remote does not exist', async () => {
    const repo = await tmpRepo();
    const res = await push({ cwd: repo, remote: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.output).toBeTruthy();
  });
});

describe('pullRequestJob', () => {
  it('opens a PR with the synthesized body when none exists', async () => {
    const repo = await repoOnBranch('feat/x');
    const forge = new MockForge();
    const { outcome } = await run(
      pullRequestJob({ base: 'main', push: false }),
      mockOpts(forge, repo, 'WHY + DECISIONS'),
    );
    expect(outcome.status).toBe('pass');
    const created = forge.calls.find((c) => c.method === 'createPr');
    expect(created).toBeTruthy();
    expect(created!.args.body).toBe('WHY + DECISIONS');
    expect(created!.args.base).toBe('main');
    expect(created!.args.branch).toBe('feat/x');
    expect(forge.calls.some((c) => c.method === 'editPr')).toBe(false);
  });

  it('updates the existing PR body (idempotent create-or-update)', async () => {
    const repo = await repoOnBranch('feat/x');
    const forge = new MockForge({
      existing: { 'feat/x': { number: 42, url: 'u', branch: 'feat/x' } },
    });
    const { outcome } = await run(
      pullRequestJob({ base: 'main', push: false }),
      mockOpts(forge, repo, 'UPDATED SYNTHESIS'),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('updated PR #42');
    const edited = forge.calls.find((c) => c.method === 'editPr');
    expect(edited).toBeTruthy();
    expect((edited!.args.patch as { body: string }).body).toBe('UPDATED SYNTHESIS');
    expect(forge.calls.some((c) => c.method === 'createPr')).toBe(false);
  });
});

describe('mergeJob', () => {
  const existing = { 'feat/x': { number: 7, url: 'u', branch: 'feat/x' } };

  it('does not merge when the gate is unmet (forgeChecks failing)', async () => {
    const repo = await repoOnBranch('feat/x');
    const forge = new MockForge({ existing, checks: false });
    const { outcome } = await run(
      mergeJob({ base: 'main', when: forgeChecks() }),
      mockOpts(forge, repo),
    );
    expect(outcome.status).toBe('fail');
    expect(forge.calls.some((c) => c.method === 'mergePr')).toBe(false);
  });

  it('squash-merges with the synthesized body once the gate passes', async () => {
    const repo = await repoOnBranch('feat/x');
    const forge = new MockForge({ existing, checks: true });
    const { outcome } = await run(
      mergeJob({ base: 'main', when: forgeChecks() }),
      mockOpts(forge, repo, 'FINAL SYNTHESIS'),
    );
    expect(outcome.status).toBe('pass');
    const merged = forge.calls.find((c) => c.method === 'mergePr');
    expect(merged).toBeTruthy();
    expect(merged!.args.body).toBe('FINAL SYNTHESIS'); // squash body = the synthesis
    expect(merged!.args.auto).toBeUndefined();
  });

  it('enqueues GitHub auto-merge with auto: true', async () => {
    const repo = await repoOnBranch('feat/x');
    const forge = new MockForge({ existing });
    const { outcome } = await run(
      mergeJob({ base: 'main', auto: true }),
      mockOpts(forge, repo),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('enqueued');
    const merged = forge.calls.find((c) => c.method === 'mergePr');
    expect(merged!.args.auto).toBe(true);
  });

  it('fails when there is no open PR for the branch', async () => {
    const repo = await repoOnBranch('feat/x');
    const forge = new MockForge(); // no existing PR
    const { outcome } = await run(mergeJob({ auto: true }), mockOpts(forge, repo));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toMatch(/no open PR/);
  });
});

describe('consolidate({ since })', () => {
  it('folds only commits after the base ref', async () => {
    const repo = await tmpRepo(); // main has "chore: init"
    await execa('git', ['checkout', '-b', 'feat/y'], { cwd: repo });
    for (const subject of ['feat: alpha', 'feat: beta']) {
      writeFileSync(join(repo, subject), 'x\n');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-m', subject], { cwd: repo });
    }
    let seenPrompt = '';
    await run(
      fnJob('c', async (ctx) => {
        await consolidate(ctx, { since: 'main' });
        return { status: 'pass' };
      }),
      {
        engine: 'mock',
        engines: {
          mock: () =>
            new MockEngine((req) => {
              seenPrompt = req.prompt;
              return 'L';
            }),
        },
        cwd: repo,
      },
    );
    expect(seenPrompt).toContain('feat: alpha');
    expect(seenPrompt).toContain('feat: beta');
    expect(seenPrompt).not.toContain('chore: init'); // base excluded by `since`
  });
});
