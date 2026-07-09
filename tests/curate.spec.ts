import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, agentJob, MockEngine, readSources } from '../src/api.ts';
import type { AgentRequest } from '../src/engines/engine.ts';
import type { JobContext } from '../src/core/types.ts';

let repo: string;

beforeAll(() => {
  // A real git repo with one commit: grounding reads the branch log.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'curate-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q');
  git('config', 'user.email', 'test@loops.local');
  git('config', 'user.name', 'loops test');
  writeFileSync(join(repo, 'TASK.md'), '# Task\nMake the poller resilient.\n');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'adr-1.md'), 'ADR 1: retry with backoff.\n');
  writeFileSync(join(repo, 'docs', 'adr-2.md'), 'ADR 2: no global state.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed: task and ADRs');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('readSources', () => {
  const ctx = () =>
    ({ workspace: { dir: repo } }) as Pick<JobContext, 'workspace'>;

  it('reads literal paths and expands globs, capped per source', () => {
    const sources = readSources(ctx(), ['TASK.md', 'docs/*.md']);
    expect(sources.map((s) => s.path)).toEqual([
      'TASK.md',
      'docs/adr-1.md',
      'docs/adr-2.md',
    ]);
    expect(sources[0]!.text).toContain('poller');
  });

  it('skips a missing file but rejects traversal', () => {
    expect(readSources(ctx(), ['nope.md'])).toEqual([]);
    expect(() => readSources(ctx(), ['../outside.md'])).toThrow('escapes');
    expect(() => readSources(ctx(), ['/etc/passwd'])).toThrow('relative');
  });
});

/** Run one grounded agentJob and capture what each engine was asked. */
async function groundedTurn(opts: {
  curatorReply?: string;
  ground: Record<string, unknown>;
  ladder?: Array<{ engine?: string; model?: string; hint?: string }>;
  runOverrides?: { curate?: boolean; ladder?: boolean };
}) {
  const workerRequests: AgentRequest[] = [];
  const curatorRequests: AgentRequest[] = [];
  const worker = new MockEngine((req) => {
    workerRequests.push(req);
    return 'did the work';
  });
  const strongWorker = new MockEngine((req) => {
    workerRequests.push(req);
    return 'did the work (strong lane)';
  });
  const curator = new MockEngine((req) => {
    curatorRequests.push(req);
    return opts.curatorReply ?? '{"brief":"unused"}';
  });
  const result = await run(
    agentJob({
      label: 'work',
      prompt: 'Make the poller resilient.',
      engine: 'worker',
      ladder: opts.ladder as never,
      ground: { includeScratch: false, ...opts.ground } as never,
    }),
    {
      cwd: repo,
      engine: 'worker',
      engines: { worker, strong: strongWorker, curator },
      curate: opts.runOverrides?.curate,
      ladder: opts.runOverrides?.ladder,
    },
  );
  return { result, workerRequests, curatorRequests };
}

describe('curated grounding', () => {
  it('includes every declared source when curation is off', async () => {
    const { workerRequests, curatorRequests } = await groundedTurn({
      ground: { sources: ['TASK.md', 'docs/*.md'] },
    });
    expect(curatorRequests.length).toBe(0); // inert unless configured
    const prompt = workerRequests[0]!.prompt;
    expect(prompt).toContain('Declared sources');
    expect(prompt).toContain('retry with backoff');
    expect(prompt).toContain('no global state');
  });

  it('curates: the brief leads the prompt and only kept sources remain', async () => {
    const { workerRequests, curatorRequests } = await groundedTurn({
      ground: {
        sources: ['TASK.md', 'docs/*.md'],
        curate: { engine: 'curator' },
      },
      curatorReply:
        'Here you go:\n{"brief":"Prior work decided backoff; avoid global state.","sources":["docs/adr-1.md"]}',
    });
    expect(curatorRequests.length).toBe(1);
    // The curator saw the task and the source excerpts.
    expect(curatorRequests[0]!.prompt).toContain('poller');
    expect(curatorRequests[0]!.prompt).toContain('docs/adr-2.md');
    const prompt = workerRequests[0]!.prompt;
    expect(prompt).toContain('Curated brief');
    expect(prompt).toContain('Prior work decided backoff');
    expect(prompt).toContain('adr-1');
    expect(prompt).not.toContain('no global state'); // adr-2 was dropped
  });

  it('fails closed: an unreadable verdict falls back to plain grounding', async () => {
    const { result, workerRequests } = await groundedTurn({
      ground: { sources: ['TASK.md'], curate: { engine: 'curator' } },
      curatorReply: 'I would rather chat than emit JSON.',
    });
    expect(result.outcome.status).toBe('pass'); // the run continues
    const prompt = workerRequests[0]!.prompt;
    expect(prompt).not.toContain('Curated brief');
    expect(prompt).toContain('Declared sources'); // all sources, uncurated
  });

  it('--no-curate skips the curation turn entirely', async () => {
    const { curatorRequests, workerRequests } = await groundedTurn({
      ground: { sources: ['TASK.md'], curate: { engine: 'curator' } },
      runOverrides: { curate: false },
    });
    expect(curatorRequests.length).toBe(0);
    expect(workerRequests[0]!.prompt).toContain('Declared sources');
  });
});

describe('the ladder', () => {
  const ladder = [
    { hint: 'cheap default lane' }, // rung 0: the job's own engine
    { engine: 'strong', model: 'strong-model', hint: 'hard multi-file work' },
  ];

  it('the curator picks a rung from the declared set', async () => {
    const { workerRequests, result } = await groundedTurn({
      ground: { curate: { engine: 'curator' } },
      ladder,
      curatorReply: '{"brief":"This needs the strong lane.","rung":1}',
    });
    expect(result.outcome.summary).toContain('strong lane');
    expect(workerRequests[0]!.model).toBe('strong-model');
  });

  it('an out-of-range rung falls back to rung 0, never outside the ladder', async () => {
    const { result } = await groundedTurn({
      ground: { curate: { engine: 'curator' } },
      ladder,
      curatorReply: '{"brief":"go big","rung":7}',
    });
    expect(result.outcome.summary).toBe('did the work'); // default lane
  });

  it('--no-ladder pins the job to its default lane', async () => {
    const { result, curatorRequests } = await groundedTurn({
      ground: { curate: { engine: 'curator' } },
      ladder,
      curatorReply: '{"brief":"use the strong lane","rung":1}',
      runOverrides: { ladder: false },
    });
    expect(result.outcome.summary).toBe('did the work');
    // Curation still ran (the brief is still valuable); only routing is off.
    expect(curatorRequests.length).toBe(1);
  });

  it('a ladder without curation stays on rung 0 (routing needs a verdict)', async () => {
    const { result, curatorRequests } = await groundedTurn({
      ground: {},
      ladder,
    });
    expect(curatorRequests.length).toBe(0);
    expect(result.outcome.summary).toBe('did the work');
  });
});
