import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockEngine } from '../src/engines/mock.ts';
import { HelmBridge } from '../src/helm/bridge.ts';
import { HelmSession, type HelmEvent } from '../src/helm/session.ts';
import { oracleEngine } from '../src/helm/oracle.ts';
import { apiSpecifier, prepareEvalWorkspace } from '../src/helm/eval.ts';

const DISPATCH_TIMEOUT = 90_000;

let workspace: string;
let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'helm-sess-ws-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'helm-sess-home-')));
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
  return new HelmBridge({ cwd: workspace, env: { LOOPS_HOME: home } });
}

async function collect(
  session: HelmSession,
  message: string,
): Promise<HelmEvent[]> {
  const events: HelmEvent[] = [];
  for await (const event of session.send(message)) events.push(event);
  return events;
}

function endReason(events: HelmEvent[]): string | undefined {
  const end = events.find((e) => e.kind === 'turn-end');
  return end?.kind === 'turn-end' ? end.reason : undefined;
}

describe('the helm turn loop', () => {
  it('answers a question in one step and persists the transcript', async () => {
    const session = new HelmSession({
      bridge: bridge(),
      engine: new MockEngine(() =>
        JSON.stringify({ action: 'answer', say: 'Gates make done mean converged.' }),
      ),
      home,
    });
    const events = await collect(session, 'What is a gate?');
    expect(events.map((e) => e.kind)).toContain('say');
    expect(endReason(events)).toBe('answered');

    const transcriptPath = join(home, 'helm', session.sessionId, 'transcript.jsonl');
    expect(existsSync(transcriptPath)).toBe(true);
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2); // the user message + the helm intent
  });

  it('repairs one invalid reply, then ends unproductive on the second', async () => {
    let calls = 0;
    const prompts: string[] = [];
    const session = new HelmSession({
      bridge: bridge(),
      engine: new MockEngine((req) => {
        prompts.push(req.prompt);
        calls += 1;
        return 'I am not sure how to respond to that.';
      }),
      home,
    });
    const events = await collect(session, 'hello?');
    const invalids = events.filter((e) => e.kind === 'invalid');
    expect(invalids.length).toBe(2);
    expect(invalids[0]).toMatchObject({ willRetry: true });
    expect(invalids[1]).toMatchObject({ willRetry: false });
    expect(endReason(events)).toBe('unproductive');
    expect(calls).toBe(2);
    // The second prompt carries the harness repair note.
    expect(prompts[1]).toContain('(harness) Your last reply was not a valid intent');
  });

  it('recovers when the repair lands', async () => {
    let calls = 0;
    const session = new HelmSession({
      bridge: bridge(),
      engine: new MockEngine(() => {
        calls += 1;
        return calls === 1
          ? 'no JSON here'
          : JSON.stringify({ action: 'answer', say: 'fixed' });
      }),
      home,
    });
    const events = await collect(session, 'hello?');
    expect(endReason(events)).toBe('answered');
    expect(events.filter((e) => e.kind === 'invalid').length).toBe(1);
  });

  it('states the step budget in-context every step', async () => {
    const prompts: string[] = [];
    const session = new HelmSession({
      bridge: bridge(),
      engine: new MockEngine((req) => {
        prompts.push(req.prompt);
        return JSON.stringify({ action: 'validate', file: 'missing.loop.ts' });
      }),
      home,
      maxSteps: 2,
    });
    const events = await collect(session, 'check missing.loop.ts twice');
    expect(endReason(events)).toBe('steps');
    expect(prompts[0]).toContain('step 1 of 2');
    expect(prompts[1]).toContain('step 2 of 2');
    // The failed observation is fed back to the driver.
    expect(prompts[1]).toContain('FAILED validate');
  });

  it(
    'ends the turn at a dispatch (fire-and-poll), driven by the oracle',
    { timeout: DISPATCH_TIMEOUT },
    async () => {
      const session = new HelmSession({
        bridge: bridge(),
        engine: oracleEngine({ authorImport: apiSpecifier() }),
        home,
      });
      const events = await collect(session, 'Start fix.loop.ts in the background.');
      expect(endReason(events)).toBe('dispatched');
      const observation = events.find((e) => e.kind === 'observation');
      expect(observation?.kind === 'observation' && observation.observation.ok).toBe(
        true,
      );
      const runId =
        observation?.kind === 'observation'
          ? observation.observation.runId
          : undefined;
      expect(runId).toBeTruthy();

      // A follow-up turn observes the dispatched run through the same session.
      const followUp = await collect(session, `How is run ${runId} doing?`);
      expect(endReason(followUp)).toBe('answered');
      const statusObs = followUp.find((e) => e.kind === 'observation');
      expect(
        statusObs?.kind === 'observation' && statusObs.observation.summary,
      ).toContain(runId!);
    },
  );

  it('aborts cleanly mid-turn', async () => {
    const controller = new AbortController();
    const session = new HelmSession({
      bridge: bridge(),
      engine: new MockEngine(() => {
        controller.abort();
        return JSON.stringify({ action: 'validate', file: 'missing.loop.ts' });
      }),
      home,
    });
    const events: HelmEvent[] = [];
    for await (const event of session.send('slow work', controller.signal)) {
      events.push(event);
    }
    expect(endReason(events)).toBe('aborted');
  });
});
