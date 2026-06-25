import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  agentJob,
  defineAgent,
  defineSkill,
  fromFile,
  resolveSystem,
  MockEngine,
} from '../src/api.ts';
import type { RunOptions, AgentRequest } from '../src/api.ts';
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
});
