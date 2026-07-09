/**
 * Deterministic scoring for the driver eval — no LLM-as-judge, ever. Four
 * objective dimensions per attempt, kept separate on purpose:
 *
 *   jsonValid      the reply contained a parseable JSON object at all
 *   schemaValid    that object is a valid intent (strict validator)
 *   actionCorrect  the intent's action matches the case's expectation
 *   executedOk     the bridge really performed it (must-execute cases only)
 *
 * The composite weights make a valid schema the floor (0.40), the right
 * decision the bulk (0.40 more), and real execution the last 0.20; cases with
 * nothing to execute redistribute that credit onto the decision, so every
 * case tops out at 1.0.
 */

import {
  parseHelmIntent,
  HelmIntentError,
  HelmParseError,
  type HelmAction,
  type HelmIntent,
} from './intent.ts';

export interface TaskCase {
  id: string;
  /** The user message the driver sees. */
  prompt: string;
  expected: HelmAction;
  /** Run the intent through a real bridge and require it to land. */
  mustExecute?: boolean;
  notes?: string;
}

export interface AttemptDims {
  jsonValid: boolean;
  schemaValid: boolean;
  actionCorrect: boolean;
  /** Undefined when the case has nothing to execute (or never got that far). */
  executedOk?: boolean;
}

export interface Assessment {
  dims: AttemptDims;
  intent?: HelmIntent;
  /** The parse/validation error, when one of the first two dims failed. */
  error?: string;
}

/** Grade a raw driver reply against a case (execution graded separately). */
export function assessReply(taskCase: TaskCase, reply: string): Assessment {
  try {
    const intent = parseHelmIntent(reply);
    return {
      dims: {
        jsonValid: true,
        schemaValid: true,
        actionCorrect: intent.action === taskCase.expected,
      },
      intent,
    };
  } catch (e) {
    if (e instanceof HelmParseError) {
      return {
        dims: { jsonValid: false, schemaValid: false, actionCorrect: false },
        error: e.message,
      };
    }
    if (e instanceof HelmIntentError) {
      return {
        dims: { jsonValid: true, schemaValid: false, actionCorrect: false },
        error: e.message,
      };
    }
    throw e;
  }
}

export function compositeScore(
  dims: AttemptDims,
  taskCase: Pick<TaskCase, 'mustExecute'>,
): number {
  let score = 0;
  if (dims.jsonValid) score += 0.15;
  if (dims.schemaValid) score += 0.25;
  if (dims.actionCorrect) score += 0.4;
  if (taskCase.mustExecute) {
    if (dims.executedOk) score += 0.2;
  } else if (dims.actionCorrect) {
    score += 0.2;
  }
  return Number(score.toFixed(4));
}
