/**
 * Offline probe: replicate the swebench.ts ON arm's 2-attempt structure
 *   loop(max:2, until:never, body: sequence(agentJob({ground:true}), commitJob))
 * with a MockEngine, and print EXACTLY what attempt 2 receives as grounding.
 * Zero model spend. Answers: is the cross-attempt grounding intact, and is its
 * content the clean "what attempt 1 tried" signal, or auto-capture/compaction noise?
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { run, loop, sequence, agentJob, commitJob, never, MockEngine } from '../src/api.ts';
import type { AgentRequest } from '../src/api.ts';

const dir = mkdtempSync(join(tmpdir(), 'probe-ground-'));
const git = (a: string[]) => execa('git', a, { cwd: dir });
await git(['init', '-q']);
await git(['config', 'user.email', 'x@y.z']);
await git(['config', 'user.name', 'probe']);
writeFileSync(join(dir, 'README.md'), 'base\n');
await git(['add', '-A']);
await git(['commit', '-q', '-m', 'base']);

let call = 0;
const log: string[] = [];
const fixPrompts: string[] = [];

const engine = new MockEngine((r: AgentRequest) => {
  call++;
  const sys = r.system ?? '';
  const role = /consolidat|compact|preserve every/i.test(sys + r.prompt) ? 'COMPACT' : 'FIX';
  log.push(
    `── mock call ${call} [${role}] ──\n` +
      `system(head): ${sys.slice(0, 140).replace(/\n/g, ' ')}\n` +
      `prompt(head): ${r.prompt.slice(0, 160).replace(/\n/g, ' ')}`,
  );
  if (role === 'COMPACT') return 'COMPACTED: attempt 1 changed foo() to return bar.';
  fixPrompts.push(r.prompt);
  if (fixPrompts.length === 1) {
    // edit a file so commitJob actually commits → exercises the real arm's
    // commit + reset-ledger + compaction path (not the no-edit shortcut).
    writeFileSync(join(dir, 'fix.txt'), 'attempt 1 edit\n');
    return 'ATTEMPT1_REASONING: the bug is in foo(); I edited foo() to return bar instead of baz.';
  }
  return 'ATTEMPT2 done';
});

const job = loop({
  name: 'probe',
  max: 2,
  until: never,
  body: sequence(
    'attempt',
    agentJob({
      label: 'fix',
      ground: true,
      prompt: (c) => `Attempt ${c.iteration}. Fix the issue.`,
      outcome: (t) => ({ status: 'fail', summary: t.slice(0, 200) }),
    }),
    commitJob({ subject: (c) => `attempt ${c.iteration}`, allowEmpty: true }),
  ),
});

await run(job, { cwd: dir, engine: 'mock', engines: { mock: () => engine } });

const attempt2Prompt = fixPrompts[1] ?? '';
console.log('\n══════════ MOCK CALL SEQUENCE ══════════');
log.forEach((l) => console.log(l + '\n'));
console.log(`fix calls: ${fixPrompts.length}, compact calls: ${log.filter((l) => l.includes('[COMPACT]')).length}`);
console.log('\n══════════ COMMIT BODIES (what grounding reads) ══════════\n');
const bodies = await git(['log', '--format=%H%n%B%n----']);
console.log(bodies.stdout);
console.log('══════════ ATTEMPT 2 — FULL PROMPT IT RECEIVED ══════════\n');
console.log(attempt2Prompt || '(no second fix call)');
console.log('\n══════════ DIAGNOSIS ══════════');
console.log('attempt 1 reasoning reached attempt 2 grounding? ',
  /ATTEMPT1_REASONING|changed foo\(\)|return bar/i.test(attempt2Prompt));
