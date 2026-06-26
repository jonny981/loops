import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('node', [bin, ...args], { cwd });
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

  it('validate fails with an agent-grade error on a broken recipe', async () => {
    const broken = join(dir, 'broken.loop.ts');
    writeFileSync(broken, 'export default loop({\n'); // unclosed, undefined `loop`
    const { code, out } = await loops(['validate', broken], dir);
    expect(code).toBe(1);
    expect(out).toMatch(/failed to load loop file/i);
  }, 30_000);
});
