/**
 * The offline oracle: a deterministic keyword policy that drives the helm
 * contract perfectly, packaged as a `MockEngine` responder. It is the eval's
 * 100% control ceiling — if the oracle scores below 1.0 on the battery, the
 * harness (contract, parser, bridge, or scoring) broke, not a model — and the
 * driver tests' offline helm. Zero keys, zero network.
 */

import { MockEngine, type MockResponder } from '../engines/mock.ts';
import type { HelmIntent } from './intent.ts';

export interface OracleOptions {
  /** Import specifier authored recipes use (mirror the session/eval option). */
  authorImport?: string;
}

/** The last `user › …` line of the composed prompt: what the turn is about. */
function lastUserMessage(prompt: string): string {
  const matches = [...prompt.matchAll(/(?:^|\n)user › (.*)/g)];
  return matches.length ? matches[matches.length - 1]![1]! : prompt;
}

function runIdIn(text: string): string | undefined {
  return /\brun ([a-z0-9][a-z0-9-]*)\b/.exec(text)?.[1];
}

function fileIn(text: string): string | undefined {
  return /([\w./-]+\.loop\.ts)\b/.exec(text)?.[1];
}

function minimalRecipe(importSpec: string): string {
  return [
    `import { defineJob, loop, agentJob, commandSucceeds } from '${importSpec}';`,
    'export default defineJob(loop({',
    "  name: 'fix-tests',",
    '  max: 10,',
    '  body: agentJob({',
    '    prompt: (c) => `Iteration ${c.iteration}: make the failing tests pass.`,',
    '    ground: true,',
    '  }),',
    "  until: commandSucceeds('npm', ['test']),",
    '}));',
    '',
  ].join('\n');
}

/** The deterministic policy, ordered most-specific first. */
export function oracleIntent(
  message: string,
  opts: OracleOptions = {},
): HelmIntent {
  const raw = message.trim();
  const text = raw.toLowerCase();
  const runId = runIdIn(text);
  const file = fileIn(raw);

  if (/nothing (else|left)|that's everything|we're finished|all done|no further/.test(text)) {
    return { action: 'done', say: 'Wrapping up.' };
  }
  if (runId && /\b(kill|abort|stop)\b/.test(text)) {
    return { action: 'stop_run', runId, say: `Stopping ${runId}.` };
  }
  if (runId && /\b(approve|approved|lift|acknowledge|ack)\b/.test(text)) {
    const gate = /(?:the )?["']?([a-z][\w-]*)["']? gate/.exec(text)?.[1] ?? 'gate';
    return { action: 'ack', runId, gate, say: `Lifting the ${gate} gate.` };
  }
  if (runId && /\b(records?|decisions?|revisions?)\b/.test(text)) {
    return { action: 'records', runId, kind: 'revision', say: `Reading ${runId}'s decisions.` };
  }
  if (runId && /\b(status|progress|doing|going)\b/.test(text)) {
    return { action: 'status', runId, say: `Checking on ${runId}.` };
  }
  if (file && /\b(start|launch|dispatch|kick off)\b/.test(text)) {
    return { action: 'run', file, say: `Dispatching ${file}.` };
  }
  if (file && /\b(check|valid|validate|pre-?flight)\b/.test(text)) {
    return { action: 'validate', file, say: `Validating ${file}.` };
  }
  if (file && /\b(write|author|create|draft)\b/.test(text)) {
    return {
      action: 'author',
      file,
      source: minimalRecipe(opts.authorImport ?? '@loops-adk/core'),
      say: `Authoring ${file}.`,
    };
  }
  return {
    action: 'answer',
    say: 'A gate combines a deterministic check with a separate judge, so "done" means converged, not claimed.',
  };
}

/** A `MockEngine` responder speaking the oracle policy. Once an observation
 *  has landed for the latest user message, it concludes with an answer instead
 *  of re-issuing the same read — the minimal multi-turn discipline the session
 *  expects of a real driver. */
export function oracleResponder(opts: OracleOptions = {}): MockResponder {
  return (req) => {
    const lastUser = req.prompt.lastIndexOf('user › ');
    const lastObservation = req.prompt.lastIndexOf('observation › ');
    if (lastObservation > lastUser) {
      const line = req.prompt.slice(lastObservation).split('\n')[0]!;
      return JSON.stringify({
        action: 'answer',
        say: `Here is what I found: ${line.replace('observation › ', '')}`,
      } satisfies HelmIntent);
    }
    return JSON.stringify(oracleIntent(lastUserMessage(req.prompt), opts));
  };
}

export function oracleEngine(opts: OracleOptions = {}): MockEngine {
  return new MockEngine(oracleResponder(opts));
}
