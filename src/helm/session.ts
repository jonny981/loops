/**
 * The helm loop: a conversational driver that turns a user message into
 * structured intents the bridge executes. The driver is any `Engine` — the
 * same one-method interface loop bodies and judges run on — so the mock
 * engine drives the session offline in tests and `claude-cli`/`codex`/
 * `anthropic-api` drive it live.
 *
 * Engines run **fresh-context** turns, so the session carries the
 * conversation itself: the system prompt stays byte-stable (prefix-cache
 * friendly) and each step's prompt is a deterministic fold of the transcript
 * — recent entries verbatim (observation evidence clamped), older entries as
 * one-line digests. The workspace-is-the-state tenet applies here too: the
 * durable facts live in the run registry and the repo, not in the chat.
 *
 * Turn discipline (both are lessons from driving harnesses with cheap
 * models): the step budget is stated in-context every step, and a dispatch is
 * a pause-point — a `run`/`ack` that lands ends the turn instead of letting
 * the driver poll itself into a loop-burn.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { EngineRef, Usage } from '../engines/engine.ts';
import { EngineRegistry } from '../engines/registry.ts';
import { newRunId } from '../runtime/supervisor.ts';
import { truncate } from '../core/text.ts';
import {
  parseHelmIntent,
  HelmIntentError,
  HelmParseError,
  type HelmIntent,
} from './intent.ts';
import { helmSystemPrompt } from './system.ts';
import type { Observation, HelmBridge } from './bridge.ts';

export type TurnEndReason =
  | 'answered'
  | 'done'
  | 'dispatched'
  | 'steps'
  | 'unproductive'
  | 'aborted';

export type HelmEvent =
  | { kind: 'say'; text: string }
  | { kind: 'intent'; intent: HelmIntent }
  | { kind: 'observation'; observation: Observation }
  | { kind: 'invalid'; error: string; willRetry: boolean }
  | { kind: 'usage'; usage: Usage; model: string }
  | { kind: 'turn-end'; reason: TurnEndReason; steps: number };

interface TranscriptEntry {
  role: 'user' | 'helm' | 'observation';
  text: string;
  ts: number;
}

export interface HelmSessionOptions {
  bridge: HelmBridge;
  /** The driver: any registered engine name or a ready-made `Engine`. */
  engine?: EngineRef;
  registry?: EngineRegistry;
  model?: string;
  maxTokens?: number;
  /** Intent budget per user turn (engine calls, including repairs). Default 8. */
  maxSteps?: number;
  /** Override the byte-stable contract prompt (`helmSystemPrompt`). */
  system?: string;
  /** Transcript home; default `LOOPS_HOME`/`~/.loops`. */
  home?: string;
  sessionId?: string;
}

/** Transcript entries composed verbatim into the prompt (older ones fold). */
const VERBATIM_TAIL = 12;
/** Clamp on one observation's evidence when composed into the prompt. */
const OBSERVATION_CLAMP = 1500;
/** Consecutive invalid replies before the turn ends unproductive. */
const MAX_INVALID = 2;

export class HelmSession {
  readonly sessionId: string;
  private readonly transcript: TranscriptEntry[] = [];
  private readonly registry: EngineRegistry;
  private readonly system: string;
  private readonly transcriptPath: string;

  constructor(private readonly opts: HelmSessionOptions) {
    this.sessionId = opts.sessionId ?? newRunId('helm');
    this.registry = opts.registry ?? new EngineRegistry();
    this.system = opts.system ?? helmSystemPrompt();
    const home =
      opts.home ?? process.env.LOOPS_HOME ?? join(homedir(), '.loops');
    this.transcriptPath = join(
      home,
      'helm',
      this.sessionId,
      'transcript.jsonl',
    );
  }

  /** One user turn: yields events as the driver reasons, acts, and observes. */
  async *send(
    message: string,
    signal?: AbortSignal,
  ): AsyncGenerator<HelmEvent> {
    const maxSteps = this.opts.maxSteps ?? 8;
    const engine = this.registry.create(this.opts.engine, 'claude-cli');
    this.push({ role: 'user', text: message, ts: Date.now() });

    let invalidStreak = 0;
    let repairNote: string | undefined;
    for (let step = 1; step <= maxSteps; step++) {
      if (signal?.aborted) {
        yield { kind: 'turn-end', reason: 'aborted', steps: step - 1 };
        return;
      }
      const prompt = this.composePrompt(step, maxSteps, repairNote);
      repairNote = undefined;
      let usage: { usage: Usage; model: string } | undefined;
      let text: string;
      try {
        const result = await engine.run(
          {
            prompt,
            system: this.system,
            model: this.opts.model,
            maxTokens: this.opts.maxTokens,
            leaf: true,
          },
          (event) => {
            if (event.type === 'usage')
              usage = { usage: event.usage, model: event.model };
          },
          signal ?? new AbortController().signal,
        );
        text = result.text;
      } catch (e) {
        if (signal?.aborted) {
          yield { kind: 'turn-end', reason: 'aborted', steps: step - 1 };
          return;
        }
        throw e;
      }
      if (usage) yield { kind: 'usage', ...usage };

      let intent: HelmIntent;
      try {
        intent = parseHelmIntent(text);
      } catch (e) {
        if (!(e instanceof HelmParseError) && !(e instanceof HelmIntentError))
          throw e;
        invalidStreak += 1;
        const willRetry = invalidStreak < MAX_INVALID && step < maxSteps;
        yield { kind: 'invalid', error: e.message, willRetry };
        if (!willRetry) {
          yield { kind: 'turn-end', reason: 'unproductive', steps: step };
          return;
        }
        repairNote = `(harness) Your last reply was not a valid intent: ${e.message}. Reply with exactly ONE JSON intent object and nothing else.`;
        continue;
      }
      invalidStreak = 0;
      yield { kind: 'intent', intent };
      if (intent.say) yield { kind: 'say', text: intent.say };
      this.push({
        role: 'helm',
        text: JSON.stringify(intent),
        ts: Date.now(),
      });

      if (intent.action === 'answer') {
        yield { kind: 'turn-end', reason: 'answered', steps: step };
        return;
      }
      if (intent.action === 'done') {
        yield { kind: 'turn-end', reason: 'done', steps: step };
        return;
      }

      const observation = await this.opts.bridge.execute(intent);
      yield { kind: 'observation', observation };
      this.push({
        role: 'observation',
        text: renderObservation(observation),
        ts: Date.now(),
      });

      // Dispatch is a pause-point: a landed run/ack ends the turn so the
      // driver reports the runId instead of polling itself into a loop-burn.
      if (
        observation.ok &&
        (intent.action === 'run' || intent.action === 'ack')
      ) {
        yield { kind: 'turn-end', reason: 'dispatched', steps: step };
        return;
      }
    }
    yield { kind: 'turn-end', reason: 'steps', steps: maxSteps };
  }

  private composePrompt(
    step: number,
    maxSteps: number,
    repairNote?: string,
  ): string {
    const lines: string[] = ['TRANSCRIPT'];
    const foldBoundary = Math.max(0, this.transcript.length - VERBATIM_TAIL);
    for (let i = 0; i < this.transcript.length; i++) {
      const entry = this.transcript[i]!;
      if (i < foldBoundary) {
        lines.push(`[earlier] ${entry.role}: ${oneLineDigest(entry.text)}`);
        continue;
      }
      const body =
        entry.role === 'observation'
          ? truncate(entry.text, OBSERVATION_CLAMP)
          : entry.text;
      lines.push(`${entry.role} › ${body}`);
    }
    lines.push(
      '',
      `HARNESS: step ${step} of ${maxSteps} this turn; runs dispatched: ${this.opts.bridge.dispatched()}.`,
    );
    if (repairNote) lines.push(repairNote);
    lines.push('Reply with exactly one intent JSON object.');
    return lines.join('\n');
  }

  private push(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    try {
      mkdirSync(dirname(this.transcriptPath), { recursive: true });
      appendFileSync(this.transcriptPath, `${JSON.stringify(entry)}\n`);
    } catch {
      /* best-effort: the transcript file must never break a turn */
    }
  }
}

function renderObservation(observation: Observation): string {
  const head = `${observation.ok ? 'ok' : 'FAILED'} ${observation.action}: ${observation.summary}`;
  return observation.detail ? `${head}\n${observation.detail}` : head;
}

function oneLineDigest(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 120);
}
