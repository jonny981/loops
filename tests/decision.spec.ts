import { describe, it, expect } from 'vitest';

import {
  confidenceCondition,
  confidenceFromText,
  fnJob,
  lastDecisionLine,
  lastGateBrief,
  run,
} from '../src/api.ts';

describe('decision-token helpers', () => {
  it('returns only a closing decision line and ignores handoff restatements', () => {
    const text = [
      '<decision>retry</decision>',
      'inline decision: fail',
      'decision: pass',
      '===HANDOFF===',
      'decision: fail',
    ].join('\n');

    expect(lastDecisionLine(text, 'decision', ['pass', 'fail'])).toBe('pass');
    expect(lastDecisionLine('decision: pass\nunresolved caveat', 'decision')).toBeUndefined();
  });

  it('parses confidence tags as percentages or fractions', () => {
    expect(confidenceFromText('<confidence>87%</confidence>')).toBe(0.87);
    expect(confidenceFromText('confidence: 0.62')).toBe(0.62);
    expect(confidenceFromText('confidence: nope')).toBeUndefined();
  });

  it('lifts a job into a confidence condition fail-closed', async () => {
    const condition = confidenceCondition(
      fnJob('reader', async () => ({
        status: 'pass',
        summary: '<confidence>91%</confidence>',
      })),
      { threshold: 0.9 },
    );
    const result = await run(
      fnJob('gate', async (ctx) => {
        const gate = await condition(ctx, undefined);
        return { status: gate.met ? 'pass' : 'fail', confidence: gate.confidence };
      }),
    );
    expect(result.outcome.status).toBe('pass');
    expect(result.outcome.confidence).toBe(0.91);
  });

  it('renders a compact last gate brief only for failed gates', () => {
    expect(lastGateBrief({ lastGate: undefined })).toBe('');
    expect(lastGateBrief({ lastGate: { met: true, reason: 'ok' } })).toBe('');
    expect(
      lastGateBrief(
        { lastGate: { met: false, reason: 'tests failed', output: 'x'.repeat(20) } },
        { maxOutputChars: 5 },
      ),
    ).toContain('xxxxx\n[gate output truncated]');
  });
});
