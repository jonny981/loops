/**
 * Supersession A/B — when decisions EVOLVE (X → X′ → X″), does the memory strategy act
 * on the CURRENT value or a stale one? Each setting in a runtime config is decided then
 * revised over a long history (the reasons only in commit bodies). One final node must
 * implement `config()` returning the LATEST value of every setting. The gate (generated
 * from the same SETTINGS, single source of truth) checks each is current.
 *
 * This is the regime the other strategies miss BY CONSTRUCTION:
 *  - grep / read-the-log returns every revision; which is current? At DECISION scale (the
 *    revision history itself too big to read end-to-end) it cannot resolve them all.
 *  - vector-RAG ranks by relevance, not recency — a stale X is as similar as current X″,
 *    and a bigger top-k surfaces MORE stale versions.
 *  - consolidation folds history into a bounded ledger carrying the CURRENT state.
 *
 * Grep is a STRONG baseline (the agent can `git log --grep`), so the discriminator is
 * DECISION SCALE, not distractor noise — scale `SETTINGS`/revisions until the decision
 * history exceeds context. Distractors only add realism.
 *
 *   RAG_PYTHON=/path/to/rag-venv/bin/python BENCH_TRIALS=4 BENCH_MODEL=haiku \
 *     BENCH_NODE_MODEL=sonnet npx tsx bench/supersede.ts
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { addNoise } from './noise.ts';
import { gitCandidates, ragGroundingText } from './rag.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_DIR = join(HERE, 'graph-tasks/supersede');
const MODEL = process.env.BENCH_MODEL || 'haiku'; // cheap helpers (rag select / consolidate)
const NODE_MODEL = process.env.BENCH_NODE_MODEL || MODEL; // the implementing node
const TRIALS = Number(process.env.BENCH_TRIALS ?? 4);
const K = Number(process.env.BENCH_K ?? 8); // retrieval budget
const NOISE = Number(process.env.BENCH_NOISE ?? 0); // distractor commits (realism)
const NOISE_SIZE = Number(process.env.BENCH_NOISE_SIZE ?? 0);
const ARMS = (process.env.BENCH_ARMS || 'none,grep,rag,loops').split(',');

/** A setting and its revision chain (oldest → newest). Current value = last entry. */
interface Setting {
  key: string;
  /** JS literal text for each revision, oldest first. */
  revisions: string[];
  /** Why the value was first chosen / changed (per revision), for the commit body. */
  reasons: string[];
}

// 8 evolving settings (the base corpus). Scale by adding more — the gate is generated
// from this array, so corpus and gate never drift.
// Values are deliberately ARBITRARY (unguessable) so a no-memory agent cannot default
// into them — the current value is knowable only from the project history.
const SETTINGS: Setting[] = [
  { key: 'retryLimit', revisions: ['2', '6', '7'],
    reasons: ['start conservative', 'transient failures needed more', 'settled on 7 after the incident'] },
  { key: 'cacheTtlSeconds', revisions: ['90', '437'],
    reasons: ['short ttl while iterating', 'tuned to 437 to align with the upstream refresh window'] },
  { key: 'logLevel', revisions: ["'debug'", "'notice'"],
    reasons: ['verbose during bring-up', 'standardized on the custom "notice" level'] },
  { key: 'maxBatchSize', revisions: ['64', '173'],
    reasons: ['safe default', 'profiling pinned the sweet spot at 173'] },
  { key: 'authScheme', revisions: ["'basic'", "'hmac-sha256'"],
    reasons: ['basic for the prototype', 'security mandated hmac-sha256 request signing'] },
  { key: 'region', revisions: ["'us-east-1'", "'ap-southeast-3'"],
    reasons: ['initial deploy', 'the customer mandated ap-southeast-3 for data residency'] },
  { key: 'timeoutMs', revisions: ['5000', '1850'],
    reasons: ['generous to start', 'tightened to 1850 to hit the SLA'] },
  { key: 'shardCount', revisions: ['4', '11', '19'],
    reasons: ['single-region start', 'grew to 11', 'resharded to 19 for even key distribution'] },
];

const current = (s: Setting) => s.revisions[s.revisions.length - 1]!;

const NODE_PROMPT =
  'Implement `config()` in config.mjs so it returns an object with the CURRENT value of ' +
  'every runtime setting this project has established. Each setting was decided and then ' +
  'REVISED one or more times over the project history; the LATEST revision is the one in ' +
  'force — never a superseded earlier value. Use the project context provided. Do not ' +
  'guess: every value was decided and recorded.';

// ── corpus + gate generation (single source of truth: SETTINGS) ──────────────

/** Emit the revision commits (interleaved across settings) + optional distractors. */
async function buildHistory(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'supersede-hist-'));
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true });
  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: dir, input, stdin: input === undefined ? 'ignore' : undefined });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'x@x']);
  await git(['config', 'user.name', 'x']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'chore: seed config']);

  // Interleave revisions: round by round, so X, X′, X″ are scattered in time (a later
  // revision is a strictly later commit — recency is encoded only in commit order).
  const maxDepth = Math.max(...SETTINGS.map((s) => s.revisions.length));
  for (let round = 0; round < maxDepth; round++) {
    for (const s of SETTINGS) {
      if (round >= s.revisions.length) continue;
      const val = s.revisions[round]!;
      const prev = round > 0 ? ` (was ${s.revisions[round - 1]})` : '';
      const subject = `decision(config): set ${s.key} to ${val}${prev}`;
      const body = `## Why\n${s.reasons[round] ?? ''}\n\nThe current value of \`${s.key}\` is \`${val}\`.`;
      await git(['commit', '-q', '--allow-empty', '-F', '-'], `${subject}\n\n${body}`);
      if (NOISE > 0) await addNoise(dir, Math.ceil(NOISE / (maxDepth * SETTINGS.length)), NOISE_SIZE);
    }
  }
  return dir;
}

/** Generate __gate.mjs in a node workspace from SETTINGS — corpus and gate never drift. */
function writeGate(dir: string): void {
  const checks = SETTINGS.map((s) => {
    // JSON.stringify the message: revision literals contain quotes that would otherwise
    // break the string. The expected VALUE (current(s)) is injected as raw JS, not a string.
    const msg = JSON.stringify(`${s.key} must be the latest (${s.revisions.join(' → ')})`);
    return `assert.equal(c.${s.key}, ${current(s)}, ${msg});`;
  }).join('\n');
  const gate =
    `import assert from 'node:assert/strict';\n` +
    `import { config } from './config.mjs';\n` +
    `const c = config();\n` +
    `assert.ok(c && typeof c === 'object', 'config() must return an object');\n` +
    `${checks}\n` +
    `console.log('all ${SETTINGS.length} settings at current values');\n`;
  writeFileSync(join(dir, '__gate.mjs'), gate);
}

// ── memory strategies ────────────────────────────────────────────────────────

const claude = (input: string, extra: string[] = []) =>
  execa('claude', ['-p', '--model', MODEL, ...extra], { input, reject: false, timeout: 600_000 });

const SUPERSEDE_LEDGER_SYSTEM =
  'You maintain a CONSOLIDATED LEDGER of a project\'s settings from its commit history. ' +
  'Settings CHANGE over time — a later commit supersedes an earlier value for the same ' +
  'setting. Output the CURRENT value of each setting (the latest revision wins), one per ' +
  'line, as `key = value`. Resolve supersessions; never list a stale value.';

/** loops consolidation: fold the history into the current state of each setting. */
async function loopsLedger(dir: string): Promise<string> {
  const cands = await gitCandidates(dir);
  // oldest → newest so the model sees the supersession order
  const ordered = [...cands].reverse();
  const lines = ordered
    .map((c) => `- ${c.subject}`)
    .join('\n');
  const r = await claude(
    `${SUPERSEDE_LEDGER_SYSTEM}\n\nCOMMITS (oldest first):\n${lines}\n\nOutput the current settings ledger.`,
  );
  const led = r.stdout.trim();
  return led ? `## Current settings (consolidated — latest value wins)\n\n${led}` : '';
}

// ── the implementing node + its isolation ────────────────────────────────────

/**
 * Run the implementing node in `dir` with `prompt`; write the gate; return pass + chars.
 * Under BENCH_PROBE the node is a deterministic adversary instead of claude (the offline
 * isolation proof) — see `probeNode`.
 */
async function runNode(dir: string, prompt: string): Promise<{ pass: boolean; chars: number }> {
  const chars = prompt.length;
  if (process.env.BENCH_PROBE) {
    await probeNode(dir);
  } else {
    try {
      await execa(
        'claude',
        ['-p', '--permission-mode', 'bypassPermissions', '--model', NODE_MODEL],
        { cwd: dir, input: prompt, reject: false, timeout: 600_000 },
      );
    } catch {
      /* a node that errors just fails the gate */
    }
  }
  writeGate(dir);
  const g = await execa('node', ['__gate.mjs'], { cwd: dir, reject: false });
  return { pass: g.exitCode === 0, chars };
}

/**
 * grep arm: the node reads history from its OWN copy of the repo (with .git) — the strong
 * "let the agent read the log" baseline. Self-contained: it makes the copy, runs, gates,
 * and deletes its workspace in the same call, so no history from this arm outlives it and
 * a later memoryless node cannot reach it.
 */
async function runGrep(hist: string): Promise<{ pass: boolean; chars: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'supersede-grep-'));
  cpSync(hist, dir, { recursive: true }); // full repo incl. .git → agent can read history
  const prompt =
    `${NODE_PROMPT}\n\nThe project's full git history is in this repo — read it ` +
    `(e.g. \`git log\`) to find each setting's current value.`;
  try {
    return await runNode(dir, prompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Injected arms (none / rag / loops): a fresh seed-only workspace with the memory passed
 * as text. The caller guarantees NO history repo exists on disk while these run — that
 * isolation is what makes the no-memory arm an HONEST control. Without it a bypassPermissions
 * node would wander the temp root to the sibling history repo and read the answer, so even
 * `none` would "pass" — the leak this restructure closes.
 */
async function runInjected(arm: string, mem: string): Promise<{ pass: boolean; chars: number }> {
  const dir = mkdtempSync(join(tmpdir(), `supersede-${arm}-`));
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true }); // fresh, no history
  const prompt = mem ? `${mem}\n\n---\n\n${NODE_PROMPT}` : NODE_PROMPT;
  try {
    return await runNode(dir, prompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Offline self-test (no claude-cli): history builds, gate discriminates current vs stale. */
async function validate(): Promise<void> {
  const hist = await buildHistory();
  const log = await execa('git', ['log', '--oneline', '--grep=decision'], { cwd: hist });
  const decisions = log.stdout.split('\n').filter(Boolean);
  console.log(`history: ${decisions.length} decision commits (expect ${SETTINGS.reduce((n, s) => n + s.revisions.length, 0)})`);

  const correct = `export function config() { return {\n${SETTINGS.map((s) => `  ${s.key}: ${current(s)},`).join('\n')}\n}; }\n`;
  const stale = correct.replace(`${SETTINGS[0]!.key}: ${current(SETTINGS[0]!)}`, `${SETTINGS[0]!.key}: ${SETTINGS[0]!.revisions[0]}`);

  for (const [label, src, want] of [['CORRECT', correct, 0], ['STALE', stale, 1]] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'supersede-val-'));
    writeFileSync(join(dir, 'config.mjs'), src);
    writeGate(dir);
    const g = await execa('node', ['__gate.mjs'], { cwd: dir, reject: false });
    console.log(`  ${label}: gate exit ${g.exitCode} (want ${want}) → ${g.exitCode === want ? 'OK' : 'WRONG'}${g.exitCode ? ' · ' + (g.stderr.split('\n').find((l) => l.includes('AssertionError')) ?? '').slice(0, 80) : ''}`);
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(hist, { recursive: true, force: true });
}

// ── offline isolation probe (no model spend) ─────────────────────────────────

/** Remove leftover workspaces from earlier (possibly crashed) runs so a stale history repo
 *  can't be reached by a no-memory node. Safe: only this bench's own temp dirs. */
function sweepStale(): void {
  try {
    for (const name of readdirSync(tmpdir()))
      if (/^supersede-(hist|grep|none|rag|loops|val)-/.test(name))
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * A faithful adversary for the no-memory node: scan the node's own cwd and the shared temp
 * root for any reachable git repo holding the decision history. Returns that repo's path,
 * or null when none is reachable — exactly what a bypassPermissions agent could find.
 */
async function reachableHistory(cwd: string): Promise<string | null> {
  const roots = new Set<string>([cwd]);
  try {
    for (const name of readdirSync(tmpdir()))
      if (name.startsWith('supersede-')) roots.add(join(tmpdir(), name));
  } catch {
    /* temp root unreadable → nothing reachable */
  }
  for (const root of roots) {
    if (!existsSync(join(root, '.git'))) continue;
    const r = await execa('git', ['log', '--grep=decision(config)', '--pretty=%s'], {
      cwd: root,
      reject: false,
    });
    if (r.exitCode === 0 && r.stdout.trim()) return root;
  }
  return null;
}

/** Reconstruct config() from decision subjects (newest first → first per key is current). */
function reconstructConfig(subjects: string[]): string {
  const latest = new Map<string, string>();
  for (const s of subjects) {
    const m = s.match(/^decision\(config\): set (\w+) to (.+?)(?: \(was .*)?$/);
    if (m && !latest.has(m[1]!)) latest.set(m[1]!, m[2]!);
  }
  const body = [...latest].map(([k, v]) => `  ${k}: ${v},`).join('\n');
  return `export function config() { return {\n${body}\n}; }\n`;
}

/**
 * The probe node: if any history repo is reachable, read the current values straight out of
 * it (the leak realized); otherwise leave the seed stub (which returns {} and fails the
 * gate). No claude, no spend — a deterministic stand-in for the worst-case agent.
 */
async function probeNode(cwd: string): Promise<void> {
  const repo = await reachableHistory(cwd);
  if (!repo) return; // nothing to read → seed stub fails the gate (isolated)
  const r = await execa('git', ['log', '--grep=decision(config)', '--pretty=%s'], { cwd: repo });
  writeFileSync(join(cwd, 'config.mjs'), reconstructConfig(r.stdout.split('\n').filter(Boolean)));
}

/**
 * Offline isolation proof. Run the SAME adversary against the no-memory node twice:
 *   - history present on disk → the probe finds it and the node PASSES (the leak)
 *   - history deleted first   → nothing reachable, the node FAILS (isolated)
 * Same adversary, opposite verdicts — that gap is the isolation the real run enforces.
 * grep stays legitimate (reads its own history copy), so it must still PASS.
 */
async function probeSelfTest(): Promise<void> {
  console.log('isolation probe (offline, no model) — adversary reads any reachable history\n');

  const hist = await buildHistory(); // leak: a sibling history repo is on disk
  const leak = await runInjected('none', '');
  rmSync(hist, { recursive: true, force: true });

  const isolated = await runInjected('none', ''); // no history anywhere on disk

  const hist2 = await buildHistory();
  const grep = await runGrep(hist2);
  rmSync(hist2, { recursive: true, force: true });

  console.log(`  history reachable (leak)    none → ${leak.pass ? 'PASS' : 'fail'}   want PASS (probe can read a reachable repo)`);
  console.log(`  history deleted (isolated)  none → ${isolated.pass ? 'PASS' : 'fail'}   want fail (no repo to read)`);
  console.log(`  grep (its own history copy)      → ${grep.pass ? 'PASS' : 'fail'}   want PASS (legitimate history access)`);
  const ok = leak.pass && !isolated.pass && grep.pass;
  console.log(
    `\n  ${ok ? 'OK — the no-memory arm passes ONLY when history is reachable; deleting it closes the leak' : 'WRONG — isolation not behaving as expected'}`,
  );
  if (!ok) process.exit(1);
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  sweepStale(); // hermetic start: no leftover history repos from a prior run
  if (process.env.BENCH_VALIDATE) return validate();
  if (process.env.BENCH_PROBE) return probeSelfTest();
  console.log(
    `Supersession A/B — ${SETTINGS.length} evolving settings · ${TRIALS} trial(s) · ` +
      `node ${NODE_MODEL}, helpers ${MODEL} · k=${K}${NOISE ? ` · noise ${NOISE}×${NOISE_SIZE}` : ''}\n` +
      `arms: ${ARMS.join(', ')}`,
  );
  const tally: Record<string, { pass: number; chars: number }> = {};
  for (const a of ARMS) tally[a] = { pass: 0, chars: 0 };

  for (let t = 0; t < TRIALS; t++) {
    const results: Record<string, { pass: boolean; chars: number }> = {};
    const mem: Record<string, string> = {};
    const hist = await buildHistory();
    try {
      // Extract the injected memory while the history exists...
      if (ARMS.includes('rag')) mem.rag = await ragGroundingText(hist, NODE_PROMPT, K);
      if (ARMS.includes('loops')) mem.loops = await loopsLedger(hist);
      // ...and let grep read history from its own isolated copy (cleaned up before the rest).
      if (ARMS.includes('grep')) results.grep = await runGrep(hist);
    } finally {
      rmSync(hist, { recursive: true, force: true }); // history GONE before any memoryless arm
    }
    // The seed-only arms run with NO history reachable on disk — the honest control.
    for (const arm of ARMS) {
      if (arm === 'grep') continue;
      results[arm] = await runInjected(arm, mem[arm] ?? '');
    }
    for (const arm of ARMS) {
      const r = results[arm]!;
      tally[arm]!.pass += r.pass ? 1 : 0;
      tally[arm]!.chars = Math.max(tally[arm]!.chars, r.chars);
      console.log(
        `  trial ${t + 1}/${TRIALS}  ${arm.padEnd(6)} ${r.pass ? 'PASS' : 'fail'} · prompt ${r.chars.toLocaleString()} chars`,
      );
    }
  }

  console.log('\n=== resolve (every setting at its current value) ===');
  for (const arm of ARMS)
    console.log(`  ${arm.padEnd(6)} ${tally[arm]!.pass}/${TRIALS} · ~${Math.round(tally[arm]!.chars / 4).toLocaleString()} tok prompt`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
