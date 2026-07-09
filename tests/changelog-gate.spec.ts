import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const gate = join(repoRoot, 'scripts', 'changelog-gate.mjs');

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'changelog-gate-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(pkgVersion: string, changelog: string | undefined): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: pkgVersion }));
  if (changelog !== undefined) writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  else rmSync(join(dir, 'CHANGELOG.md'), { force: true });
}

async function runGate(env?: Record<string, string>) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [gate], {
      cwd: dir,
      env: { ...process.env, GITHUB_REF_NAME: '', ...env },
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

const DOCUMENTED = `# Changelog

## [Unreleased]

## [1.2.3] — 2026-07-09

### Added

- a thing that changed
`;

describe('the changelog gate', () => {
  it('passes a documented version', async () => {
    fixture('1.2.3', DOCUMENTED);
    const result = await runGate();
    expect(result.out).toContain('1.2.3 is documented');
    expect(result.code).toBe(0);
  });

  it('fails a version with no heading, pointing at the Unreleased ritual', async () => {
    fixture('1.3.0', DOCUMENTED);
    const result = await runGate();
    expect(result.code).toBe(1);
    expect(result.out).toContain('no "## [1.3.0]" heading');
    expect(result.out).toContain('Unreleased');
  });

  it('fails an empty section — a heading alone documents nothing', async () => {
    fixture(
      '1.2.3',
      '# Changelog\n\n## [1.2.3] — 2026-07-09\n\n### Added\n\n## [1.2.2]\n\n- old\n',
    );
    const result = await runGate();
    expect(result.code).toBe(1);
    expect(result.out).toContain('section is empty');
  });

  it('fails a missing CHANGELOG.md', async () => {
    fixture('1.2.3', undefined);
    const result = await runGate();
    expect(result.code).toBe(1);
    expect(result.out).toContain('CHANGELOG.md is missing');
  });

  it('fails a tag that does not match package.json', async () => {
    fixture('1.2.3', DOCUMENTED);
    const result = await runGate({ GITHUB_REF_NAME: 'v1.2.4' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('tag v1.2.4 does not match');
  });

  it('passes a matching tag, and ignores non-version refs', async () => {
    fixture('1.2.3', DOCUMENTED);
    expect((await runGate({ GITHUB_REF_NAME: 'v1.2.3' })).code).toBe(0);
    expect((await runGate({ GITHUB_REF_NAME: 'main' })).code).toBe(0);
  });

  it('passes against this repo as it stands (the self-test)', async () => {
    try {
      const { stdout } = await exec(process.execPath, [gate], { cwd: repoRoot });
      expect(stdout).toContain('is documented');
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(
        `the gate fails on the repo itself: ${err.stderr ?? err.stdout ?? String(e)}`,
      );
    }
  });
});
