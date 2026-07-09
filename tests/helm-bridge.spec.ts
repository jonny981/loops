import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HelmBridge } from '../src/helm/bridge.ts';
import {
  apiSpecifier,
  prepareEvalWorkspace,
} from '../src/helm/eval.ts';
import { readRunStatus } from '../src/runtime/supervisor.ts';

const DISPATCH_TIMEOUT = 90_000;

let workspace: string;
let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'helm-ws-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'helm-home-')));
  savedHome = process.env.LOOPS_HOME;
  process.env.LOOPS_HOME = home;
  prepareEvalWorkspace(workspace);
});

afterAll(async () => {
  // Dispatched runs are detached processes; let them finish before rm-ing HOME.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { listRuns } = await import('../src/runtime/supervisor.ts');
    if (!listRuns().some((r) => r.status === 'running' && r.alive)) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  if (savedHome === undefined) delete process.env.LOOPS_HOME;
  else process.env.LOOPS_HOME = savedHome;
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function bridge(): HelmBridge {
  return new HelmBridge({
    cwd: workspace,
    env: { LOOPS_HOME: home },
  });
}

async function waitForTerminal(runId: string, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const status = readRunStatus(runId);
    if (status && status.status !== 'running') return status.status;
    if (Date.now() > deadline) {
      return status ? `${status.status} (timed out)` : 'unknown (timed out)';
    }
    await new Promise((res) => setTimeout(res, 200));
  }
}

describe('path containment', () => {
  it('refuses absolute paths and workspace escapes', async () => {
    const b = bridge();
    const absolute = await b.execute({
      action: 'validate',
      file: '/etc/passwd.loop.ts',
    });
    expect(absolute.ok).toBe(false);
    expect(absolute.summary).toContain('relative');
    const escape = await b.execute({
      action: 'author',
      file: '../outside.loop.ts',
      source: 'x',
    });
    expect(escape.ok).toBe(false);
    expect(escape.summary).toContain('escapes');
  });

  it('requires the .loop.ts suffix for authored recipes', async () => {
    const result = await bridge().execute({
      action: 'author',
      file: 'notes.md',
      source: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('*.loop.ts');
  });
});

describe('author + validate', () => {
  it(
    'authors a valid recipe and reports that it loads',
    { timeout: DISPATCH_TIMEOUT },
    async () => {
      const b = bridge();
      const source = [
        `import { defineJob, loop, fnJob, predicate } from '${apiSpecifier()}';`,
        'let n = 0;',
        'export default defineJob(loop({',
        "  name: 'authored',",
        '  max: 3,',
        "  body: fnJob('tick', async () => { n += 1; return { status: n >= 1 ? 'pass' : 'fail' }; }),",
        "  until: predicate(() => n >= 1, 'one tick'),",
        '}));',
      ].join('\n');
      const authored = await b.execute({
        action: 'author',
        file: 'authored.loop.ts',
        source,
      });
      expect(authored.detail).toBeTruthy();
      expect(authored.ok).toBe(true);
      expect(authored.summary).toContain('it loads');

      // Re-authoring a file this session wrote is allowed.
      const again = await b.execute({
        action: 'author',
        file: 'authored.loop.ts',
        source,
      });
      expect(again.ok).toBe(true);
    },
  );

  it(
    'surfaces a fix-oriented error for a broken recipe',
    { timeout: DISPATCH_TIMEOUT },
    async () => {
      const result = await bridge().execute({
        action: 'author',
        file: 'broken.loop.ts',
        source: 'export default 42;',
      });
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('does not load');
      expect(result.detail).toMatch(/default export|Job/);
    },
  );

  it('refuses to overwrite a file it did not author', async () => {
    const path = join(workspace, 'preexisting.loop.ts');
    writeFileSync(path, '// somebody else wrote this\n');
    const result = await bridge().execute({
      action: 'author',
      file: 'preexisting.loop.ts',
      source: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('refusing to overwrite');
  });
});

describe('dispatch, observe, records', () => {
  it(
    'dispatches a supervised run and reads it back',
    { timeout: DISPATCH_TIMEOUT },
    async () => {
      const b = bridge();
      const dispatched = await b.execute({ action: 'run', file: 'fix.loop.ts' });
      expect(dispatched.ok).toBe(true);
      expect(dispatched.runId).toBeTruthy();
      expect(b.dispatched()).toBe(1);

      const runId = dispatched.runId!;
      const terminal = await waitForTerminal(runId, DISPATCH_TIMEOUT - 10_000);
      expect(terminal).toBe('pass');

      const status = await b.execute({ action: 'status', runId });
      expect(status.ok).toBe(true);
      expect(status.summary).toContain(runId);
      expect(status.summary).toContain('pass');

      const registry = await b.execute({ action: 'status' });
      expect(registry.ok).toBe(true);
      expect(registry.detail).toContain(runId);

      const records = await b.execute({ action: 'records', runId });
      expect(records.ok).toBe(true);
      expect(records.detail).toContain('completion');
    },
  );

  it('reports an unknown run honestly', async () => {
    const b = bridge();
    const status = await b.execute({ action: 'status', runId: 'nope-000000' });
    expect(status.ok).toBe(false);
    const stop = await b.execute({ action: 'stop_run', runId: 'nope-000000' });
    expect(stop.ok).toBe(false);
    const ack = await b.execute({
      action: 'ack',
      runId: 'nope-000000',
      gate: 'deploy',
    });
    expect(ack.ok).toBe(false);
    expect(ack.summary).toContain('only a run dispatched in this session');
  });

  it('enforces the run governor', async () => {
    const b = new HelmBridge({
      cwd: workspace,
      env: { LOOPS_HOME: home },
      maxRuns: 0,
    });
    const result = await b.execute({ action: 'run', file: 'fix.loop.ts' });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('run budget spent');
  });
});
