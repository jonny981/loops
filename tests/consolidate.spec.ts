import { describe, it, expect, afterAll } from 'vitest';

import { run, consolidateJob, stageAll, commit, log, MockEngine } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

describe('consolidate (the consolidated ledger, coarse memory)', () => {
  it('folds history into a consolidated ledger committed as the commit BODY', async () => {
    const repo = await tmpRepo();
    // a couple of milestones to summarise
    for (const s of ['feat: auth', 'feat: tokens']) {
      write(repo, `${s.replace(/\W+/g, '_')}.ts`, 'x\n');
      await stageAll({ cwd: repo });
      await commit({ subject: s, body: `## Why\n\n${s}` }, { cwd: repo });
    }

    const ledger = '# Ledger\n\n## Done\n- auth + tokens\n\n## Open\n- refresh';
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => new MockEngine(() => ledger) },
      cwd: repo,
    };
    const { outcome } = await run(consolidateJob(), opts);
    expect(outcome.status).toBe('pass');

    // The ledger is the commit BODY (grounded like any milestone), not a file.
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('consolidate: ledger');
    expect(top?.body).toContain('auth + tokens');
  });

  it('reads the prior ledger from the last consolidation commit, not a file', async () => {
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
            return '# Ledger v2';
          }),
      },
      cwd: repo,
    };
    // first consolidation establishes a ledger in a commit body
    await run(consolidateJob({ subject: 'consolidate: ledger' }), { ...opts, engines: { mock: () => new MockEngine(() => '# Ledger v1\n- did a') } });
    // second consolidation must see v1 as the prior (from the commit body)
    await run(consolidateJob({ subject: 'consolidate: ledger' }), opts);
    expect(seen).toContain('# Ledger v1');
    expect(seen).toContain('CURRENT LEDGER');
  });
});
