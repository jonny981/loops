/**
 * The driver eval: which models can drive loops through the helm contract?
 * Each driver sees each case as a single fresh-context turn (the same
 * composed prompt shape the session uses), the reply is scored
 * deterministically (`score.ts`), and must-execute cases run the intent
 * through a real bridge in the eval workspace. Every attempt is appended to a
 * JSONL ledger so results accumulate across invocations.
 *
 * The offline oracle (`oracle.ts`) is the control ceiling: it must score 1.0,
 * or the harness itself is broken. Real drivers plug in as `DriverSpec`s over
 * any registered engine.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineRef, Usage } from '../engines/engine.ts';
import { EngineRegistry } from '../engines/registry.ts';
import { HelmBridge, type HelmBridgeOptions } from './bridge.ts';
import { helmSystemPrompt } from './system.ts';
import {
  assessReply,
  compositeScore,
  type AttemptDims,
  type TaskCase,
} from './score.ts';

/** The loops API specifier recipes in the eval workspace import: this
 *  checkout's source (or built dist) when available, the package otherwise. */
export function apiSpecifier(): string {
  for (const rel of ['../api.ts', '../api.js']) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url.href;
  }
  return '@loops-adk/core';
}

/**
 * The battery. Balanced across the contract: answer (twice — the cost thesis
 * says trivia must NOT dispatch), authoring, pre-flight, dispatch, the three
 * observation reads, the human-gate resume, the abort, and the wrap-up.
 */
export const DRIVER_BATTERY: TaskCase[] = [
  {
    id: 'trivia-concept',
    prompt: 'What does the until gate do in a loop recipe?',
    expected: 'answer',
    notes: 'a question must not dispatch a run',
  },
  {
    id: 'trivia-quick',
    prompt: "Quick sanity check: what's 2 + 2?",
    expected: 'answer',
  },
  {
    id: 'author-recipe',
    prompt:
      'Write a recipe file named fix-tests.loop.ts that keeps working until npm test passes.',
    expected: 'author',
    mustExecute: true,
    notes: 'the authored recipe must actually load',
  },
  {
    id: 'preflight-recipe',
    prompt: 'Check whether fix.loop.ts is valid before we spend anything.',
    expected: 'validate',
    mustExecute: true,
  },
  {
    id: 'dispatch-run',
    prompt: 'Start fix.loop.ts in the background.',
    expected: 'run',
    mustExecute: true,
    notes: 'dispatch must register a supervised run',
  },
  {
    id: 'poll-status',
    prompt: 'How is run fix-a1b2c3 doing?',
    expected: 'status',
  },
  {
    id: 'read-records',
    prompt: 'Show me the revision decisions from run fix-a1b2c3.',
    expected: 'records',
  },
  {
    id: 'lift-gate',
    prompt: 'I approve the deploy gate on run fix-a1b2c3 — lift it.',
    expected: 'ack',
    notes: 'human approval is explicit in the message',
  },
  {
    id: 'abort-run',
    prompt: "Kill run fix-a1b2c3, it's off the rails.",
    expected: 'stop_run',
  },
  {
    id: 'wrap-up',
    prompt: "That's everything, nothing left to do.",
    expected: 'done',
  },
];

export interface DriverSpec {
  name: string;
  engine: EngineRef;
  model?: string;
}

export interface EvalAttempt {
  ts: number;
  driver: string;
  caseId: string;
  expected: TaskCase['expected'];
  got?: string;
  dims: AttemptDims;
  score: number;
  usage?: Usage;
  latencyMs: number;
  error?: string;
}

export interface DriverSummary {
  driver: string;
  cases: number;
  avgScore: number;
  jsonValid: number;
  schemaValid: number;
  actionCorrect: number;
  executedOk: number;
  mustExecute: number;
  tokensIn: number;
  tokensOut: number;
}

export interface EvalReport {
  attempts: EvalAttempt[];
  summaries: DriverSummary[];
}

export interface EvalOptions {
  /** The eval workspace (prepare it with `prepareEvalWorkspace`). */
  cwd: string;
  cases?: TaskCase[];
  registry?: EngineRegistry;
  /** Import specifier the system prompt advertises for authored recipes. */
  authorImport?: string;
  /** Append every attempt here; default `<cwd>/.loops/helm-eval.jsonl`. */
  ledgerPath?: string;
  /** Bridge options for must-execute cases (env, runArgs, timeouts). */
  bridge?: Partial<HelmBridgeOptions>;
}

/** Seed a workspace the battery's must-execute cases can run in: an ES module
 *  scope plus `fix.loop.ts`, a two-tick deterministic recipe (no engine). */
export function prepareEvalWorkspace(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) {
    writeFileSync(pkg, `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
  }
  const recipe = join(dir, 'fix.loop.ts');
  if (!existsSync(recipe)) {
    writeFileSync(
      recipe,
      [
        `import { defineJob, loop, fnJob, predicate } from '${apiSpecifier()}';`,
        'let ticks = 0;',
        'export default defineJob(loop({',
        "  name: 'fix',",
        '  max: 5,',
        "  body: fnJob('tick', async () => {",
        '    ticks += 1;',
        "    return { status: ticks >= 2 ? 'pass' : 'fail', summary: `tick ${ticks}` };",
        '  }),',
        "  until: predicate(() => ticks >= 2, 'two ticks'),",
        '}));',
        '',
      ].join('\n'),
    );
  }
}

/** The single-turn prompt a case composes: the same shape the session uses. */
export function evalPrompt(taskCase: TaskCase): string {
  return [
    'TRANSCRIPT',
    `user › ${taskCase.prompt}`,
    '',
    'HARNESS: step 1 of 1 this turn; runs dispatched: 0.',
    'Reply with exactly one intent JSON object.',
  ].join('\n');
}

export async function evalDrivers(
  drivers: DriverSpec[],
  opts: EvalOptions,
): Promise<EvalReport> {
  const cases = opts.cases ?? DRIVER_BATTERY;
  const registry = opts.registry ?? new EngineRegistry();
  const system = helmSystemPrompt({ authorImport: opts.authorImport });
  const ledgerPath =
    opts.ledgerPath ?? join(opts.cwd, '.loops', 'helm-eval.jsonl');
  const attempts: EvalAttempt[] = [];

  for (const driver of drivers) {
    // One bridge per driver: authored files and the run governor are the
    // driver's own, and a prior driver's dispatches never mask a failure.
    const bridge = new HelmBridge({ cwd: opts.cwd, ...opts.bridge });
    const engine = registry.create(driver.engine, 'claude-cli');
    for (const taskCase of cases) {
      const started = Date.now();
      let usage: Usage | undefined;
      let attempt: EvalAttempt;
      try {
        const result = await engine.run(
          {
            prompt: evalPrompt(taskCase),
            system,
            model: driver.model,
            leaf: true,
          },
          (event) => {
            if (event.type === 'usage') usage = event.usage;
          },
          new AbortController().signal,
        );
        const assessment = assessReply(taskCase, result.text);
        const dims = { ...assessment.dims };
        if (taskCase.mustExecute && assessment.intent && dims.actionCorrect) {
          const observation = await bridge.execute(assessment.intent);
          dims.executedOk = observation.ok;
        } else if (taskCase.mustExecute) {
          dims.executedOk = false;
        }
        attempt = {
          ts: started,
          driver: driver.name,
          caseId: taskCase.id,
          expected: taskCase.expected,
          got: assessment.intent?.action,
          dims,
          score: compositeScore(dims, taskCase),
          usage,
          latencyMs: Date.now() - started,
          error: assessment.error,
        };
      } catch (e) {
        attempt = {
          ts: started,
          driver: driver.name,
          caseId: taskCase.id,
          expected: taskCase.expected,
          dims: { jsonValid: false, schemaValid: false, actionCorrect: false },
          score: 0,
          usage,
          latencyMs: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      attempts.push(attempt);
      try {
        mkdirSync(dirname(ledgerPath), { recursive: true });
        appendFileSync(ledgerPath, `${JSON.stringify(attempt)}\n`);
      } catch {
        /* best-effort ledger */
      }
    }
  }

  return { attempts, summaries: summarize(attempts, cases) };
}

function summarize(
  attempts: EvalAttempt[],
  cases: TaskCase[],
): DriverSummary[] {
  const mustExecute = cases.filter((c) => c.mustExecute).length;
  const byDriver = new Map<string, EvalAttempt[]>();
  for (const attempt of attempts) {
    const list = byDriver.get(attempt.driver) ?? [];
    list.push(attempt);
    byDriver.set(attempt.driver, list);
  }
  const summaries: DriverSummary[] = [];
  for (const [driver, list] of byDriver) {
    summaries.push({
      driver,
      cases: list.length,
      avgScore: Number(
        (list.reduce((s, a) => s + a.score, 0) / list.length).toFixed(4),
      ),
      jsonValid: list.filter((a) => a.dims.jsonValid).length,
      schemaValid: list.filter((a) => a.dims.schemaValid).length,
      actionCorrect: list.filter((a) => a.dims.actionCorrect).length,
      executedOk: list.filter((a) => a.dims.executedOk).length,
      mustExecute,
      tokensIn: list.reduce((s, a) => s + (a.usage?.inputTokens ?? 0), 0),
      tokensOut: list.reduce((s, a) => s + (a.usage?.outputTokens ?? 0), 0),
    });
  }
  return summaries.sort((a, b) => b.avgScore - a.avgScore);
}

/** A compact table for terminals and commit bodies. */
export function renderEvalReport(report: EvalReport): string {
  const lines = [
    'driver                        score  json  schema  action  exec  tok in/out',
  ];
  for (const s of report.summaries) {
    lines.push(
      `${s.driver.padEnd(28)}  ${s.avgScore.toFixed(2)}  ${String(s.jsonValid).padStart(4)}  ${String(s.schemaValid).padStart(6)}  ${String(s.actionCorrect).padStart(6)}  ${String(s.executedOk).padStart(4)}/${s.mustExecute}  ${s.tokensIn}/${s.tokensOut}`,
    );
  }
  return lines.join('\n');
}
