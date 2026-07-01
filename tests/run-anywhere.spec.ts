import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The agent-native run-from-anywhere contract: `loops run` / `loops validate`
// must transform and execute a `.loop.ts` that lives OUTSIDE this package's tree.
// These spawn the real bin as a subprocess, which is the only faithful test of
// the tsx-loader wiring (a plain in-process import would not exercise it). The
// recipe imports loops' API by a `file:` URL into src, so the recipe and the
// bin resolve to the same source (and so share the meta registry).

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(repoRoot, 'bin', 'loops.mjs');
const apiUrl = pathToFileURL(join(repoRoot, 'src', 'api.ts')).href;

async function loops(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('node', [bin, ...args], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

const RECIPE = `import { defineJob, loop, fnJob, predicate } from '${apiUrl}';
let ticks = 0;
export default defineJob(
  loop({
    name: 'oot-smoke',
    body: fnJob('check', async () => {
      ticks += 1;
      return { status: ticks >= 2 ? 'pass' : 'fail', summary: 'tick ' + ticks };
    }),
    until: predicate(() => ticks >= 2, 'two ticks'),
    max: 5,
  }),
);
`;

describe('running a loop from outside the package tree', () => {
  let dir: string;

  beforeAll(() => {
    // An out-of-tree recipe in its own ES module scope (what a consumer repo has).
    dir = mkdtempSync(join(tmpdir(), 'loops-oot-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'recipe.loop.ts'), RECIPE);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs an out-of-tree recipe to convergence', async () => {
    const { code, out } = await loops(
      ['run', join(dir, 'recipe.loop.ts'), '--no-tui'],
      dir,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/pass/i);
  }, 30_000);

  it('validate loads an out-of-tree recipe without executing it', async () => {
    const { code, out } = await loops(
      ['validate', join(dir, 'recipe.loop.ts')],
      dir,
    );
    expect(code).toBe(0);
    expect(out).toContain('loads');
    expect(out).toMatch(/loop "oot-smoke"/); // validate prints the loop's shape
  }, 30_000);

  it('validate and describe can emit JSON for agent inspection', async () => {
    const validate = await loops(['validate', join(dir, 'recipe.loop.ts'), '--json'], dir);
    expect(validate.code).toBe(0);
    const validateJson = JSON.parse(validate.out) as {
      ok: boolean;
      executed: boolean;
      shape: { kind: string; name: string };
    };
    expect(validateJson).toMatchObject({
      ok: true,
      executed: false,
      shape: { kind: 'loop', name: 'oot-smoke' },
    });

    const describe = await loops(['describe', join(dir, 'recipe.loop.ts'), '--json'], dir);
    expect(describe.code).toBe(0);
    expect(JSON.parse(describe.out)).toMatchObject({
      kind: 'loop',
      name: 'oot-smoke',
      body: { kind: 'fn', name: 'check' },
    });
  }, 30_000);

  it('records exposes supervised semantic records from the CLI', async () => {
    const home = mkdtempSync(join(tmpdir(), 'loops-records-'));
    try {
      const env = { LOOPS_HOME: home };
      const runResult = await loops(
        ['run', join(dir, 'recipe.loop.ts'), '--no-tui', '--supervise'],
        dir,
        env,
      );
      expect(runResult.code).toBe(0);
      const [runId] = readdirSync(join(home, 'runs'));
      expect(runId).toBeTruthy();

      const human = await loops(['records', runId!, '--kind', 'completion'], dir, env);
      expect(human.code).toBe(0);
      expect(human.out).toMatch(/completion loop: pass/);

      const json = await loops(
        ['records', runId!, '--kind', 'completion', '--json'],
        dir,
        env,
      );
      expect(json.code).toBe(0);
      const records = json.out
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { kind: string; outcome?: { status: string } });
      expect(records.some((r) => r.kind === 'completion' && r.outcome?.status === 'pass')).toBe(true);

      const last = await loops(
        ['records', runId!, '--kind', 'completion', '--last', '1', '--json'],
        dir,
        env,
      );
      expect(last.code).toBe(0);
      const lastRecord = JSON.parse(last.out.trim()) as {
        kind: string;
        unit: string;
        outcome?: { status: string };
      };
      expect(lastRecord).toMatchObject({
        kind: 'completion',
        unit: 'loop',
        outcome: { status: 'pass' },
      });

      const path = await loops(
        ['records', runId!, '--path', 'oot-smoke', '--kind', 'completion', '--json'],
        dir,
        env,
      );
      expect(path.code).toBe(0);
      const pathRecords = path.out
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { path: string[] });
      expect(pathRecords.length).toBeGreaterThan(0);
      expect(pathRecords.every((r) => r.path.join('/').startsWith('oot-smoke'))).toBe(true);

      const since = await loops(
        ['records', runId!, '--since', '0', '--kind', 'completion', '--json'],
        dir,
        env,
      );
      expect(since.code).toBe(0);
      expect(since.out.trim().split('\n').length).toBe(records.length);

      const invalid = await loops(['records', runId!, '--last', '0'], dir, env);
      expect(invalid.code).toBe(1);
      expect(invalid.out).toContain('--last must be a positive integer');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('records treats revision as an alias for emitted and routed revision records', async () => {
    const home = mkdtempSync(join(tmpdir(), 'loops-revision-records-'));
    try {
      const env = { LOOPS_HOME: home };
      const runResult = await loops(
        ['run', join(repoRoot, 'examples', 'feedback.loop.ts'), '--no-tui', '--supervise'],
        dir,
        env,
      );
      expect(runResult.code).toBe(0);
      const [runId] = readdirSync(join(home, 'runs'));
      expect(runId).toBeTruthy();

      const human = await loops(['records', runId!, '--kind', 'revision-routed'], dir, env);
      expect(human.code).toBe(0);
      expect(human.out).toMatch(/revision routed dag:kickback accepted -> engineering/);

      const json = await loops(['records', runId!, '--kind', 'revision', '--json'], dir, env);
      expect(json.code).toBe(0);
      const kinds = json.out
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds).toContain('revision-emitted');
      expect(kinds).toContain('revision-routed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('contracted-agent example validates, describes contracts, and runs offline', async () => {
    const example = join(repoRoot, 'examples', 'contracted-agent.loop.ts');
    const home = mkdtempSync(join(tmpdir(), 'loops-contracted-example-'));
    try {
      const env = { LOOPS_HOME: home };

      const validate = await loops(['validate', example, '--json'], repoRoot, env);
      expect(validate.code).toBe(0);

      const describe = await loops(['describe', example, '--json'], repoRoot, env);
      expect(describe.code).toBe(0);
      const shape = JSON.parse(describe.out) as {
        nodes: Array<{ name: string; job?: { kind: string; contract?: { outputs?: string[] } } }>;
      };
      expect(shape.nodes.find((n) => n.name === 'implementation-contract')?.job).toMatchObject({
        kind: 'agent',
        contract: { outputs: ['patch', 'test-report'] },
      });

      const runResult = await loops(['run', example, '--no-tui', '--supervise'], repoRoot, env);
      expect(runResult.code).toBe(0);
      const [runId] = readdirSync(join(home, 'runs'));
      expect(runId).toBeTruthy();

      const records = await loops(['records', runId!, '--kind', 'revision', '--json'], repoRoot, env);
      expect(records.code).toBe(0);
      const kinds = records.out
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds).toContain('revision-emitted');
      expect(kinds).toContain('revision-routed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('validate fails with an agent-grade error on a broken recipe', async () => {
    const broken = join(dir, 'broken.loop.ts');
    writeFileSync(broken, 'export default loop({\n'); // unclosed, undefined `loop`
    const { code, out } = await loops(['validate', broken], dir);
    expect(code).toBe(1);
    expect(out).toMatch(/failed to load loop file/i);
  }, 30_000);
});
