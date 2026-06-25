import { describe, it, expect, afterAll } from 'vitest';

import { run, consolidateJob, stageAll, commit, log, MockEngine } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

describe('consolidate (roadmap, the coarse memory)', () => {
  it('folds the ledger into a roadmap committed as the commit BODY', async () => {
    const repo = await tmpRepo();
    // a couple of milestones to summarise
    for (const s of ['feat: auth', 'feat: tokens']) {
      write(repo, `${s.replace(/\W+/g, '_')}.ts`, 'x\n');
      await stageAll({ cwd: repo });
      await commit({ subject: s, body: `## Why\n\n${s}` }, { cwd: repo });
    }

    const roadmap = '# Roadmap\n\n## Done\n- auth + tokens\n\n## Open\n- refresh';
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => new MockEngine(() => roadmap) },
      cwd: repo,
    };
    const { outcome } = await run(consolidateJob(), opts);
    expect(outcome.status).toBe('pass');

    // The roadmap is the commit BODY (grounded like any milestone), not a file.
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('consolidate: roadmap');
    expect(top?.body).toContain('auth + tokens');
  });

  it('reads the prior roadmap from the last consolidation commit, not a file', async () => {
    const repo = await tmpRepo();
    write(repo, 'a.ts', 'x\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'feat: a', body: '## Why\n\nshipped a' }, { cwd: repo });

    // a capturing mock that records the prompt it was handed
    let seen = '';
    const opts: RunOptions = {
      engine: 'mock',
      engines: {
        mock: () =>
          new MockEngine((req) => {
            seen = req.prompt;
            return '# Roadmap v2';
          }),
      },
      cwd: repo,
    };
    // first consolidation establishes a roadmap in a commit body
    await run(consolidateJob({ subject: 'consolidate: roadmap' }), { ...opts, engines: { mock: () => new MockEngine(() => '# Roadmap v1\n- did a') } });
    // second consolidation must see v1 as the prior (from the commit body)
    await run(consolidateJob({ subject: 'consolidate: roadmap' }), opts);
    expect(seen).toContain('# Roadmap v1');
    expect(seen).toContain('CURRENT ROADMAP');
  });
});
