/**
 * Accumulate A/B — does the memory strategy surface EVERYTHING the project decided,
 * or only the top-k most relevant? A store accrues twelve exact snapshot conventions,
 * each decided in its own commit's WHY (never in code). One final node must implement
 * `snapshot()` honouring ALL twelve; the gate is twelve binary assertions.
 *
 * This is the regime where retrieval has a ceiling: vector-RAG and a model reading
 * subjects both fetch the k MOST RELEVANT decisions, not ALL of them — past k they
 * miss conventions and the gate fails. Only a decision-preserving CONSOLIDATED LEDGER
 * (fold every decision into one bounded record) keeps all twelve — where a naive
 * progress SUMMARY drops the specifics. And unlike a full dump it stays bounded as the
 * log grows (see the capability result: dump overflows at scale).
 *
 * Clean isolation: the conventions live ONLY in commit bodies of a "history" repo,
 * used to derive each arm's injected memory. The node then runs in a FRESH workspace
 * with just the seed (no git log to spelunk), so the injected memory is its only
 * source. Every arm runs the same node the same way — only the memory strategy varies.
 *
 *   RAG_PYTHON=/path/to/rag-venv/bin/python BENCH_TRIALS=4 BENCH_MODEL=haiku \
 *     npx tsx bench/accumulate.ts
 */
import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { addNoise } from './noise.ts';
import { gitCandidates, ragGroundingText, type Candidate } from './rag.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_DIR = join(HERE, 'graph-tasks/accumulate');
const MODEL = process.env.BENCH_MODEL || 'haiku'; // cheap helpers (select/summary/consolidate)
const NODE_MODEL = process.env.BENCH_NODE_MODEL || MODEL; // the node that implements; raise to isolate memory from implementation noise
const TRIALS = Number(process.env.BENCH_TRIALS ?? 4);
const K = Number(process.env.BENCH_K ?? 8); // retrieval budget (< 12 conventions)
const NOISE = Number(process.env.BENCH_NOISE ?? 0);
const NOISE_SIZE = Number(process.env.BENCH_NOISE_SIZE ?? 0);
const ARMS = (process.env.BENCH_ARMS || 'dump,rag,select,summary,consolidate').split(',');

// The twelve conventions — each its own commit, the rule in the subject AND the why,
// none in the seed code. They map 1:1 onto gate.mjs C1…C12.
const CONVENTIONS: { subject: string; why: string }[] = [
  { subject: 'feat(export): prefix snapshots with the SSv1| wire tag',
    why: 'The deployed client validates a leading `SSv1|` literal before parsing. snapshot() output MUST start with exactly `SSv1|`, then the JSON.' },
  { subject: 'feat(export): the body after the tag is a single JSON object',
    why: 'After the `SSv1|` prefix the remainder is one JSON object — not a bare array, not a primitive. The client does `JSON.parse(out.slice(5))`.' },
  { subject: 'feat(export): schema version under key `_v` = 1',
    why: 'We standardized the version key as `_v` (chosen over `version`/`schemaVersion` to match the client parser). Its value is the integer 1.' },
  { subject: 'feat(export): items live under key `records`',
    why: 'The array of items is keyed `records` (NOT `items`/`data`). The client iterates `payload.records`.' },
  { subject: "feat(export): each record's value key is `val`",
    why: 'Inside each record the stored value is under `val`, never `value`. The client reads `r.val`.' },
  { subject: 'feat(export): record ids are numbers under key `id`',
    why: 'Each record carries its id under `id` as a JSON number (not a string). Stable ids matter to the client.' },
  { subject: 'feat(export): records sorted by id ascending',
    why: 'The client merges snapshots assuming `records` is sorted by `id` ascending. Sort before emitting.' },
  { subject: 'feat(export): include a top-level `count` of records',
    why: '`count` is the number of records in this snapshot — a fast client-side integrity check. It equals records.length.' },
  { subject: 'feat(export): include `gen` = highest id ever issued',
    why: '`gen` is the id counter: the highest id ever issued (it survives removals), so the client can resume id allocation. It is NOT the record count. Use the store\'s `_gen()`.' },
  { subject: 'feat(export): tag payloads with `schema` = "store/export"',
    why: 'A routing key the client switches on. The exact string is `store/export`.' },
  { subject: 'feat(export): include `checksum` = sum of record ids',
    why: 'A cheap tamper check: `checksum` is the arithmetic sum of all record ids in the snapshot.' },
  { subject: 'feat(export): mark snapshots `frozen: true`',
    why: 'Snapshots are immutable once written; the client REFUSES any payload that lacks `frozen: true`.' },
];

const NODE_PROMPT =
  'Add a `snapshot()` function to store.mjs that returns a STRING snapshot of the ' +
  "store's current items (use the internal accessors `_items()` and `_gen()`). This " +
  'project standardized a number of EXACT formatting conventions for that snapshot, ' +
  'each decided earlier and captured in the context above. The deployed client ' +
  'REJECTS a snapshot that violates even one of them. Implement `snapshot()` to honour ' +
  'EVERY convention in the context. Do not guess or invent format details — every ' +
  'choice was already made; if a detail is in the context, follow it exactly.';

const SELECT_SYSTEM =
  'You select which past commits are relevant CONTEXT for a task. Be selective: ' +
  'return only genuinely relevant commits, fewer is better. Output ONLY shas, ' +
  'comma-separated, most relevant first — or the single word NONE.';
// Naive consolidation: a running progress SUMMARY (what loops' core does today). It
// compresses for progress, so it is lossy on exact decisions — the baseline to beat.
const SUMMARY_SYSTEM =
  'You maintain a concise running SUMMARY of a project from its commits. ' +
  'Output short markdown: what is done, the current state, and the open threads. ' +
  'Keep it tight — coarse memory, not a changelog. MERGE new commits into the prior ' +
  'summary; do not just append.';
// The refinement: consolidate into a decision-preserving CONSOLIDATED LEDGER, not a
// progress summary — the coarse tier of the ledger, one scale up from ledger.md.
const LEDGER_SYSTEM =
  'You maintain a project CONSOLIDATED LEDGER from its commit history — the bounded ' +
  'memory downstream work reads to stay consistent. PRESERVE EVERY binding decision, ' +
  'convention, constraint and EXACT value (keys, tags, formats, formulas) verbatim; ' +
  'downstream work must honour all of them, so generalising or dropping any one is a ' +
  'failure. Deduplicate and organise into a tight list — one line per rule — and omit ' +
  'only narrative and process. Never omit a rule.';

const truncate = (s: string, n: number) =>
  s.trim().length > n ? `${s.trim().slice(0, n).trimEnd()}\n…` : s.trim();
const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';
const claude = (input: string, extra: string[] = []) =>
  execa('claude', ['-p', '--model', MODEL, ...extra], { input, reject: false, timeout: 600_000 });

/** A history repo: seed + the twelve convention commits (+ optional noise). */
async function buildHistory(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'acc-hist-'));
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true });
  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: dir, input, stdin: input === undefined ? 'ignore' : undefined });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'x@x']);
  await git(['config', 'user.name', 'x']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'chore: seed the store']);
  // Each convention is an EMPTY commit — the rule lives only in the message, never in
  // a workspace file, so the node cannot read it except through injected memory.
  for (const c of CONVENTIONS)
    await git(['commit', '-q', '--allow-empty', '-F', '-'], `${c.subject}\n\n## Why\n${c.why}`);
  if (NOISE > 0) await addNoise(dir, NOISE, NOISE_SIZE);
  return dir;
}

function renderEntries(cands: Candidate[]): string {
  return cands
    .map((c) => `### ${c.sha.slice(0, 7)}  ${c.subject}\n\n${truncate(c.body, 1200)}`)
    .join('\n\n');
}

/** dump: paste the whole log (the brute-force upper bound). */
async function dumpText(dir: string): Promise<string> {
  const r = await execa('git', ['log', '--format=%s%n%n%b%n----'], { cwd: dir });
  return `## Full project history (every commit)\n\n${r.stdout}`;
}

/** select: loops' own strategy — a cheap model reads SUBJECTS and picks top-k. */
async function selectText(dir: string, intent: string): Promise<string> {
  const cands = await gitCandidates(dir);
  const list = cands.map((c) => `${c.sha.slice(0, 9)}: ${c.subject}`).join('\n');
  const r = await claude(
    `${SELECT_SYSTEM}\n\nTASK:\n${intent}\n\nCANDIDATE COMMITS (sha: subject):\n${list}\n\n` +
      `Return the shas relevant to the TASK (up to ${K}), or NONE.`,
  );
  const ids = r.stdout.toLowerCase().match(/[0-9a-f]{7,40}/g) ?? [];
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const c = cands.find((x) => x.sha.startsWith(id));
    if (c && !seen.has(c.sha)) {
      seen.add(c.sha);
      picked.push(c);
    }
  }
  const top = picked.slice(0, K);
  if (!top.length) return '';
  return `## Relevant prior work (a model read the subjects and selected)\n\n${renderEntries(top)}`;
}

/** summary: the naive consolidation — a progress summary (loops' core behaviour today). */
async function summaryText(dir: string): Promise<string> {
  const cands = await gitCandidates(dir);
  const milestones = cands
    .map((c) => `- ${c.sha.slice(0, 7)} ${c.subject}${c.body ? `: ${firstLine(c.body)}` : ''}`)
    .join('\n');
  const r = await claude(
    `${SUMMARY_SYSTEM}\n\nCOMMITS (newest first):\n${milestones}\n\nOutput the updated summary.`,
  );
  const sum = r.stdout.trim();
  return sum ? `## Project summary (consolidated)\n\n${sum}` : '';
}

/** consolidate: the refinement — a decision-preserving CONSOLIDATED LEDGER. */
async function consolidateText(dir: string): Promise<string> {
  const cands = await gitCandidates(dir);
  const entries = cands
    .map((c) => `- ${c.subject}\n  ${truncate(c.body, 400).replace(/\s+/g, ' ')}`)
    .join('\n');
  const r = await claude(
    `${LEDGER_SYSTEM}\n\nCOMMITS (subject + why):\n${entries}\n\nOutput the consolidated ledger.`,
  );
  const led = r.stdout.trim();
  return led ? `## Consolidated ledger (every decision this project standardized)\n\n${led}` : '';
}

async function memoryFor(arm: string, dir: string): Promise<string> {
  if (arm === 'dump') return dumpText(dir);
  if (arm === 'rag') return ragGroundingText(dir, NODE_PROMPT, K);
  if (arm === 'select') return selectText(dir, NODE_PROMPT);
  if (arm === 'summary') return summaryText(dir);
  if (arm === 'consolidate') return consolidateText(dir);
  throw new Error(`unknown arm ${arm}`);
}

/** Run the node in a FRESH seed workspace with the injected memory as its only source. */
async function runNode(memory: string): Promise<{ pass: boolean; chars: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'acc-node-'));
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true });
  const full = memory ? `${memory}\n\n---\n\n${NODE_PROMPT}` : NODE_PROMPT;
  try {
    await execa(
      'claude',
      ['-p', '--permission-mode', 'bypassPermissions', '--model', NODE_MODEL],
      { cwd: dir, input: full, reject: false, timeout: 600_000 },
    );
  } catch {
    /* a node that errors just fails the gate */
  }
  copyFileSync(join(TASK_DIR, 'gate.mjs'), join(dir, '__gate.mjs'));
  const g = await execa('node', ['__gate.mjs'], { cwd: dir, reject: false });
  rmSync(dir, { recursive: true, force: true });
  return { pass: g.exitCode === 0, chars: full.length };
}

async function main(): Promise<void> {
  console.log(
    `Accumulate A/B — honour all ${CONVENTIONS.length} conventions · ${TRIALS} trial(s) · ` +
      `model ${MODEL} · retrieval k=${K}${NOISE ? ` · noise ${NOISE}×${NOISE_SIZE}` : ''}\n` +
      `arms: ${ARMS.join(', ')}`,
  );
  const tally: Record<string, { pass: number; chars: number }> = {};
  for (const a of ARMS) tally[a] = { pass: 0, chars: 0 };

  for (let t = 0; t < TRIALS; t++) {
    const hist = await buildHistory();
    try {
      for (const arm of ARMS) {
        const mem = await memoryFor(arm, hist);
        const { pass, chars } = await runNode(mem);
        tally[arm]!.pass += pass ? 1 : 0;
        tally[arm]!.chars = Math.max(tally[arm]!.chars, chars);
        console.log(`  trial ${t + 1}/${TRIALS}  ${arm.padEnd(11)} ${pass ? 'PASS' : 'fail'} · inject ${chars.toLocaleString()} chars`);
      }
    } finally {
      rmSync(hist, { recursive: true, force: true });
    }
  }

  console.log('\n=== resolve (all 12 conventions honoured) ===');
  for (const arm of ARMS) {
    const r = tally[arm]!;
    console.log(
      `  ${arm.padEnd(11)} ${r.pass}/${TRIALS} held · ~${Math.round(r.chars / 4).toLocaleString()} tok injected`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
