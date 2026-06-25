/**
 * Noise for the noisy-log test: bury the foundation commit under N unrelated
 * "decision" commits, so the load-bearing why falls out of recent-N's window and
 * only retrieval (or an expensive full-log dump) can find it.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

const NOISE_DECISIONS: { subject: string; body: string }[] = [
  { subject: 'chore(ci): pin Node to 20.x', body: '## Why\nReproducible CI; 22.x had a flaky timer test.' },
  { subject: 'docs(readme): document install steps', body: '## Why\nNew contributors kept missing the setup.' },
  { subject: 'refactor(logging): structured JSON logs', body: '## Why\nGrep-friendly logs for the new dashboard.' },
  { subject: 'style: adopt 2-space indentation', body: '## Why\nMatch the rest of the org style guide.' },
  { subject: 'chore(deps): drop unused lodash', body: '## Why\nWe only used one helper; inlined it.' },
  { subject: 'feat(config): support a .storerc file', body: '## Why\nOps wanted env-specific config without code changes.' },
  { subject: 'test: smoke test for empty input', body: '## Why\nA prod incident came from an empty payload.' },
  { subject: 'perf: cache the last lookup', body: '## Why\nHot path repeated the same get() in a tight loop.' },
  { subject: 'fix(typo): correct a comment', body: '## Why\nThe comment said the opposite of the code.' },
  { subject: 'build: add an npm pack script', body: '## Why\nRelease step was manual and error-prone.' },
  { subject: 'chore(license): add MIT license', body: '## Why\nLegal sign-off for open sourcing.' },
  { subject: 'docs(api): clarify get() returns undefined', body: '## Why\nCallers assumed it threw on a missing id.' },
  { subject: 'refactor: extract a validation helper', body: '## Why\nThree call sites duplicated the same checks.' },
  { subject: 'chore(editorconfig): add .editorconfig', body: '## Why\nEditors disagreed on whitespace.' },
  { subject: 'ci: run tests on push', body: '## Why\nBroken main slipped through twice last month.' },
];

/** Add N noise commits to a repo (cycling the list), each touching DECISIONS.md. */
export async function addNoise(dir: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const d = NOISE_DECISIONS[i % NOISE_DECISIONS.length]!;
    appendFileSync(join(dir, 'DECISIONS.md'), `\n## ${d.subject}\n\n${d.body}\n`);
    await execa('git', ['add', '-A'], { cwd: dir });
    await execa('git', ['commit', '-q', '-F', '-'], { cwd: dir, input: `${d.subject}\n\n${d.body}` });
  }
}
