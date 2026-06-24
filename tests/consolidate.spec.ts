import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { run, consolidateJob, stageAll, commit, log, MockEngine } from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

describe('consolidate (roadmap, the coarse memory)', () => {
  it('folds the ledger into a committed roadmap file', async () => {
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

    // the roadmap was written and committed
    expect(existsSync(join(repo, 'LEDGER.md'))).toBe(true);
    expect(readFileSync(join(repo, 'LEDGER.md'), 'utf8')).toContain('auth + tokens');
    const [top] = await log({ cwd: repo, max: 1 });
    expect(top?.subject).toBe('docs(ledger): roadmap');
  });
});
