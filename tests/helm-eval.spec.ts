import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockEngine } from '../src/engines/mock.ts';
import {
  apiSpecifier,
  evalDrivers,
  prepareEvalWorkspace,
  renderEvalReport,
  DRIVER_BATTERY,
} from '../src/helm/eval.ts';
import { oracleEngine } from '../src/helm/oracle.ts';
import { listRuns } from '../src/runtime/supervisor.ts';

/** Dispatched runs are detached processes; let them finish before rm-ing HOME. */
async function drainRuns(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!listRuns().some((r) => r.status === 'running' && r.alive)) return;
    await new Promise((res) => setTimeout(res, 200));
  }
}

const EVAL_TIMEOUT = 120_000;

let workspace: string;
let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'helm-eval-ws-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'helm-eval-home-')));
  savedHome = process.env.LOOPS_HOME;
  process.env.LOOPS_HOME = home;
  prepareEvalWorkspace(workspace);
});

afterAll(async () => {
  await drainRuns(30_000);
  if (savedHome === undefined) delete process.env.LOOPS_HOME;
  else process.env.LOOPS_HOME = savedHome;
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('the driver eval', () => {
  it(
    'scores the offline oracle at the 1.0 control ceiling',
    { timeout: EVAL_TIMEOUT },
    async () => {
      const ledgerPath = join(workspace, '.loops', 'helm-eval.jsonl');
      const report = await evalDrivers(
        [{ name: 'oracle', engine: oracleEngine({ authorImport: apiSpecifier() }) }],
        {
          cwd: workspace,
          authorImport: apiSpecifier(),
          ledgerPath,
          bridge: { env: { LOOPS_HOME: home } },
        },
      );

      expect(report.attempts.length).toBe(DRIVER_BATTERY.length);
      const summary = report.summaries[0]!;
      expect(summary.driver).toBe('oracle');
      // The oracle is the harness's own control: below 1.0 means the harness
      // (contract, parser, bridge, or scoring) broke, not a model.
      expect(summary.avgScore).toBe(1);
      expect(summary.executedOk).toBe(summary.mustExecute);

      // Every attempt landed in the append-only ledger.
      expect(existsSync(ledgerPath)).toBe(true);
      const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(DRIVER_BATTERY.length);

      const table = renderEvalReport(report);
      expect(table).toContain('oracle');
      expect(table).toContain('1.00');
    },
  );

  it('scores a driver that never emits JSON at zero', async () => {
    const report = await evalDrivers(
      [
        {
          name: 'prose-only',
          engine: new MockEngine(() => 'I would rather chat than emit JSON.'),
        },
      ],
      {
        cwd: workspace,
        cases: DRIVER_BATTERY.filter((c) => !c.mustExecute),
        ledgerPath: join(workspace, '.loops', 'prose-eval.jsonl'),
        bridge: { env: { LOOPS_HOME: home } },
      },
    );
    expect(report.summaries[0]!.avgScore).toBe(0);
    expect(report.summaries[0]!.jsonValid).toBe(0);
  });

  it('separates json-valid from schema-valid in the dims', async () => {
    const report = await evalDrivers(
      [
        {
          name: 'wrong-schema',
          engine: new MockEngine(() => '{"action":"deploy","target":"prod"}'),
        },
      ],
      {
        cwd: workspace,
        cases: DRIVER_BATTERY.filter((c) => !c.mustExecute),
        ledgerPath: join(workspace, '.loops', 'schema-eval.jsonl'),
        bridge: { env: { LOOPS_HOME: home } },
      },
    );
    const summary = report.summaries[0]!;
    expect(summary.jsonValid).toBeGreaterThan(0);
    expect(summary.schemaValid).toBe(0);
    expect(summary.avgScore).toBe(0.15);
  });
});
