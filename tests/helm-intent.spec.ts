import { describe, it, expect } from 'vitest';

import {
  extractFirstJson,
  parseHelmIntent,
  escapeControlInStrings,
  HELM_RECORD_KINDS,
  HelmParseError,
  HelmIntentError,
} from '../src/helm/intent.ts';
import { SEMANTIC_RECORD_FILTER_KINDS } from '../src/api.ts';

describe('extractFirstJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractFirstJson('{"action":"done"}')).toEqual({ action: 'done' });
  });

  it('prefers a fenced block, tolerating a language tag', () => {
    const text = 'Here you go:\n```json\n{"action":"answer","say":"hi"}\n```\nDone.';
    expect(extractFirstJson(text)).toEqual({ action: 'answer', say: 'hi' });
  });

  it('finds the object inside surrounding prose', () => {
    const text = 'I will check the run now. {"action":"status","runId":"fix-1a"} Let me know.';
    expect(extractFirstJson(text)).toEqual({ action: 'status', runId: 'fix-1a' });
  });

  it('skips a non-JSON brace span in earlier prose', () => {
    const text =
      'The config shape is {threshold: 0.85} roughly.\n{"action":"done"}';
    expect(extractFirstJson(text)).toEqual({ action: 'done' });
  });

  it('is not confused by braces inside string values', () => {
    const source = 'loop({ name: "x" })';
    const text = `{"action":"author","file":"a.loop.ts","source":${JSON.stringify(source)}}`;
    expect(extractFirstJson(`note ${text}`)).toMatchObject({ source });
  });

  it('repairs literal control characters inside string literals', () => {
    const text = '{"action":"answer","say":"line one\nline two"}';
    expect(extractFirstJson(text)).toEqual({
      action: 'answer',
      say: 'line one\nline two',
    });
  });

  it('throws HelmParseError when there is no JSON at all', () => {
    expect(() => extractFirstJson('I am not sure what to do.')).toThrow(
      HelmParseError,
    );
  });
});

describe('escapeControlInStrings', () => {
  it('escapes only inside strings, leaving structure intact', () => {
    const input = '{\n  "a": "x\ny"\n}';
    expect(escapeControlInStrings(input)).toBe('{\n  "a": "x\\ny"\n}');
  });

  it('leaves already-escaped sequences alone', () => {
    const input = '{"a":"x\\ny"}';
    expect(escapeControlInStrings(input)).toBe(input);
  });
});

describe('parseHelmIntent', () => {
  it('accepts every action shape', () => {
    const intents = [
      { action: 'answer', say: 'hello' },
      { action: 'author', file: 'a.loop.ts', source: 'x' },
      { action: 'validate', file: 'a.loop.ts' },
      { action: 'run', file: 'a.loop.ts', args: ['--budget', '10000'] },
      { action: 'status' },
      { action: 'status', runId: 'fix-1a2b' },
      { action: 'records', runId: 'fix-1a2b', kind: 'revision', last: 5 },
      { action: 'ack', runId: 'fix-1a2b', gate: 'deploy' },
      { action: 'stop_run', runId: 'fix-1a2b' },
      { action: 'done' },
    ];
    for (const intent of intents) {
      expect(parseHelmIntent(JSON.stringify(intent))).toMatchObject(intent);
    }
  });

  it('rejects an unknown action, naming the valid ones', () => {
    expect(() => parseHelmIntent('{"action":"deploy"}')).toThrow(
      HelmIntentError,
    );
    try {
      parseHelmIntent('{"action":"deploy"}');
    } catch (e) {
      expect((e as Error).message).toContain('unknown action "deploy"');
      expect((e as Error).message).toContain('answer');
    }
  });

  it('rejects a traversal-shaped runId', () => {
    expect(() =>
      parseHelmIntent('{"action":"status","runId":"../etc"}'),
    ).toThrow(HelmIntentError);
  });

  it('requires say on answer and gate on ack', () => {
    expect(() => parseHelmIntent('{"action":"answer"}')).toThrow(
      HelmIntentError,
    );
    expect(() =>
      parseHelmIntent('{"action":"ack","runId":"fix-1a"}'),
    ).toThrow(HelmIntentError);
  });

  it('rejects an out-of-vocabulary records kind', () => {
    expect(() =>
      parseHelmIntent('{"action":"records","runId":"fix-1a","kind":"everything"}'),
    ).toThrow(HelmIntentError);
  });

  it('uses the canonical semantic record kind vocabulary', () => {
    expect(HELM_RECORD_KINDS).toEqual(SEMANTIC_RECORD_FILTER_KINDS);
    expect(
      parseHelmIntent(
        '{"action":"records","runId":"fix-1a","kind":"gate-verdict"}',
      ),
    ).toMatchObject({ action: 'records', kind: 'gate-verdict' });
  });

  it('tolerates a rationale field on any action', () => {
    expect(
      parseHelmIntent('{"action":"done","rationale":"objective met"}'),
    ).toMatchObject({ action: 'done', rationale: 'objective met' });
  });
});
