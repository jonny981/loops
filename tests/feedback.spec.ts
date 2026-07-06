import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  loop,
  dag,
  agentJob,
  fnJob,
  commitJob,
  agentCheck,
  quorum,
  reviewPanel,
  reviewContext,
  revisionRequest,
  feedbackBlock,
  normalizeFeedbackSeverity,
  isRequiredFeedbackSeverity,
  appendLedger,
  LoopError,
  MockEngine,
} from '../src/api.ts';
import type { AgentRequest, Condition, RunOptions, Workspace } from '../src/api.ts';
import { cleanupRepos, tmpRepo, write } from './git-helpers.ts';

afterAll(cleanupRepos);

const ws = (dir: string): Workspace => ({ dir });

function capturing(
  responder: (req: AgentRequest) => string = () => 'done',
): { opts: RunOptions; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    opts: {
      engine: 'mock',
      engines: {
        mock: () =>
          new MockEngine((req) => {
            prompts.push(req.prompt);
            return responder(req);
          }),
      },
    },
  };
}

describe('feedback protocol', () => {
  it('agentJob consumeFeedback appends ctx.lastReview to the next agent prompt', async () => {
    const repo = await tmpRepo();
    const cap = capturing();
    let reviews = 0;

    const { outcome } = await run(
      loop({
        name: 'build',
        body: agentJob({
          label: 'implementation',
          prompt: 'Implement the parser.',
          consumeFeedback: true,
        }),
        review: fnJob('review', async () => {
          reviews += 1;
          return reviews === 1
            ? revisionRequest({
                reason: 'Parser still accepts empty duration strings.',
                findings: [
                  {
                    reviewer: 'correctness',
                    severity: 'blocking',
                    evidence: 'parseDuration("") returns 0',
                    recommendation: 'Reject empty input before unit parsing.',
                  },
                ],
              })
            : { status: 'pass', summary: 'approved' };
        }),
        max: 2,
      }),
      { ...cap.opts, cwd: repo },
    );

    expect(outcome.status).toBe('pass');
    expect(cap.prompts).toHaveLength(2);
    expect(cap.prompts[0]).toBe('Implement the parser.');
    expect(cap.prompts[1]).toContain('## Feedback to address');
    expect(cap.prompts[1]).toContain('Parser still accepts empty duration strings.');
    expect(cap.prompts[1]).toContain('correctness');
    expect(cap.prompts[1]).toContain('Reject empty input');
  });

  it('revisionRequest is the shared loop-review and dag-kickback feedback shape', async () => {
    const seen: string[] = [];
    let implementationFeedback: string | undefined;
    let reviewRuns = 0;

    const { outcome } = await run(
      dag({
        name: 'ship',
        maxKickbacks: 1,
        nodes: {
          implementation: fnJob('implementation', async (ctx) => {
            seen.push('implementation');
            implementationFeedback = ctx.lastReview?.revision?.reason;
            return { status: 'pass' };
          }),
          review: {
            needs: ['implementation'],
            job: fnJob('review', async () => {
              seen.push('review');
              reviewRuns += 1;
              return reviewRuns === 1
                ? revisionRequest({
                    target: 'implementation',
                    reason: 'The implementation misses cancellation handling.',
                    findings: [
                      {
                        reviewer: 'resilience',
                        severity: 'blocking',
                        evidence: 'AbortSignal is ignored.',
                      },
                    ],
                  })
                : { status: 'pass' };
            }),
          },
        },
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    expect(seen).toEqual(['implementation', 'review', 'implementation', 'review']);
    expect(implementationFeedback).toContain('cancellation handling');
  });

  it('reviewPanel aggregates reviewers into one structured outcome', async () => {
    const pass: Condition = async () => ({
      met: true,
      confidence: 0.95,
      reason: 'No issue found.',
    });
    const block: Condition = async () => ({
      met: false,
      confidence: 0.2,
      reason: 'The query path interpolates user input.',
    });
    const alsoBlock: Condition = async () => ({
      met: false,
      confidence: 0.6,
      reason: 'The helper name is vague.',
    });

    const { outcome } = await run(
      reviewPanel({
        label: 'review',
        reviewers: [
          { name: 'correctness', review: pass },
          { name: 'security', review: block },
          { name: 'simplicity', review: alsoBlock },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('1/3 reviewer(s) cleared');
    expect(outcome.revision?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewer: 'security', severity: 'block' }),
        expect.objectContaining({ reviewer: 'simplicity', severity: 'block' }),
      ]),
    );
    expect((outcome.data as { findings: unknown[] }).findings).toHaveLength(2);
  });

  it('classifies finding severities and gates on k-of-n over all reviewers', async () => {
    expect(normalizeFeedbackSeverity('blocking')).toBe('block');
    expect(normalizeFeedbackSeverity('advisory')).toBe('nice-to-have');
    expect(isRequiredFeedbackSeverity('should-fix')).toBe(true);
    expect(isRequiredFeedbackSeverity('nice-to-have')).toBe(false);

    const passing: Condition = async () => ({
      met: true,
      confidence: 0.9,
      reason: 'Looks good.',
    });
    const failing: Condition = async () => ({
      met: false,
      confidence: 0.7,
      reason: 'The retry path loses the original error.',
    });

    // Every reviewer gates; `pass: 2` clears when 2 of the 3 pass.
    const { outcome } = await run(
      reviewPanel({
        pass: 2,
        reviewers: [
          { name: 'correctness', review: passing },
          { name: 'security', review: passing },
          { name: 'simplicity', review: failing },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('2/3 reviewer(s) cleared');
    // A failing reviewer's finding is still surfaced, as a blocking finding.
    expect((outcome.data as { findings: unknown[] }).findings).toEqual([
      expect.objectContaining({ reviewer: 'simplicity', severity: 'block' }),
    ]);

    // An empty panel is a construction error, not a vacuous 0/0 pass.
    expect(() => reviewPanel({ reviewers: [] })).toThrow(/at least one reviewer/);
    expect(() =>
      reviewPanel({ pass: 0, reviewers: [{ name: 'a', review: passing }] }),
    ).toThrow(/pass must be an integer/);
    expect(() =>
      reviewPanel({ pass: 2, reviewers: [{ name: 'a', review: passing }] }),
    ).toThrow(/pass must be an integer/);
    expect(() =>
      reviewPanel({ pass: 1.5, reviewers: [{ name: 'a', review: passing }] }),
    ).toThrow(/pass must be an integer/);
  });

  it('caps reviewer fan-out, defaulting to four in flight', async () => {
    let active = 0;
    let peak = 0;
    const reviewer = (): Condition => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { met: true, reason: 'ok' };
    };

    const { outcome } = await run(
      reviewPanel({
        reviewers: Array.from({ length: 6 }, (_, i) => ({
          name: `r${i}`,
          review: reviewer(),
        })),
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('keeps engine errors out of review findings and pauses an all-error panel', async () => {
    const limit = new LoopError({
      code: 'RATE_LIMIT',
      phase: 'engine',
      message: 'provider throttled',
    });

    const { outcome } = await run(
      reviewPanel({
        reviewers: [
          {
            name: 'transport',
            job: fnJob('transport', async () => ({
              status: 'fail',
              summary: 'provider throttled',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('RATE_LIMIT');
    expect(outcome.revision?.findings).toBeUndefined();
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('keeps budget exhaustion out of review findings and pauses the panel', async () => {
    const { outcome } = await run(
      reviewPanel({
        reviewers: [
          {
            name: 'budget',
            review: async () => {
              throw new LoopError({
                code: 'BUDGET',
                phase: 'review',
                message: 'token budget exhausted',
              });
            },
          },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('BUDGET');
    expect(outcome.revision).toBeUndefined();
    expect((outcome.data as { findings: unknown[] }).findings).toHaveLength(0);
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('preserves quorum engine errors when they can change the verdict', async () => {
    const yes: Condition = async () => ({ met: true, reason: 'yes' });
    const limit: Condition = async () => {
      throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
    };

    const { outcome } = await run(
      reviewPanel({
        reviewers: [{ name: 'jury', review: quorum(2, yes, limit) }],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.revision).toBeUndefined();
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('can pass k-of-n while still reporting reviewer engine errors separately', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const limit = new LoopError({ code: 'QUOTA', message: 'usage limit' });

    const { outcome } = await run(
      reviewPanel({
        pass: 2,
        reviewers: [
          { name: 'a', review: pass },
          { name: 'b', review: pass },
          {
            name: 'quota',
            job: fnJob('quota', async () => ({
              status: 'fail',
              summary: 'usage limit',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    expect((outcome.data as { findings: unknown[] }).findings).toHaveLength(0);
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('pauses k-of-n when an infrastructure error could change the threshold', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const fail: Condition = async () => ({
      met: false,
      reason: 'the retry path loses the original error',
      output: 'Full deterministic finding: preserve original error cause.',
    });
    const limit = new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });

    const { outcome } = await run(
      reviewPanel({
        pass: 2,
        reviewers: [
          { name: 'a', review: pass },
          { name: 'b', review: fail },
          {
            name: 'transport',
            job: fnJob('transport', async () => ({
              status: 'fail',
              summary: 'throttled',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('RATE_LIMIT');
    expect(outcome.revision).toBeUndefined();
    const data = outcome.data as {
      findings: Array<{ evidence?: string }>;
      errors: unknown[];
    };
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]?.evidence).toContain(
      'Full deterministic finding',
    );
    expect(data.errors).toHaveLength(1);
  });

  it('preserves failing quorum output while pausing on infrastructure uncertainty', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const fail: Condition = async () => ({
      met: false,
      reason: 'short finding',
      output: 'Nested quorum finding: the migration drops retries.',
    });
    const limit: Condition = async () => {
      throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
    };

    const { outcome } = await run(
      reviewPanel({
        reviewers: [{ name: 'jury', review: quorum(2, pass, fail, limit) }],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('RATE_LIMIT');
    expect(outcome.revision).toBeUndefined();
    const data = outcome.data as {
      findings: Array<{ evidence?: string }>;
      errors: unknown[];
    };
    expect(data.findings).toEqual([
      expect.objectContaining({
        reviewer: 'jury',
        evidence: expect.stringContaining('Nested quorum finding'),
      }),
    ]);
    expect(data.errors).toHaveLength(1);
  });

  it('pauses default all panels when a required reviewer engine-errors', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const limit = new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });

    const { outcome } = await run(
      reviewPanel({
        reviewers: [
          { name: 'a', review: pass },
          {
            name: 'transport',
            job: fnJob('transport', async () => ({
              status: 'fail',
              summary: 'throttled',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    const data = outcome.data as { required: number; errors: unknown[] };
    expect(data.required).toBe(2);
    expect(data.errors).toHaveLength(1);
  });

  it('escalates out-of-scope findings instead of failing a scoped panel', async () => {
    const { outcome } = await run(
      reviewPanel({
        actionableScopes: ['connector'],
        reviewers: [
          {
            name: 'platform-review',
            job: fnJob('platform-review', async () =>
              revisionRequest({
                reason: 'Platform helper needs a separate wave.',
                findings: [
                  {
                    reviewer: 'platform-review',
                    severity: 'block',
                    scope: 'platform',
                    evidence: 'Shared manifest loader lacks validation.',
                  },
                ],
              }),
            ),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    const data = outcome.data as {
      findings: unknown[];
      escalatedFindings: Array<{ scope?: string; decision?: string }>;
    };
    expect(data.findings).toHaveLength(0);
    expect(data.escalatedFindings).toEqual([
      expect.objectContaining({ scope: 'platform', decision: 'escalated' }),
    ]);
  });

  it('renders caller decisions and canonical severity labels in feedback blocks', () => {
    const block = feedbackBlock(
      revisionRequest({
        reason: 'Tests are red.',
        decision: 'accepted',
        findings: [
          {
            reviewer: 'correctness',
            severity: 'should-fix',
            decision: 'deferred',
            evidence: 'The retry test fails on the second attempt.',
            recommendation: 'Preserve the original error across retries.',
          },
        ],
      }),
    );

    expect(block).toContain('Caller decision: accepted');
    expect(block).toContain('correctness [should-fix]');
    expect(block).toContain('Decision: deferred.');
    expect(block).toContain('Preserve the original error');
  });

  it('reviewContext provides diff, selected files, scratch ledger, and last outcome context', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    write(repo, 'src/a.ts', 'export const value = 1;\n');
    await run(
      commitJob({ subject: 'chore: add fixture' }),
      { engine: 'mock', engines: { mock: () => new MockEngine(() => '') }, cwd: repo },
    );
    appendLedger(ws(repo), 'Tried a Map cache; rejected it because keys were unstable.');
    write(repo, 'src/a.ts', 'export const value = 2;\n');

    const cap = capturing(() => JSON.stringify({ verdict: 'yes', confidence: 0.9, reason: 'ok' }));
    const { outcome } = await run(
      loop({
        name: 'review',
        body: fnJob('body', async () => ({
          status: 'pass',
          summary: 'Tests passed in the implementation step.',
        })),
        review: reviewPanel({
          reviewers: [
            {
              name: 'correctness',
              review: agentCheck({
                question: 'Is the change correct?',
                context: reviewContext({
                  diff: true,
                  files: ['src/a.ts'],
                  ledger: true,
                  tests: true,
                }),
              }),
            },
          ],
        }),
        max: 1,
      }),
      { ...cap.opts, cwd: repo },
    );

    expect(outcome.status).toBe('pass');
    const prompt = cap.prompts[0]!;
    expect(prompt).toContain('## Git diff');
    expect(prompt).toContain('-export const value = 1;');
    expect(prompt).toContain('+export const value = 2;');
    expect(prompt).toContain('## File: src/a.ts');
    expect(prompt).toContain('Tried a Map cache');
    expect(prompt).toContain('Tests passed in the implementation step.');
  });

  it('agentJob graphContext appends the node location without exposing the whole graph', async () => {
    const repo = await tmpRepo();
    const cap = capturing();

    await run(
      dag({
        name: 'ship',
        nodes: {
          implementation: agentJob({
            label: 'implementation',
            prompt: 'Build it.',
            graphContext: true,
          }),
          review: {
            needs: ['implementation'],
            job: fnJob('review', async () => ({ status: 'pass' })),
          },
        },
      }),
      { ...cap.opts, cwd: repo },
    );

    expect(cap.prompts[0]).toContain('## Graph position');
    expect(cap.prompts[0]).toContain('Current node: implementation');
    expect(cap.prompts[0]).toContain('Depends on: none');
    expect(cap.prompts[0]).toContain('Direct dependents: review');
  });
});
