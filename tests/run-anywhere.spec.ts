import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
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

const PARAM_RECIPE = `import { defineJob, defineParams, fnJob } from '${apiUrl}';

export const params = defineParams({
  oem: { type: 'string', required: true, help: 'OEM name' },
  device: { type: 'choice', choices: ['battery', 'inverter'], default: 'battery', help: 'Device type' },
  skip: { type: 'string[]', default: [], help: 'Stage to skip' },
  dryRun: { type: 'boolean', default: false, help: 'Dry run only' },
  repoRoot: { type: 'string', defaultFrom: 'gitRoot', help: 'Repository root' },
});

export default defineJob(
  fnJob('params', async (ctx) => ({
    status: 'pass',
    summary: JSON.stringify(ctx.params),
  })),
);
`;

describe('running a loop from outside the package tree', () => {
  let dir: string;

  beforeAll(() => {
    // An out-of-tree recipe in its own ES module scope (what a consumer repo has).
    dir = mkdtempSync(join(tmpdir(), 'loops-oot-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'recipe.loop.ts'), RECIPE);
    writeFileSync(join(dir, 'params.loop.ts'), PARAM_RECIPE);
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

  it('recipe-declared params appear in help and reach ctx.params', async () => {
    const recipe = join(dir, 'params.loop.ts');

    const help = await loops(['run', recipe, '--help'], dir);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--oem <value>');
    expect(help.out).toContain('--device <value>');
    expect(help.out).toContain('--skip <value>');
    expect(help.out).toContain('--dry-run');

    const runResult = await loops(
      [
        'run',
        recipe,
        '--no-tui',
        '--no-record',
        '--oem',
        'Sigenergy',
        '--device',
        'battery',
        '--skip',
        'go-live-chaos',
        '--skip',
        'docs',
        '--dry-run',
      ],
      dir,
    );
    expect(runResult.code).toBe(0);
    expect(runResult.out).toContain('"oem":"Sigenergy"');
    expect(runResult.out).toContain('"device":"battery"');
    expect(runResult.out).toContain('"skip":["go-live-chaos","docs"]');
    expect(runResult.out).toContain('"dryRun":true');
    expect(runResult.out).toContain(`"repoRoot":"${realpathSync(dir)}"`);
  }, 30_000);

  it('does not import recipe top-level code to render recipe-param help', async () => {
    const marker = join(dir, 'help-side-effect.txt');
    const recipe = join(dir, 'help-safe.loop.ts');
    writeFileSync(
      recipe,
      `import { defineJob, defineParams, fnJob } from '${apiUrl}';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'executed');
export const params = defineParams({ oem: { type: 'string', required: true, help: 'OEM name' } });
export default defineJob(fnJob('noop', async () => ({ status: 'pass' })));
`,
    );

    const help = await loops(['run', recipe, '--help'], dir);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--oem <value>');
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('keeps the invocation cwd as workspace while exposing git root as a param default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loops-cwd-root-'));
    const child = join(root, 'nested');
    mkdirSync(child);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(root, 'recipe.loop.ts'),
      `import { defineJob, defineParams, fnJob } from '${apiUrl}';
export const params = defineParams({ repoRoot: { type: 'string', defaultFrom: 'gitRoot' } });
export default defineJob(fnJob('cwd', async (ctx) => ({
  status: 'pass',
  summary: JSON.stringify({ workspace: ctx.workspace.dir, repoRoot: ctx.params.repoRoot }),
})));
`,
    );
    await exec('git', ['init'], { cwd: root });

    try {
      const result = await loops(
        ['run', '../recipe.loop.ts', '--no-tui', '--no-record'],
        child,
      );
      expect(result.code).toBe(0);
      expect(result.out).toContain(`"workspace":"${realpathSync(child)}"`);
      expect(result.out).toContain(`"repoRoot":"${realpathSync(root)}"`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects unknown run flags after recipe params are registered', async () => {
    const result = await loops(
      [
        'run',
        join(dir, 'params.loop.ts'),
        '--no-tui',
        '--no-record',
        '--oem',
        'Sigenergy',
        '--chekpoint',
        'typo.json',
      ],
      dir,
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain("unknown option '--chekpoint'");
  }, 30_000);

  it('loads config/profile defaults and lets CLI override the record path', async () => {
    const recipe = join(dir, 'params.loop.ts');
    const home = mkdtempSync(join(tmpdir(), 'loops-config-runs-'));
    const record = join(dir, 'explicit-record.jsonl');
    writeFileSync(
      join(dir, 'loops.config.ts'),
      `import { defineConfig } from '${apiUrl}';
export default defineConfig({
  run: { tui: false, record: false },
  profiles: { observed: { run: { supervise: true } } },
});
`,
    );
    try {
      const env = { LOOPS_HOME: home };
      const runResult = await loops(
        [
          'run',
          recipe,
          '--profile',
          'observed',
          '--record',
          record,
          '--oem',
          'Sigenergy',
        ],
        dir,
        env,
      );
      expect(runResult.code).toBe(0);
      expect(readdirSync(join(home, 'runs'))).toHaveLength(1);
      expect(existsSync(record)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('lets CLI --resume continue checkpointing to the resume path over a config default', async () => {
    const recipe = join(dir, 'params.loop.ts');
    const config = join(dir, 'resume-precedence.config.ts');
    const resume = join(dir, 'resume.ckpt.json');
    const configured = join(dir, 'configured.ckpt.json');
    writeFileSync(
      resume,
      JSON.stringify({ state: {}, dags: {} }),
    );
    writeFileSync(
      config,
      `export default { run: { checkpoint: ${JSON.stringify(configured)}, tui: false, record: false } };
`,
    );

    const result = await loops(
      [
        'run',
        recipe,
        '--config',
        config,
        '--resume',
        resume,
        '--oem',
        'Sigenergy',
      ],
      dir,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(resume, 'utf8'))).toHaveProperty('ts');
    expect(existsSync(configured)).toBe(false);
  }, 30_000);

  it('fails fast on unknown config keys', async () => {
    const recipe = join(dir, 'params.loop.ts');
    const badConfig = join(dir, 'bad-loops.config.ts');
    writeFileSync(
      badConfig,
      `export default { run: { unknownKey: true } };
`,
    );
    const result = await loops(
      ['run', recipe, '--config', badConfig, '--oem', 'Sigenergy'],
      dir,
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain('unknown run key "unknownKey"');
  }, 30_000);

  it('resets scratch files on a fresh CLI run', async () => {
    const recipe = join(dir, 'params.loop.ts');
    mkdirSync(join(dir, '.loops'), { recursive: true });
    writeFileSync(join(dir, '.loops', 'ledger.md'), 'stale prior run');
    writeFileSync(join(dir, '.loops', 'prompt.md'), 'stale handoff');

    const runResult = await loops(
      ['run', recipe, '--no-tui', '--no-record', '--oem', 'Sigenergy'],
      dir,
    );
    expect(runResult.code).toBe(0);
    expect(existsSync(join(dir, '.loops', 'ledger.md'))).toBe(false);
    expect(existsSync(join(dir, '.loops', 'prompt.md'))).toBe(false);
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
