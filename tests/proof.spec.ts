import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  prove,
  run,
  runEvidenceIndexPath,
  runSemanticRecordsPath,
  MockEngine,
} from '../src/api.ts';
import type { LoopEvent, RunOptions, SemanticRunRecord } from '../src/api.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

let loopsHome: string | undefined;
let workspace: string | undefined;

afterEach(() => {
  if (loopsHome) rmSync(loopsHome, { recursive: true, force: true });
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  loopsHome = undefined;
  workspace = undefined;
  delete process.env.LOOPS_HOME;
});

describe('prove', () => {
  it('emits a proof event and carries the artifact on the outcome', async () => {
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      prove('canonical-api-snapshot', () => ({
        kind: 'json',
        title: 'Canonical API snapshot',
        data: { ok: true },
      })),
      { ...mockOpts, onEvent: (event) => events.push(event) },
    );

    expect(outcome.status).toBe('pass');
    expect(outcome.data).toEqual({
      proof: {
        kind: 'json',
        title: 'Canonical API snapshot',
        data: { ok: true },
      },
    });
    expect(events.map((event) => event.kind)).toEqual([
      'job:start',
      'proof',
      'job:end',
    ]);
  });

  it('fails invalid descriptors deterministically', async () => {
    const { outcome } = await run(
      prove('bad-proof', () => ({
        kind: 'json',
        path: 'proof.json',
        data: { also: 'present' },
      })),
      mockOpts,
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('exactly one of path or data');
  });

  it('rejects non-JSON proof data before supervision serializes it', async () => {
    const { outcome } = await run(
      prove('bad-data', () => ({
        kind: 'json',
        data: { n: BigInt(1) },
      }) as never),
      mockOpts,
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('JSON-serializable');
  });

  it('rejects non-plain object proof data', async () => {
    const { outcome } = await run(
      prove('bad-map', () => ({
        kind: 'json',
        data: new Map([['ok', true]]),
      }) as never),
      mockOpts,
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('JSON-serializable');
  });

  it('records proof events and writes a supervised evidence index', async () => {
    loopsHome = mkdtempSync(join(tmpdir(), 'loops-proof-home-'));
    workspace = mkdtempSync(join(tmpdir(), 'loops-proof-work-'));
    process.env.LOOPS_HOME = loopsHome;
    const record = join(loopsHome, 'run.jsonl');

    const result = await run(
      prove('html-proof', (ctx) => {
        mkdirSync(join(ctx.workspace.dir, 'proofs'), { recursive: true });
        writeFileSync(join(ctx.workspace.dir, 'proofs/html-proof.html'), '<p>ok</p>');
        return {
          kind: 'html',
          title: 'HTML proof',
          path: 'proofs/html-proof.html',
        };
      }),
      { ...mockOpts, cwd: workspace, recordTo: record, supervise: true },
    );

    expect(result.outcome.status).toBe('pass');
    expect(result.runId).toBeDefined();
    expect(readFileSync(record, 'utf8')).toContain('"kind":"proof"');

    const semantic = readFileSync(
      runSemanticRecordsPath(result.runId!),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SemanticRunRecord);
    expect(semantic.some((entry) => entry.kind === 'proof')).toBe(true);

    const indexPath = runEvidenceIndexPath(result.runId!);
    expect(existsSync(indexPath)).toBe(true);
    const html = readFileSync(indexPath, 'utf8');
    expect(html).toContain('HTML proof');
    expect(html).toContain('proofs/html-proof.html');
  });

  it('rejects path artifacts that do not exist', async () => {
    const { outcome } = await run(
      prove('missing-proof', () => ({
        kind: 'html',
        path: 'proofs/missing.html',
      })),
      mockOpts,
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('path does not exist');
  });
});
