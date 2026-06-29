/**
 * One-command Ledger demo.
 *
 * This is not a statistical benchmark and it does not call a model. It is a
 * deterministic mechanism demo for the thing the graph benchmark measures:
 * downstream work needs an upstream contract that lives only in git history.
 *
 * OFF applies the public prompts using only the files. ON reads the same repo's
 * commit log before the serialize step. Both pass the public smoke test; only ON
 * passes the hidden contract gate because it sees the `SSv1|` wire-format tag in
 * the upstream commit body.
 *
 *   npm run bench:wow
 */

import {
  cpSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import {
  commitJob,
  fnJob,
  groundingText,
  MockEngine,
  run,
  sequence,
  type Job,
} from '../src/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASK_DIR = join(HERE, 'graph-tasks/stable-store-contract');
const KEEP = process.env.BENCH_WOW_KEEP !== '0';

interface GraphTask {
  name: string;
  gate: string;
  foundation_why: string;
}

interface ArmResult {
  arm: 'off' | 'on';
  dir: string;
  sawContract: boolean;
  publicPass: boolean;
  gatePass: boolean;
  gateOutput: string;
  tokens: number;
}

function storeSource(opts: { includeFind: boolean; taggedSnapshot: boolean }): string {
  const tagDecl = opts.taggedSnapshot ? "const TAG = 'SSv1|';\n" : '';
  const find = opts.includeFind
    ? `
export function find(predicate) {
  return items.filter((it) => predicate(it.value)).map((it) => it.id);
}
`
    : '';
  const serialize = opts.taggedSnapshot
    ? `
export function toJSON() {
  return TAG + JSON.stringify({ items, nextId });
}

export function fromJSON(str) {
  if (typeof str !== 'string' || !str.startsWith(TAG)) {
    throw new Error('unsupported snapshot format');
  }
  const { items: saved, nextId: savedId } = JSON.parse(str.slice(TAG.length));
  items = saved;
  nextId = savedId;
}
`
    : `
export function toJSON() {
  return JSON.stringify({ items, nextId });
}

export function fromJSON(str) {
  const { items: saved, nextId: savedId } = JSON.parse(str);
  items = saved;
  nextId = savedId;
}
`;

  return `${tagDecl}let items = [];
let nextId = 1;

export function add(value) {
  const id = nextId++;
  items.push({ id, value });
  return id;
}

export function get(id) {
  const found = items.find((it) => it.id === id);
  return found ? found.value : undefined;
}

export function all() {
  return items.map((it) => it.value);
}

export function remove(id) {
  items = items.filter((it) => it.id !== id);
}
${find}${serialize}
export function _reset() {
  items = [];
  nextId = 1;
}
`;
}

async function git(dir: string, args: string[], input?: string): Promise<string> {
  const r = await execa('git', args, {
    cwd: dir,
    input,
    stdin: input === undefined ? 'ignore' : undefined,
  });
  return r.stdout;
}

async function prepareRepo(task: GraphTask, arm: ArmResult['arm']): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-wow-${arm}-`));
  cpSync(join(TASK_DIR, 'seed'), dir, { recursive: true });
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'bench@loops.local']);
  await git(dir, ['config', 'user.name', 'loops bench']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-F', '-'], task.foundation_why);
  return dir;
}

function writeStore(dir: string, opts: { includeFind: boolean; taggedSnapshot: boolean }): void {
  writeFileSync(join(dir, 'store.mjs'), storeSource(opts));
}

async function runCommand(dir: string, command: string): Promise<{ ok: boolean; output: string }> {
  const r = await execa('bash', ['-c', command], { cwd: dir, reject: false });
  return {
    ok: r.exitCode === 0,
    output: [r.stdout, r.stderr].filter(Boolean).join('\n').trim(),
  };
}

function conciseFailure(output: string): string {
  return (
    output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('AssertionError')) ??
    output.split('\n').find((line) => line.trim())?.trim() ??
    'command failed'
  );
}

async function runArm(task: GraphTask, arm: ArmResult['arm']): Promise<ArmResult> {
  const dir = await prepareRepo(task, arm);
  let sawContract = false;

  const remove: Job = fnJob('remove', async () => {
    writeStore(dir, { includeFind: false, taggedSnapshot: false });
    return { status: 'pass', summary: 'remove API present from the public files' };
  });

  const find: Job = fnJob('find', async () => {
    writeStore(dir, { includeFind: true, taggedSnapshot: false });
    return { status: 'pass', summary: 'added find(predicate) from the public prompt' };
  });

  const serialize: Job = fnJob('serialize', async (ctx) => {
    const memory = arm === 'on' ? await groundingText(ctx.workspace) : '';
    sawContract = memory.includes('SSv1|');
    writeStore(dir, { includeFind: true, taggedSnapshot: sawContract });
    return {
      status: 'pass',
      summary: sawContract
        ? 'read SSv1 contract from git memory and preserved it'
        : 'used plain JSON because the public prompt did not mention the SSv1 contract',
    };
  });

  const job = sequence(
    `wow-${arm}`,
    remove,
    commitJob({
      subject: 'feat(store): remove item by id',
      body: 'Public prompt work only. The wire-format contract is not in the file diff.',
      allowEmpty: true,
    }),
    find,
    commitJob({
      subject: 'feat(store): find matching ids',
      body: 'Public prompt work only. The wire-format contract is still only in the foundation commit.',
      allowEmpty: true,
    }),
    serialize,
    commitJob({
      subject: 'feat(store): serialize snapshots',
      body: () =>
        sawContract
          ? 'Serialize read the upstream SSv1 wire-format contract from git memory and emitted tagged snapshots.'
          : 'Serialize saw only the public prompt and emitted plain JSON snapshots.',
      allowEmpty: true,
    }),
  );

  const result = await run(job, {
    cwd: dir,
    engine: 'mock',
    engines: { mock: () => new MockEngine(() => 'unused') },
  });

  const publicResult = await runCommand(dir, 'node test-public.mjs');
  copyFileSync(join(TASK_DIR, 'gate.mjs'), join(dir, '__gate.mjs'));
  const gateResult = await runCommand(dir, task.gate);
  const tokens = result.stats.totalInputTokens + result.stats.totalOutputTokens;

  return {
    arm,
    dir,
    sawContract,
    publicPass: publicResult.ok,
    gatePass: gateResult.ok,
    gateOutput: gateResult.output,
    tokens,
  };
}

function mark(ok: boolean): string {
  return ok ? 'PASS' : 'FAIL';
}

async function main(): Promise<void> {
  const task = JSON.parse(readFileSync(join(TASK_DIR, 'task.json'), 'utf8')) as GraphTask;
  const off = await runArm(task, 'off');
  const on = await runArm(task, 'on');

  console.log('\nLoops Ledger wow demo');
  console.log('======================\n');
  console.log('Contract: snapshots must begin with SSv1|.');
  console.log('Where it lives: the foundation commit body, not the public files or prompts.\n');

  for (const r of [off, on]) {
    console.log(`${r.arm.toUpperCase()}`);
    console.log(`  saw contract in git memory: ${r.sawContract ? 'yes' : 'no'}`);
    console.log(`  public smoke test:          ${mark(r.publicPass)}`);
    console.log(`  hidden contract gate:       ${mark(r.gatePass)}`);
    console.log(`  model tokens spent:         ${r.tokens}`);
    console.log(`  workspace:                  ${r.dir}`);
    if (!r.gatePass && r.gateOutput)
      console.log(`  gate says:                  ${conciseFailure(r.gateOutput)}`);
    console.log('');
  }

  if (!off.gatePass && on.gatePass) {
    console.log('Result: OFF passes the visible test but loses the hidden contract.');
    console.log('        ON reads the upstream why from git memory and preserves it.');
  } else {
    console.log('Result: unexpected demo outcome; inspect the workspaces above.');
    process.exitCode = 1;
  }

  if (!KEEP) {
    rmSync(off.dir, { recursive: true, force: true });
    rmSync(on.dir, { recursive: true, force: true });
  } else {
    console.log('\nSet BENCH_WOW_KEEP=0 to delete the temp workspaces after the run.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
