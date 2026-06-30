/**
 * One-command Ledger mechanism demo.
 *
 * This is not a statistical benchmark and it does not call a model. It is a
 * deterministic mechanism demo for the thing the graph benchmark measures:
 * downstream work needs an upstream contract that lives only in git history.
 *
 * OFF applies the public prompts using only the files. ON reads the same repo's
 * commit log before the serialize step. Both pass the public smoke test; only ON
 * ships snapshots the mixed deployed-client fleet can read because it sees the
 * `SSv1|` wire-format tag in the upstream commit body.
 *
 *   npm run bench:mechanism
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
const KEEP = process.env.BENCH_MECHANISM_KEEP === '1';
const DEFAULT_FLEET_SIZE = 10_000;
const FLEET_SIZE = positiveIntEnv('BENCH_MECHANISM_FLEET', DEFAULT_FLEET_SIZE);
const SERVICES = ['billing', 'checkout', 'admin', 'mobile', 'partner-api', 'reports', 'support', 'audit'];
const REGIONS = ['iad', 'lhr', 'sfo', 'fra', 'syd'];
const SERVICE_REPLAY_MIX: Record<string, { strict: number; lenient: number }> = {
  billing: { strict: 62, lenient: 31 },
  checkout: { strict: 56, lenient: 36 },
  admin: { strict: 14, lenient: 54 },
  mobile: { strict: 38, lenient: 43 },
  'partner-api': { strict: 27, lenient: 52 },
  reports: { strict: 19, lenient: 63 },
  support: { strict: 0, lenient: 46 },
  audit: { strict: 8, lenient: 59 },
};

type Arm = 'off' | 'on';
type ClientMode = 'strict-reader' | 'lenient-reader' | 'write-only';

interface GraphTask {
  name: string;
  gate: string;
  foundation_why: string;
  nodes: Array<{ name: string; prompt: string }>;
}

interface ArmResult {
  dir: string;
  sawContract: boolean;
  memoryEvidence: string;
  publicPass: boolean;
  gatePass: boolean;
  snapshot: string;
  fleet: FleetReplay;
  tokens: number;
}

interface FleetClient {
  id: string;
  service: string;
  region: string;
  mode: ClientMode;
}

interface FleetReplay {
  total: number;
  accepted: number;
  rejected: number;
  unaffected: number;
  strictReaders: number;
  lenientReaders: number;
  writeOnly: number;
  sampleFailures: string[];
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

async function prepareRepo(task: GraphTask, arm: Arm): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `loops-mechanism-${arm}-`));
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

function memoryEvidenceLine(memory: string): string {
  const lines = memory
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const line =
    lines.find((line) => line.includes('Snapshots returned by toJSON() MUST begin')) ??
    lines.find((line) => line.includes('SSv1|')) ??
    '';
  const cleaned = line.replace(/`/g, '');
  const firstSentence = cleaned.indexOf('. ');
  return firstSentence === -1 ? cleaned : cleaned.slice(0, firstSentence + 1);
}

function snapshotProbeSource(): string {
  return `import * as store from './store.mjs';

store._reset();
store.add('paid-plan');
store.add('enterprise-plan');
console.log(store.toJSON());
`;
}

function fleetClient(index: number): FleetClient {
  const id = `client-${String(index + 1).padStart(5, '0')}`;
  const service = SERVICES[index % SERVICES.length];
  const region = REGIONS[Math.floor(index / SERVICES.length) % REGIONS.length];
  const mix = SERVICE_REPLAY_MIX[service] ?? { strict: 0, lenient: 0 };
  const bucket = stableBucket(`${id}:${service}:${region}`);
  const mode =
    bucket < mix.strict
      ? 'strict-reader'
      : bucket < mix.strict + mix.lenient
        ? 'lenient-reader'
        : 'write-only';

  return {
    id,
    service,
    region,
    mode,
  };
}

function stableBucket(value: string): number {
  let hash = 2166136261;
  for (const ch of value) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

function validateSnapshotForClient(snapshot: string, client: FleetClient): string | undefined {
  if (client.mode === 'write-only') return undefined;

  const tagged = snapshot.startsWith('SSv1|');
  if (client.mode === 'strict-reader' && !tagged) {
    return `${client.id} ${client.service}/${client.region} strict reader: missing SSv1| snapshot tag`;
  }

  try {
    const payload = tagged ? snapshot.slice('SSv1|'.length) : snapshot;
    const parsed = JSON.parse(payload) as {
      items?: Array<{ id?: unknown; value?: unknown }>;
      nextId?: unknown;
    };
    const hasItems = Array.isArray(parsed.items);
    const hasNextId = typeof parsed.nextId === 'number';
    if (!hasItems || !hasNextId) {
      return `${client.id} ${client.service}/${client.region}: malformed snapshot payload`;
    }
  } catch {
    return `${client.id} ${client.service}/${client.region}: snapshot payload is not valid JSON`;
  }

  return undefined;
}

function replayFleet(snapshot: string, size: number): FleetReplay {
  let accepted = 0;
  let rejected = 0;
  let unaffected = 0;
  let strictReaders = 0;
  let lenientReaders = 0;
  let writeOnly = 0;
  const sampleFailures: string[] = [];

  for (let i = 0; i < size; i++) {
    const client = fleetClient(i);
    if (client.mode === 'strict-reader') strictReaders++;
    else if (client.mode === 'lenient-reader') lenientReaders++;
    else writeOnly++;

    if (client.mode === 'write-only') {
      unaffected++;
      continue;
    }

    const failure = validateSnapshotForClient(snapshot, client);
    if (failure) {
      rejected++;
      if (sampleFailures.length < 3) sampleFailures.push(failure);
    } else accepted++;
  }

  return {
    total: size,
    accepted,
    rejected,
    unaffected,
    strictReaders,
    lenientReaders,
    writeOnly,
    sampleFailures,
  };
}

async function runArm(task: GraphTask, arm: Arm): Promise<ArmResult> {
  const dir = await prepareRepo(task, arm);
  let sawContract = false;
  let memoryEvidence = '';

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
    memoryEvidence = sawContract ? memoryEvidenceLine(memory) : '';
    writeStore(dir, { includeFind: true, taggedSnapshot: sawContract });
    return {
      status: 'pass',
      summary: sawContract
        ? 'read SSv1 contract from git memory and preserved it'
        : 'used plain JSON because the public prompt did not mention the SSv1 contract',
    };
  });

  const job = sequence(
    `mechanism-${arm}`,
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
  writeFileSync(join(dir, '__snapshot.mjs'), snapshotProbeSource());
  const snapshotResult = await runCommand(dir, 'node __snapshot.mjs');
  copyFileSync(join(TASK_DIR, 'gate.mjs'), join(dir, '__gate.mjs'));
  const gateResult = await runCommand(dir, task.gate);
  const tokens = result.stats.totalInputTokens + result.stats.totalOutputTokens;
  const fleet = replayFleet(snapshotResult.output, FLEET_SIZE);

  return {
    dir,
    sawContract,
    memoryEvidence,
    publicPass: publicResult.ok,
    gatePass: gateResult.ok,
    snapshot: snapshotResult.output,
    fleet,
    tokens,
  };
}

function mark(ok: boolean): string {
  return ok ? 'PASS' : 'FAIL';
}

function yesNo(ok: boolean): string {
  return ok ? 'yes' : 'no';
}

function preview(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 88 ? `${oneLine.slice(0, 85)}...` : oneLine;
}

function fmt(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value);
}

function printArm(label: string, result: ArmResult): void {
  const outcome =
    result.fleet.rejected === 0
      ? 'visible tests green, fleet replay clean'
      : 'visible tests green, fleet replay broken';
  console.log(`${label}: ${outcome}`);
  console.log(`  remembered upstream contract: ${yesNo(result.sawContract)}`);
  if (result.memoryEvidence) console.log(`  proof read from git:           ${result.memoryEvidence}`);
  console.log(`  public smoke test:            ${mark(result.publicPass)}`);
  console.log(`  snapshot shipped:             ${preview(result.snapshot)}`);
  console.log(
    `  replay mix:                   ${fmt(result.fleet.strictReaders)} strict readers, ${fmt(
      result.fleet.lenientReaders,
    )} lenient readers, ${fmt(result.fleet.writeOnly)} write-only`,
  );
  console.log(
    `  fleet replay:                 ${fmt(result.fleet.accepted)} accepted, ${fmt(
      result.fleet.rejected,
    )} rejected, ${fmt(result.fleet.unaffected)} unaffected, ${fmt(result.fleet.total)} total`,
  );
  console.log(`  blast radius:                 ${fmt(result.fleet.rejected)} broken deployed clients`);
  console.log(`  full invariant gate:          ${mark(result.gatePass)}`);
  console.log(`  model tokens spent:           ${result.tokens}`);
  for (const failure of result.fleet.sampleFailures) {
    console.log(`  sample failure:               ${failure}`);
  }
  if (KEEP) console.log(`  workspace:                    ${result.dir}`);
  console.log('');
}

async function main(): Promise<void> {
  const task = JSON.parse(readFileSync(join(TASK_DIR, 'task.json'), 'utf8')) as GraphTask;
  const serializePrompt = task.nodes.find((node) => node.name === 'serialize')?.prompt ?? '';
  const off = await runArm(task, 'off');
  const on = await runArm(task, 'on');

  console.log('\nLoops Ledger demo: the bug only memory catches');
  console.log('===============================================\n');
  console.log('Visible issue: add save/load snapshots to the store.');
  console.log(`Public prompt mentions SSv1|: ${yesNo(serializePrompt.includes('SSv1|'))}`);
  console.log(`Foundation commit mentions SSv1|: ${yesNo(task.foundation_why.includes('SSv1|'))}`);
  console.log('Hidden reality: strict deployed readers reject snapshots without that tag.\n');
  console.log(
    `Scale replay: ${fmt(FLEET_SIZE)} mixed deployed clients across ${SERVICES.length} services and ${REGIONS.length} regions.`,
  );
  console.log('Same visible repo. Same public test. Same model spend.');
  console.log('Only one run reads the verified engineering memory in git.\n');

  printArm('VANILLA AGENT', off);
  printArm('LOOPS LEDGER AGENT', on);

  if (off.fleet.rejected > 0 && !off.gatePass && on.fleet.rejected === 0 && on.gatePass) {
    console.log('Bottom line: both runs look green to the public test.');
    console.log(`One missed upstream contract breaks ${fmt(off.fleet.rejected)} strict deployed readers.`);
    console.log('Loops reads the upstream why once and all snapshot readers accept the replay.');
  } else {
    console.log(
      'Result: unexpected demo outcome; rerun with BENCH_MECHANISM_KEEP=1 to inspect temp workspaces.',
    );
    process.exitCode = 1;
  }

  if (!KEEP) {
    rmSync(off.dir, { recursive: true, force: true });
    rmSync(on.dir, { recursive: true, force: true });
  } else console.log('\nTemp workspaces retained.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
