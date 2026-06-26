/**
 * Tier-0 harness contract. The SWE-bench regression hunt cost hours to a confound an
 * offline check catches in seconds: a sequence-nested agentJob saw `iteration === 0`
 * every pass (so a retry prompt said "Attempt 0"), and the question of whether
 * attempt 2 is actually grounded on attempt 1's reasoning could only be answered with
 * a live run. These tests pin both contracts so they cannot silently regress.
 */

import { describe, it, expect, afterAll } from 'vitest';

import { run, loop, sequence, agentJob } from '../src/api.ts';
import { MockEngine } from '../src/api.ts';
import { tmpRepo, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

describe('harness contract (Tier-0)', () => {
  it('a sequence-nested agentJob in a loop sees the real 1-based attempt, never 0', async () => {
    const repo = await tmpRepo();
    const prompts: string[] = [];
    const engine = new MockEngine((req) => {
      prompts.push(req.prompt);
      return `did work on attempt ${/Attempt (\d+): continue/.exec(req.prompt)?.[1]}`;
    });

    // The exact bench shape: a loop wrapping a sequence whose agentJob retries. The
    // loop runs to max (the gate never passes) so we get a clean attempt-1, attempt-2.
    await run(
      loop({
        name: 'build',
        max: 2,
        until: () => false,
        body: sequence(
          'turn',
          agentJob({
            label: 'work',
            ground: true,
            prompt: (c) => `Attempt ${c.iteration}: continue.`,
          }),
        ),
      }),
      { engine: 'mock', engines: { mock: () => engine }, cwd: repo },
    );

    // Two agent turns, numbered 1 then 2 — never 0 (the confound).
    const attempts = prompts.map((p) => /Attempt (\d+): continue/.exec(p)?.[1]);
    expect(attempts).toEqual(['1', '2']);
  });

  it('attempt 2 is grounded on attempt 1\'s reasoning (the cross-attempt signal is intact)', async () => {
    const repo = await tmpRepo();
    const prompts: string[] = [];
    const engine = new MockEngine((req) => {
      prompts.push(req.prompt);
      const n = /Attempt (\d+): continue/.exec(req.prompt)?.[1];
      return `chose approach B on attempt ${n}`;
    });

    await run(
      loop({
        name: 'build',
        max: 2,
        until: () => false,
        body: sequence(
          'turn',
          agentJob({
            label: 'work',
            ground: true,
            prompt: (c) => `Attempt ${c.iteration}: continue.`,
          }),
        ),
      }),
      { engine: 'mock', engines: { mock: () => engine }, cwd: repo },
    );

    // Attempt 1's auto-captured reasoning must reach attempt 2's prompt as working
    // memory — the clean "what attempt 1 tried" signal, not lost to a reset.
    expect(prompts[1]).toContain('chose approach B on attempt 1');
    expect(prompts[1]).toContain('Working memory');
  });
});
