import { describe, it, expect } from 'vitest';

import { oracleIntent } from '../src/helm/oracle.ts';
import { DRIVER_BATTERY } from '../src/helm/eval.ts';
import { assessReply, compositeScore } from '../src/helm/score.ts';

describe('the offline oracle', () => {
  it('maps every battery case to its expected action', () => {
    for (const taskCase of DRIVER_BATTERY) {
      const intent = oracleIntent(taskCase.prompt);
      expect(intent.action, taskCase.id).toBe(taskCase.expected);
    }
  });

  it('scores 1.0 on every case that needs no execution', () => {
    for (const taskCase of DRIVER_BATTERY.filter((c) => !c.mustExecute)) {
      const reply = JSON.stringify(oracleIntent(taskCase.prompt));
      const { dims } = assessReply(taskCase, reply);
      expect(compositeScore(dims, taskCase), taskCase.id).toBe(1);
    }
  });

  it('answers trivia instead of dispatching (the cost thesis)', () => {
    expect(oracleIntent('What is a convergence loop?').action).toBe('answer');
    expect(oracleIntent("what's the difference between until and review?").action).toBe(
      'answer',
    );
  });

  it('extracts the run id and gate name for an ack', () => {
    const intent = oracleIntent(
      'I approve the deploy gate on run checkout-9f0a12 — lift it.',
    );
    expect(intent).toMatchObject({
      action: 'ack',
      runId: 'checkout-9f0a12',
      gate: 'deploy',
    });
  });
});

describe('compositeScore', () => {
  const base = { mustExecute: false };

  it('gives partial credit for valid JSON with a wrong schema', () => {
    expect(
      compositeScore(
        { jsonValid: true, schemaValid: false, actionCorrect: false },
        base,
      ),
    ).toBe(0.15);
  });

  it('gives schema credit for the wrong action', () => {
    expect(
      compositeScore(
        { jsonValid: true, schemaValid: true, actionCorrect: false },
        base,
      ),
    ).toBe(0.4);
  });

  it('caps a must-execute case at 0.8 without execution', () => {
    expect(
      compositeScore(
        { jsonValid: true, schemaValid: true, actionCorrect: true, executedOk: false },
        { mustExecute: true },
      ),
    ).toBe(0.8);
  });

  it('reaches 1.0 with execution on a must-execute case', () => {
    expect(
      compositeScore(
        { jsonValid: true, schemaValid: true, actionCorrect: true, executedOk: true },
        { mustExecute: true },
      ),
    ).toBe(1);
  });
});
