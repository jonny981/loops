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
  reviewPanel,
  reviewContext,
  revisionRequest,
  feedbackBlock,
  normalizeFeedbackSeverity,
  isRequiredFeedbackSeverity,
  appendLedger,
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
