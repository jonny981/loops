import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  agentJob,
  agentCheck,
  gateJob,
  defineAgent,
  defineSkill,
  agentContract,
  fromFile,
  resolveSystem,
  LoopError,
  MockEngine,
  stageAll,
  commit,
} from '../src/api.ts';
import type { Engine, RunOptions, AgentRequest } from '../src/api.ts';
import { requestEnv } from '../src/engines/engine.ts';
import { tmpRepo, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

/** A mock engine that records the request it was handed. */
function capturing(): { engine: MockEngine; req: () => AgentRequest } {
  let seen: AgentRequest | undefined;
  const engine = new MockEngine((r: AgentRequest) => {
    seen = r;
    return 'done';
  });
  return { engine, req: () => seen! };
}

describe('AgentDef', () => {
  it('validates name and system', () => {
    expect(() => defineAgent({ name: '', system: 'x' })).toThrow();
    expect(() => defineAgent({ name: 'a', system: '   ' })).toThrow();
    expect(defineAgent({ name: 'a', system: 'hi' }).name).toBe('a');
  });

  it('accepts optional contract metadata without changing the agent runtime shape', () => {
    const agent = defineAgent({
      name: 'implementer',
      system: 'Build the change.',
      tier: 'worker',
      capabilities: ['code.implementation'],
      outputs: [{ name: 'patch' }, { name: 'test-report' }],
      requiresSkills: ['tdd'],
      usesSkills: [defineSkill({ name: 'small-diff', instructions: 'Keep changes focused.' })],
      humanGates: [{ name: 'production-approval', when: 'deploying prod changes' }],
      failureModes: [
        {
          mode: 'over-scoping',
          recovery: 'Reduce the patch to the requested behaviour.',
          severity: 'should-fix',
        },
      ],
    });

    expect(agentContract(agent)).toEqual({
      tier: 'worker',
      capabilities: ['code.implementation'],
      outputs: ['patch', 'test-report'],
      requiresSkills: ['tdd'],
      usesSkills: ['small-diff'],
      humanGates: ['production-approval'],
      failureModes: ['over-scoping'],
    });
  });

  it('validates malformed contract metadata', () => {
    expect(() =>
      defineAgent({
        name: 'bad-output',
        system: 'x',
        outputs: [{ name: '' }],
      }),
    ).toThrow(/outputs/);
    expect(() =>
      defineAgent({
        name: 'bad-skill',
        system: 'x',
        requiresSkills: [''],
      }),
    ).toThrow(/empty skill/);
    expect(() =>
      defineAgent({
        name: 'bad-failure',
        system: 'x',
        failureModes: [{ mode: 'drift', recovery: '' }],
      }),
    ).toThrow(/recovery/);
  });

  it('reads system and skills from markdown files (fromFile), folding skills in', async () => {
    const repo = await tmpRepo();
    writeFileSync(join(repo, 'sys.md'), '# Store engineer\n\nBuild the storage engine.');
    writeFileSync(join(repo, 'tdd.md'), 'Write the failing test first.');

    const tdd = defineSkill({ name: 'tdd', instructions: fromFile(join(repo, 'tdd.md')) });
    const agent = defineAgent({
      name: 'store',
      system: fromFile(join(repo, 'sys.md')),
      skills: [tdd],
    });
    expect(agent.system).toContain('Build the storage engine.');

    const sys = resolveSystem(agent);
    expect(sys).toContain('Build the storage engine.');
    expect(sys).toContain('Methodologies you apply');
    expect(sys).toContain('Write the failing test first.');
  });

  it('agentJob takes system, model, tools and label from the agent def', async () => {
    const repo = await tmpRepo();
    const agent = defineAgent({
      name: 'reviewer',
      system: 'You review code.',
      model: 'haiku',
      tools: ['read'],
      skills: [defineSkill({ name: 'adversarial', instructions: 'Try to REFUTE it.' })],
    });
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(agentJob({ agent, prompt: 'review the PR' }), opts);

    const req = cap.req();
    expect(req.system).toContain('You review code.');
    expect(req.system).toContain('Try to REFUTE it.'); // skill folded into the system
    expect(req.model).toBe('haiku');
    expect(req.allowedTools).toEqual(['read']);
    expect(req.prompt).toBe('review the PR'); // the per-call task, not the persona
  });

  it('inline config overrides the agent def', async () => {
    const repo = await tmpRepo();
    const agent = defineAgent({ name: 'a', system: 'agent system', model: 'haiku' });
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(
      agentJob({ agent, prompt: 'go', system: 'override system', model: 'sonnet' }),
      opts,
    );
    const req = cap.req();
    expect(req.system).toBe('override system');
    expect(req.model).toBe('sonnet');
  });

  it('agentCheck takes a persona from an AgentDef, keeping the validator contract last', async () => {
    const repo = await tmpRepo();
    let seenSystem = '';
    let seenModel: string | undefined;
    const engine = new MockEngine((r: AgentRequest) => {
      seenSystem = r.system ?? '';
      seenModel = r.model;
      return JSON.stringify({ verdict: 'yes', confidence: 0.95, reason: 'ok' });
    });
    const reviewer = defineAgent({
      name: 'reviewer',
      system: 'You are an adversarial reviewer.',
      model: 'haiku',
      skills: [defineSkill({ name: 'refute', instructions: 'Try to REFUTE the claim.' })],
    });
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => engine }, cwd: repo };
    await run(gateJob('review', agentCheck({ agent: reviewer, question: 'Is it correct?' })), opts);

    expect(seenSystem).toContain('adversarial reviewer'); // persona
    expect(seenSystem).toContain('Try to REFUTE the claim.'); // skill folded in
    expect(seenSystem.indexOf('adversarial reviewer')).toBeLessThan(seenSystem.indexOf('JSON')); // validator contract comes last
    expect(seenModel).toBe('haiku'); // model falls back to the agent's
  });

  it('agentJob carries `leaf` from the agent def into the engine request', async () => {
    const repo = await tmpRepo();
    const leafAgent = defineAgent({ name: 'leafy', system: 'no fan-out', leaf: true });
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(agentJob({ agent: leafAgent, prompt: 'go' }), opts);
    expect(cap.req().leaf).toBe(true);
    // inline config can still set it directly
    const cap2 = capturing();
    await run(agentJob({ prompt: 'go', leaf: true }), {
      engine: 'mock',
      engines: { mock: () => cap2.engine },
      cwd: repo,
    });
    expect(cap2.req().leaf).toBe(true);
  });

  it('agentJob supplies Loops leaf metadata to every engine request', async () => {
    const repo = await tmpRepo();
    const cap = capturing();
    await run(agentJob({ label: 'leaf', prompt: 'go' }), {
      engine: 'mock',
      engines: { mock: () => cap.engine },
      cwd: repo,
    });
    expect(cap.req().loops).toMatchObject({
      leaf: true,
      leafId: 'leaf/0',
      path: [],
      label: 'leaf',
      iteration: 0,
    });
    expect(requestEnv(cap.req())).toMatchObject({
      LOOPS_LEAF: '1',
      LOOPS_LEAF_ID: 'leaf/0',
      LOOPS_LEAF_LABEL: 'leaf',
      LOOPS_LEAF_PATH: '',
      LOOPS_LEAF_ITERATION: '0',
    });
  });

  it('agentCheck supplies Loops leaf metadata to judge engine requests', async () => {
    const repo = await tmpRepo();
    let seen: AgentRequest | undefined;
    await run(gateJob('review', agentCheck({ question: 'Is it correct?' })), {
      engine: 'mock',
      engines: {
        mock: () =>
          new MockEngine((req) => {
            seen = req;
            return JSON.stringify({ verdict: 'yes', confidence: 1, reason: 'ok' });
          }),
      },
      cwd: repo,
    });
    expect(seen?.leaf).toBe(true);
    expect(requestEnv(seen!)).toMatchObject({
      LOOPS_LEAF: '1',
      LOOPS_LEAF_ID: 'agent-check/0',
      LOOPS_LEAF_LABEL: 'agent-check',
    });
  });

  it('agentJob spills provider-limit failures to a fallback route', async () => {
    const repo = await tmpRepo();
    const calls: string[] = [];
    const primary: Engine = {
      name: 'primary',
      async run() {
        calls.push('primary');
        throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
      },
    };
    const fallback = new MockEngine((req) => {
      calls.push(`fallback:${req.model ?? 'no-model'}`);
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'go',
        engine: 'primary',
        fallback: { engine: 'fallback', model: 'gpt-5.4-mini', ground: false },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('pass');
    expect(calls).toEqual(['primary', 'fallback:gpt-5.4-mini']);
  });

  it('retrieves fallback grounding with the fallback route engine and model', async () => {
    const repo = await tmpRepo();
    writeFileSync(join(repo, 'route.ts'), 'fallback context\n');
    await stageAll({ cwd: repo });
    await commit(
      {
        subject: 'feat: relevant route context',
        body: '## Why\n\nroute-aware retrieval should use the fallback engine',
      },
      { cwd: repo },
    );

    const calls: string[] = [];
    const primary: Engine = {
      name: 'primary',
      async run() {
        calls.push('primary');
        throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
      },
    };
    let workPrompt = '';
    const fallback = new MockEngine((req) => {
      if (/Return the shas relevant/i.test(req.prompt)) {
        calls.push(`select:${req.model ?? 'no-model'}`);
        return (
          req.prompt.match(/^([0-9a-f]{7,}): feat: relevant route context$/m)?.[1] ??
          'NONE'
        );
      }
      calls.push(`work:${req.model ?? 'no-model'}`);
      workPrompt = req.prompt;
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'Continue route-aware work.',
        engine: 'primary',
        ground: false,
        fallback: {
          engine: 'fallback',
          model: 'fallback-model',
          ground: { retrieve: true, recordInstruction: false },
        },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('pass');
    expect(calls).toEqual(['primary', 'select:fallback-model', 'work:fallback-model']);
    expect(workPrompt).toContain('retrieved for this task');
    expect(workPrompt).toContain('relevant route context');
  });

  it('spills to fallback when retrieval grounding hits a provider limit', async () => {
    const repo = await tmpRepo();
    writeFileSync(join(repo, 'route.ts'), 'fallback context\n');
    await stageAll({ cwd: repo });
    await commit(
      {
        subject: 'feat: relevant fallback retrieval',
        body: '## Why\n\nfallback retrieval should recover from primary limits',
      },
      { cwd: repo },
    );

    const calls: string[] = [];
    const primary: Engine = {
      name: 'primary',
      async run() {
        calls.push('primary');
        throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
      },
    };
    const fallback = new MockEngine((req) => {
      if (/Return the shas relevant/i.test(req.prompt)) {
        calls.push('fallback-select');
        return (
          req.prompt.match(
            /^([0-9a-f]{7,}): feat: relevant fallback retrieval$/m,
          )?.[1] ?? 'NONE'
        );
      }
      calls.push('fallback-work');
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'Continue fallback retrieval work.',
        engine: 'primary',
        ground: { retrieve: true, recordInstruction: false },
        fallback: { engine: 'fallback' },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('pass');
    expect(calls).toEqual(['primary', 'fallback-select', 'fallback-work']);
  });

  it('fallback routes without a model do not inherit the primary model', async () => {
    const repo = await tmpRepo();
    const primary: Engine = {
      name: 'primary',
      async run() {
        throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
      },
    };
    let fallbackModel: string | undefined;
    const fallback = new MockEngine((req) => {
      fallbackModel = req.model;
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'go',
        engine: 'primary',
        model: 'claude-sonnet-4-5',
        fallback: { engine: 'fallback' },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('pass');
    expect(fallbackModel).toBeUndefined();
  });

  it('agentJob does not spill non-provider failures to a fallback route', async () => {
    const repo = await tmpRepo();
    let fallbackCalls = 0;
    const primary: Engine = {
      name: 'primary',
      async run() {
        throw new LoopError({ code: 'CONFIG', message: 'bad config' });
      },
    };
    const fallback = new MockEngine(() => {
      fallbackCalls += 1;
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'go',
        engine: 'primary',
        fallback: { engine: 'fallback' },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('CONFIG');
    expect(fallbackCalls).toBe(0);
  });
});
