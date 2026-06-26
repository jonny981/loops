/**
 * Capstone A/B — loops as an engineering TEAM vs a single autonomous agent.
 *
 * Both arms build the same multi-component service (store / api / serialize / client) with
 * cross-cutting contracts only the store decides (stable never-reused ids, the `SSv1|` wire
 * tag). They are scored on a HELD-OUT integration gate neither sees at build time.
 *
 *  - loops-team   — the recipe in examples/build-service.loop.ts: a dag of Converge loops,
 *                   each an AgentDef specialist, isolated worktrees, and a 3-model adversarial
 *                   review gate. Cross-component contracts ride the Ledger (grounding).
 *  - single-agent — one `claude -p`, same base model, told to build the whole thing in one
 *                   turn (the Devin shape). It grades itself against the visible tests.
 *
 * The finding is the asymmetry: the single agent cannot apply an independent adversarial
 * review to itself, so it clears the visible per-component tests but not the held-out bar;
 * the enforced-review team clears both.
 *
 *   # offline — validate the gates are well-posed, no spend
 *   npx tsx bench/capstone.ts            (BENCH_VALIDATE defaults on when no model is set)
 *   BENCH_VALIDATE=1 npx tsx bench/capstone.ts
 *
 *   # live A/B (real spend)
 *   BENCH_TRIALS=3 BENCH_MODEL=sonnet npx tsx bench/capstone.ts
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { MockEngine, run, gateJob, type AgentRequest } from '../src/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, '../examples/build-service');
const REF = join(HERE, 'capstone-reference'); // the bench's answer key, not part of the example
const SEED = join(EX, 'seed');
const HELD_OUT = join(HERE, 'capstone-gate.mjs');
const COMPONENTS = ['store', 'api', 'serialize', 'client'] as const;

// ── workspace assembly ───────────────────────────────────────────────────────

/** A finished workspace = the seed (per-component tests + package.json) + the four impls. */
function finishedWorkspace(impls: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'capstone-ws-'));
  cpSync(SEED, dir, { recursive: true });
  for (const [name, src] of Object.entries(impls)) writeFileSync(join(dir, name), src);
  return dir;
}

const referenceImpls = (): Record<string, string> =>
  Object.fromEntries(COMPONENTS.map((c) => [`${c}.mjs`, readFileSync(join(REF, `${c}.mjs`), 'utf8')]));

/** Run a component's local convergence test in `dir`. */
async function runComponentTest(dir: string, comp: string): Promise<boolean> {
  const g = await execa('node', [`test-${comp}.mjs`], { cwd: dir, reject: false });
  return g.exitCode === 0;
}

/** Run the held-out integration gate against a finished workspace. */
async function runHeldOut(dir: string): Promise<{ pass: boolean; detail: string }> {
  cpSync(HELD_OUT, join(dir, '__held_out.mjs'));
  const g = await execa('node', ['__held_out.mjs'], { cwd: dir, reject: false });
  const lines = g.stderr.split('\n').filter(Boolean);
  const detail =
    g.exitCode === 0
      ? g.stdout.trim()
      : (lines.find((l) => /assert|error/i.test(l)) ?? lines.pop() ?? '').slice(0, 120);
  return { pass: g.exitCode === 0, detail };
}

// ── offline validation: the gates are well-posed, and the held-out bar is STRICTLY stronger ──

/** A self-consistent serializer that round-trips with plain JSON — no `SSv1|` wire tag. It
 *  passes its own local test (self-consistency) yet violates the interop contract. */
const PLAIN_JSON_SERIALIZE = `
export function snapshot(store) {
  return JSON.stringify({ counter: store.counter(), entries: store.entries() });
}
export function restore(text, createStore) {
  const { counter, entries } = JSON.parse(text);
  return createStore({ counter, entries });
}
`;

async function validate(): Promise<void> {
  console.log('capstone gate validation (offline, no model)\n');
  let ok = true;

  // 1. the reference system satisfies every gate (the bar is achievable)
  const ref = finishedWorkspace(referenceImpls());
  const refComp: Record<string, boolean> = {};
  for (const c of COMPONENTS) refComp[c] = await runComponentTest(ref, c);
  const refHeld = await runHeldOut(ref);
  rmSync(ref, { recursive: true, force: true });
  const allComp = COMPONENTS.every((c) => refComp[c]);
  console.log(`  reference · components ${COMPONENTS.map((c) => `${c}:${refComp[c] ? 'ok' : 'FAIL'}`).join(' ')}`);
  console.log(`  reference · held-out  ${refHeld.pass ? 'PASS' : 'FAIL'}  ${refHeld.detail}`);
  ok &&= allComp && refHeld.pass;

  // 2. a system whose components ALL pass their local tests but drifts on the wire tag
  //    fails the held-out gate — proving the held-out bar catches what the visible tests miss.
  const drift = finishedWorkspace({ ...referenceImpls(), 'serialize.mjs': PLAIN_JSON_SERIALIZE });
  const driftComp: Record<string, boolean> = {};
  for (const c of COMPONENTS) driftComp[c] = await runComponentTest(drift, c);
  const driftHeld = await runHeldOut(drift);
  rmSync(drift, { recursive: true, force: true });
  const driftAllLocalPass = COMPONENTS.every((c) => driftComp[c]);
  console.log(
    `\n  drift (plain-JSON serialize, no SSv1| tag) · components ${COMPONENTS.map((c) => `${c}:${driftComp[c] ? 'ok' : 'FAIL'}`).join(' ')}`,
  );
  console.log(`  drift · held-out  ${driftHeld.pass ? 'PASS' : 'fail'}  ${driftHeld.detail}`);
  // the knife: every local test passes, yet the held-out gate fails
  const knife = driftAllLocalPass && !driftHeld.pass;
  ok &&= knife;

  console.log(
    `\n  ${ok ? 'OK — reference clears every gate; the held-out bar is strictly stronger than the visible tests' : 'WRONG — gates are not well-posed'}`,
  );
  if (!ok) process.exit(1);
}

// ── offline orchestration check: the recipe converges + assembles a correct stack ──

/**
 * A reference engine (no model, no spend): it stands in for the agents so the FULL recipe
 * runs offline. For an engineer's turn it writes the reference impl of that component into
 * the turn's workspace; for a reviewer's turn it returns a passing dimensional verdict. This
 * exercises the real dag / loop / isolated-worktree / quorum / grounding plumbing end to end.
 */
function referenceEngine(): MockEngine {
  return new MockEngine((req: AgentRequest) => {
    const sys = req.system ?? '';
    // A reviewer's turn (the confidence-tag battery): approve with a passing tag.
    if (/<confidence>/.test(sys) || /close with .{0,8}<confidence>/i.test(req.prompt)) {
      return 'No concrete contract violation or real bug found.\n<confidence>100%</confidence>';
    }
    // An engineer's turn: the brief uniquely says "in `<comp>.mjs` so that". Write the impl.
    const m = req.prompt.match(/in .?(store|api|serialize|client)\.mjs.? so that/);
    if (m && req.cwd) {
      const comp = m[1]!;
      writeFileSync(join(req.cwd, `${comp}.mjs`), readFileSync(join(REF, `${comp}.mjs`), 'utf8'));
      return `implemented ${comp}.mjs`;
    }
    return 'ok'; // anything else (e.g. ledger compaction at commit) — harmless
  });
}

async function validateWiring(): Promise<void> {
  console.log('orchestration wiring (offline, reference engine — no model)\n');
  const seed = mkdtempSync(join(tmpdir(), 'capstone-wire-'));
  cpSync(SEED, seed, { recursive: true });
  const git = (args: string[]) => execa('git', args, { cwd: seed });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'x@x']);
  await git(['config', 'user.name', 'x']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'chore: seed']);

  const { default: buildService } = await import('../examples/build-service.loop.ts');
  const result = await run(buildService, {
    engine: 'reference',
    // The adversarial lens routes to engine 'codex'; offline, point it at the same mock.
    engines: { reference: () => referenceEngine(), codex: () => referenceEngine() },
    cwd: seed,
  });

  const present = COMPONENTS.filter((c) => existsSync(join(seed, `${c}.mjs`)));
  console.log(
    `  recipe converged: ${result.outcome.status === 'pass' ? 'yes' : `NO (${result.outcome.status})`} · files landed: ${present.join(', ') || 'none'}`,
  );
  const held = await runHeldOut(seed);
  console.log(`  held-out on the assembled stack: ${held.pass ? 'PASS' : 'FAIL'}  ${held.detail}`);
  rmSync(seed, { recursive: true, force: true });

  const ok = result.outcome.status === 'pass' && present.length === COMPONENTS.length && held.pass;
  console.log(
    `\n  ${ok ? 'OK — the dag/loop/isolated/review plumbing converges and assembles a correct stack offline' : 'WRONG — orchestration did not converge cleanly'}`,
  );
  if (!ok) process.exit(1);
}

// ── live A/B: loops-team vs single-agent (real spend) ────────────────────────

const MODEL = process.env.BENCH_MODEL || 'sonnet';
const TRIALS = Number(process.env.BENCH_TRIALS ?? 3);

/** Everything the team's store engineer authors + propagates, handed to one agent at once —
 *  so the single agent is not starved of information; the difference is coherence + review. */
const SINGLE_BRIEF =
  'Build a small service in this directory as four ES module files. Tests already exist ' +
  '(test-store.mjs, test-api.mjs, test-serialize.mjs, test-client.mjs) — make them ALL pass ' +
  '(run `node test-<name>.mjs` for each).\n\n' +
  'Components and their cross-cutting contracts:\n' +
  '- store.mjs — export createStore(initial?) with put/get/has/set/remove/ids/entries/count/counter. ' +
  'Ids come from a monotonic counter and are NEVER reused after a remove. The counter is part of the ' +
  'state (initial = { counter, entries }, entries = [id, value][]).\n' +
  '- api.mjs — export createApi(store) with create/read/update/delete/list. Delegate to the store id ' +
  'scheme; a create after a delete must mint a fresh id, never reuse the freed one.\n' +
  '- serialize.mjs — export snapshot(store) and restore(text, createStore). Every snapshot MUST begin ' +
  'with the exact, case-sensitive wire tag `SSv1|`. restore preserves entries AND the counter, so a put ' +
  'after restore continues the id sequence. Reject a payload without the tag.\n' +
  '- client.mjs — export createClient() with api()/snapshot()/restore(text). Wire api over store, ' +
  'snapshot via serialize, restore rebuilds the store and re-binds the api.\n\n' +
  'A snapshot then restore must return an identical system: same records, same ids, the sequence ' +
  'resuming where it left off. Make every test pass before you finish.';

async function setupSeed(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'capstone-run-'));
  cpSync(SEED, dir, { recursive: true });
  const git = (args: string[]) => execa('git', args, { cwd: dir });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'x@x']);
  await git(['config', 'user.name', 'x']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'chore: seed']);
  return dir;
}

interface ArmResult {
  pass: boolean;
  tokens: number;
  ms: number;
  detail: string;
}

/** loops-team arm: the recipe — dag of Converge loops, isolated worktrees, 3-model review. */
async function runTeamArm(): Promise<ArmResult> {
  const seed = await setupSeed();
  const { default: buildService } = await import('../examples/build-service.loop.ts');
  const t0 = Date.now();
  const result = await run(buildService, {
    engine: 'claude-cli',
    engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
    cwd: seed,
    recordTo: process.env.BENCH_RECORD, // optional JSONL event log for diagnosing a long run
  });
  const ms = Date.now() - t0;
  const tokens = result.stats.totalInputTokens + result.stats.totalOutputTokens;
  const held = await runHeldOut(seed);
  rmSync(seed, { recursive: true, force: true });
  return { pass: held.pass, tokens, ms, detail: held.detail };
}

/** single-agent arm: one claude turn, same base model, builds the whole thing (the Devin shape). */
async function runSingleArm(): Promise<ArmResult> {
  const seed = await setupSeed();
  const t0 = Date.now();
  const r = await execa(
    'claude',
    ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', MODEL],
    { cwd: seed, input: SINGLE_BRIEF, reject: false, timeout: 1_200_000 },
  );
  const ms = Date.now() - t0;
  let tokens = 0;
  try {
    const u = JSON.parse(r.stdout).usage ?? {};
    tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  } catch {
    /* token accounting is best-effort for the raw CLI */
  }
  const held = await runHeldOut(seed);
  rmSync(seed, { recursive: true, force: true });
  return { pass: held.pass, tokens, ms, detail: held.detail };
}

async function runLive(): Promise<void> {
  console.log(`Capstone A/B — loops-team vs single-agent · model ${MODEL} · ${TRIALS} trial(s)\n`);
  const tally: Record<string, { pass: number; tokens: number; ms: number }> = {
    team: { pass: 0, tokens: 0, ms: 0 },
    single: { pass: 0, tokens: 0, ms: 0 },
  };
  for (let t = 0; t < TRIALS; t++) {
    for (const [arm, runArm] of [
      ['team', runTeamArm],
      ['single', runSingleArm],
    ] as const) {
      const r = await runArm();
      tally[arm]!.pass += r.pass ? 1 : 0;
      tally[arm]!.tokens += r.tokens;
      tally[arm]!.ms += r.ms;
      console.log(
        `  trial ${t + 1}/${TRIALS}  ${arm.padEnd(6)} held-out ${r.pass ? 'PASS' : 'fail'} · ${r.tokens.toLocaleString()} tok · ${(r.ms / 1000).toFixed(0)}s${r.pass ? '' : ` · ${r.detail}`}`,
      );
    }
  }
  console.log('\n=== held-out quality bar (the bar neither arm saw at build time) ===');
  for (const arm of ['team', 'single'] as const)
    console.log(
      `  ${arm.padEnd(6)} ${tally[arm]!.pass}/${TRIALS} pass · ~${Math.round(tally[arm]!.tokens / TRIALS).toLocaleString()} tok/trial · ${(tally[arm]!.ms / TRIALS / 1000).toFixed(0)}s/trial`,
    );
}

// ── review calibration probe: does correct work pass the panel, and drift fail? ──

const CONTRACTS_COMMIT =
  'decision(store): stable ids + the SSv1| snapshot wire tag\n\n' +
  '## Why\nThe store owns the persistence contracts. Ids come from a monotonic counter and are ' +
  'NEVER reused after a remove. Snapshots use a versioned wire format: every snapshot MUST begin ' +
  'with the exact, case-sensitive tag `SSv1|`. restore preserves the entries AND the counter.';

/** A workspace where `<name>.mjs` = the case under test, every other component = reference, and
 *  the contracts live in the commit history (so the reviewer's grounding surfaces them). */
async function seedWithContracts(name: string, impl: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'capstone-review-'));
  cpSync(SEED, dir, { recursive: true });
  for (const c of COMPONENTS) writeFileSync(join(dir, `${c}.mjs`), readFileSync(join(REF, `${c}.mjs`), 'utf8'));
  writeFileSync(join(dir, `${name}.mjs`), impl); // overwrite the one under review
  const git = (args: string[], input?: string) =>
    execa('git', args, { cwd: dir, input, stdin: input === undefined ? 'ignore' : undefined });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'x@x']);
  await git(['config', 'user.name', 'x']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-F', '-'], CONTRACTS_COMMIT);
  return dir;
}

async function reviewProbe(): Promise<void> {
  const THRESH = 0.8;
  console.log(`review calibration — 5-lens battery, <confidence>% gating, threshold ${Math.round(THRESH * 100)}%\n`);
  const recipe = await import('../examples/build-service.loop.ts');
  // Calibrate cheaply: every lens on a Claude model (the adversarial codex path is validated
  // separately). Same personas + confidence-tag framing, so the calibration transfers.
  const LENSES: Array<[string, string]> = [
    ['adversarial', 'opus'],
    ['security', 'opus'],
    ['correctness', 'sonnet'],
    ['conformance', 'opus'],
    ['simplicity', 'haiku'],
  ];
  const cases: Array<[string, string, string]> = [
    ['correct', 'serialize', readFileSync(join(REF, 'serialize.mjs'), 'utf8')],
    ['drift  ', 'serialize', PLAIN_JSON_SERIALIZE], // plain-JSON, no SSv1| tag — the panel SHOULD block
  ];
  for (const [label, name, impl] of cases) {
    const dir = await seedWithContracts(name, impl);
    let cleared = 0;
    for (const [lens, model] of LENSES) {
      const res = await run(gateJob(lens, recipe.reviewer(name, lens, { model, threshold: THRESH })), {
        engine: 'claude-cli',
        engineOptions: { permissionMode: 'bypassPermissions', defaultModel: MODEL },
        cwd: dir,
      });
      const ok = res.outcome.status === 'pass';
      if (ok) cleared++;
      console.log(`  ${label} · ${lens.padEnd(12)} ${ok ? 'CLEAR' : 'BLOCK'} — ${(res.outcome.summary ?? '').slice(0, 110)}`);
    }
    console.log(`  ${label} · battery ${cleared}/${LENSES.length} cleared → ${cleared === LENSES.length ? 'PASS' : 'fail'}\n`);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.env.BENCH_RUN) return runLive();
  if (process.env.BENCH_REVIEW) return reviewProbe();
  if (process.env.BENCH_WIRING) return validateWiring();
  // Default to the offline gate validation unless a live run is explicitly requested.
  return validate();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
