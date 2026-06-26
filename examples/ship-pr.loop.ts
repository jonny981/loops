/**
 * Ship via PR — keep the squash-merge body a faithful synthesis of the branch.
 *
 * The recipe (the default export) is the live shape: push the branch, open or update
 * a PR whose body is a synthesis of every commit's "way" on the branch, then squash
 * when CI is green so the one commit that lands on main carries the whole reasoning,
 * not a list of subject lines.
 *
 * The `demo()` runs the same jobs fully OFFLINE against a MockForge + MockEngine over a
 * throwaway temp repo, so you can watch open → update → squash with zero network:
 *
 *   npx tsx examples/ship-pr.loop.ts
 */

import { execa } from 'execa';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  run,
  sequence,
  pullRequestJob,
  mergeJob,
  forgeChecks,
  MockForge,
  MockEngine,
  defineJob,
  type RunOptions,
} from '../src/api.ts';

export default defineJob(
  sequence(
    'ship',
    // push + open-or-update the PR, body = consolidate(the branch's commit bodies)
    pullRequestJob({ base: 'main' }),
    // squash-merge with that synthesis as the commit body, once required checks pass
    mergeJob({ base: 'main', when: forgeChecks(), deleteBranch: true }),
  ),
);

async function demo(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'loops-ship-'));
  try {
    await execa('git', ['init', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'dev@loops.test'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'Loops'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# widget\n');
    await execa('git', ['add', '-A'], { cwd: dir });
    await execa('git', ['commit', '-m', 'chore: init'], { cwd: dir });

    // Two milestone commits on a feature branch, each with a rich body (the "way").
    await execa('git', ['checkout', '-b', 'feat/widget'], { cwd: dir });
    const milestones: [string, string][] = [
      ['feat: widget core', 'Why: the core. Chose X over Y because Y could not stream.'],
      ['feat: widget polish', 'Why: edge cases. Constraint: stays O(1) on the hot path.'],
    ];
    for (const [subject, body] of milestones) {
      writeFileSync(join(dir, subject.replace(/\W+/g, '-')), 'x\n');
      await execa('git', ['add', '-A'], { cwd: dir });
      await execa('git', ['commit', '-m', `${subject}\n\n${body}`], { cwd: dir });
    }

    const forge = new MockForge({ checks: true });
    // The mock engine stands in for the consolidation call. In a live run this is a
    // real fold of the two commit bodies above into one decision-preserving record.
    const synthesis =
      'Summary: ship the widget.\nDecisions: X over Y; stays O(1).\n(a synthesis of every commit body on the branch)';
    const opts: RunOptions = {
      engine: 'mock',
      engines: { mock: () => new MockEngine(() => synthesis) },
      forge,
      cwd: dir,
    };

    console.error('① open the PR (push skipped offline):');
    await run(pullRequestJob({ base: 'main', push: false }), opts);
    console.error('② a later milestone updates the SAME PR body:');
    await run(pullRequestJob({ base: 'main', push: false }), opts);
    console.error('③ squash-merge once required checks are green:');
    await run(
      mergeJob({ base: 'main', when: forgeChecks(), deleteBranch: true }),
      opts,
    );

    console.error('\nForge call log:');
    for (const c of forge.calls) {
      const a = c.args as Record<string, unknown>;
      const firstLine = (s: unknown) => String(s ?? '').split('\n')[0];
      const extra =
        c.method === 'createPr'
          ? ` body="${firstLine(a.body)}…"`
          : c.method === 'editPr'
            ? ` body="${firstLine((a.patch as { body?: string }).body)}…"`
            : c.method === 'mergePr'
              ? ` squash body="${firstLine(a.body)}…"`
              : '';
      console.error(`  · ${c.method}${extra}`);
    }
    console.error(
      '\nThe squash commit body = the synthesis, so main keeps the whole "way".',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await demo();
