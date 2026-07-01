import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  ConditionInput,
  ConditionResult,
  FeedbackActionSeverity,
  FeedbackDecision,
  FeedbackFinding,
  FeedbackSeverity,
  GraphPosition,
  Job,
  JobContext,
  Outcome,
  RevisionRequest,
  RevisionRerun,
} from './types.ts';
import { toCondition } from './condition.ts';
import { setMeta } from './describe.ts';
import { LoopError } from './errors.ts';
import { oneLine, truncate } from './text.ts';
import { readLedger, readPrompt } from './draft.ts';
import { groundingText } from './ground.ts';

export type {
  FeedbackActionSeverity,
  FeedbackDecision,
  FeedbackFinding,
  FeedbackSeverity,
  RevisionRequest,
  RevisionRerun,
} from './types.ts';

export interface RevisionRequestInput {
  target?: string;
  reason?: string;
  findings?: FeedbackFinding[];
  rerun?: RevisionRerun;
  source?: string;
  decision?: FeedbackDecision;
}

export function normalizeFeedbackSeverity(
  severity: FeedbackSeverity | undefined,
): FeedbackActionSeverity {
  switch (severity) {
    case 'advisory':
      return 'nice-to-have';
    case 'blocking':
    case undefined:
      return 'block';
    default:
      return severity;
  }
}

export function isRequiredFeedbackSeverity(
  severity: FeedbackSeverity | undefined,
): boolean {
  const normalized = normalizeFeedbackSeverity(severity);
  return normalized === 'block' || normalized === 'should-fix';
}

function findingLine(finding: FeedbackFinding): string {
  const reviewer = finding.reviewer ? `${finding.reviewer} ` : '';
  const severity = normalizeFeedbackSeverity(finding.severity);
  const decision = finding.decision ? ` Decision: ${finding.decision}.` : '';
  const recommendation = finding.recommendation
    ? ` Recommendation: ${oneLine(finding.recommendation)}`
    : '';
  return `- ${reviewer}[${severity}]: ${oneLine(finding.evidence)}${decision}${recommendation}`;
}

function defaultReason(findings: FeedbackFinding[] | undefined): string {
  if (!findings?.length) return 'Revision requested';
  if (findings.length === 1) return oneLine(findings[0]!.evidence);
  return `${findings.length} findings require another pass`;
}

function normalizeRevision(input: RevisionRequestInput): RevisionRequest {
  const reason = input.reason?.trim() || defaultReason(input.findings);
  return {
    reason,
    target: input.target,
    findings: input.findings,
    rerun: input.rerun ?? (input.target ? 'target-and-dependents' : undefined),
    source: input.source,
    decision: input.decision,
  };
}

export function revisionRequest(
  input: RevisionRequestInput,
  over: Partial<Outcome> = {},
): Outcome {
  const revision = normalizeRevision(input);
  return {
    status: over.status ?? 'fail',
    confidence: over.confidence,
    summary: over.summary ?? revision.reason,
    data: over.data,
    error: over.error,
    revision,
  };
}

export function kickback(
  to: string,
  reason: string,
  over: Partial<Outcome> = {},
): Outcome {
  // A kickback is just a targeted revision request; `rerun` defaults to
  // 'target-and-dependents' in normalizeRevision because a target is set.
  return revisionRequest({ target: to, reason }, over);
}

/**
 * The single accessor for an outcome's revision request. `Outcome.revision` is
 * the one channel a producer sets (`revisionRequest`, `kickback`, `reviewPanel`,
 * dag routing), so there is exactly one place to read it — no parallel `kickback`
 * field or `data` copy to keep in sync.
 */
export function revisionFromOutcome(outcome: Outcome): RevisionRequest | undefined {
  return outcome.revision;
}

export function feedbackBlock(outcome: Outcome): string {
  const revision = revisionFromOutcome(outcome);
  const parts = [
    '## Feedback to address',
    'A review or downstream stage requested another pass. Address this before unrelated work.',
  ];
  if (revision?.target) parts.push(`Target: ${revision.target}`);
  if (revision?.source) parts.push(`Source: ${revision.source}`);
  if (revision?.decision) parts.push(`Caller decision: ${revision.decision}`);
  const reason = revision?.reason ?? outcome.summary;
  if (reason) parts.push(`Reason: ${reason}`);
  const findings = revision?.findings ?? [];
  if (findings.length) {
    parts.push('Findings:');
    parts.push(findings.map(findingLine).join('\n'));
  }
  return parts.join('\n\n');
}

export function graphPositionBlock(graph: GraphPosition): string {
  return [
    '## Graph position',
    `DAG: ${graph.dag}`,
    `Current node: ${graph.node}`,
    `Path: ${graph.path.join(' > ')}`,
    `Depends on: ${graph.needs.length ? graph.needs.join(', ') : 'none'}`,
    `Direct dependents: ${
      graph.dependents.length ? graph.dependents.join(', ') : 'none'
    }`,
  ].join('\n');
}

type ReviewTarget =
  | { name?: string; review: ConditionInput }
  | { name?: string; job: Job };

export interface ReviewPanelConfig {
  label?: string;
  reviewers: ReviewTarget[];
  /** Default `all`: every reviewer must pass. A number means k-of-n over all reviewers. */
  pass?: 'all' | number;
  /** When set, a failing panel emits a targeted revision request for dag routing. */
  target?: string;
  rerun?: RevisionRerun;
}

interface ReviewResult {
  name: string;
  met: boolean;
  confidence?: number;
  reason: string;
}

async function runReviewer(
  reviewer: ReviewTarget,
  index: number,
  ctx: JobContext,
): Promise<ReviewResult> {
  const name = reviewer.name ?? `reviewer-${index + 1}`;
  try {
    if ('job' in reviewer) {
      const outcome = await reviewer.job(ctx);
      return {
        name,
        met: outcome.status === 'pass',
        confidence: outcome.confidence,
        reason: outcome.summary ?? outcome.status,
      };
    }
    const result: ConditionResult = await toCondition(reviewer.review)(
      ctx,
      ctx.lastOutcome,
    );
    return {
      name,
      met: result.met,
      confidence: result.confidence,
      reason: result.reason,
    };
  } catch (e) {
    // A genuine abort stops the whole run — let it propagate.
    if (ctx.signal.aborted) throw e;
    // Otherwise, one reviewer erroring (a transient engine/network failure) must
    // not reject the whole panel and turn a recoverable retry into a hard loop
    // failure. Count it as an unmet finding so sibling verdicts still stand — the
    // same reason quorum runs its jurors under allSettled.
    return {
      name,
      met: false,
      reason: `reviewer errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function reviewFinding(result: ReviewResult): FeedbackFinding {
  // Every panel reviewer is a gate, so a failing one is a blocking finding.
  return {
    reviewer: result.name,
    severity: 'block',
    evidence: result.reason,
  };
}

function findingSeverityCounts(
  findings: FeedbackFinding[],
): Partial<Record<FeedbackActionSeverity, number>> {
  const counts: Partial<Record<FeedbackActionSeverity, number>> = {};
  for (const finding of findings) {
    const severity = normalizeFeedbackSeverity(finding.severity);
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

export function reviewPanel(config: ReviewPanelConfig): Job {
  const label = config.label ?? 'review-panel';
  // A panel with no reviewers would pass vacuously (0/0), letting unreviewed work
  // through a gate meant to enforce review. Reject it at construction.
  if (!config.reviewers.length)
    throw new LoopError({
      code: 'CONFIG',
      message: `reviewPanel "${label}": at least one reviewer is required`,
    });
  const job: Job = async (ctx) => {
    ctx.emit({ kind: 'job:start', ts: Date.now(), path: [...ctx.path], label });
    const results = await Promise.all(
      config.reviewers.map((reviewer, i) => runReviewer(reviewer, i, ctx)),
    );
    const passedCount = results.filter((r) => r.met).length;
    const required =
      config.pass === undefined || config.pass === 'all'
        ? results.length
        : config.pass;
    const findings = results.filter((r) => !r.met).map(reviewFinding);
    const passed = passedCount >= required;
    const summaryHead = `Review panel: ${passedCount}/${results.length} reviewer(s) cleared`;
    const summary = findings.length
      ? `${summaryHead}.\n${findings.map(findingLine).join('\n')}`
      : `${summaryHead}.`;
    // Average only the confidences reviewers actually reported. Coercing a
    // missing confidence to 0 conflates "no signal" with "zero confidence" and
    // can drag a cleanly-passing panel's confidence to 0, stalling an enclosing
    // loop's minConfidence gate (quorum likewise averages only the votes it has).
    const scored = results
      .map((r) => r.confidence)
      .filter((c): c is number => c != null);
    const confidence = scored.length
      ? scored.reduce((sum, c) => sum + c, 0) / scored.length
      : undefined;
    const data = {
      findings,
      results,
      passed: passedCount,
      required,
      severityCounts: findingSeverityCounts(findings),
    };
    const outcome: Outcome = passed
      ? { status: 'pass', summary, confidence, data }
      : revisionRequest(
          {
            target: config.target,
            // A clean one-line reason. The findings ride the `findings` array, so
            // feedbackBlock renders them once (not embedded in the reason too) and
            // the records/tail `reason` stays a single tidy line. The full
            // multi-line `summary` is kept on the outcome below for logs/TUI.
            reason: `${summaryHead}.`,
            findings,
            rerun: config.rerun,
          },
          { summary, confidence, data },
        );
    ctx.emit({ kind: 'job:end', ts: Date.now(), path: [...ctx.path], label, outcome });
    return outcome;
  };
  return setMeta(job, { kind: 'reviewPanel', name: label });
}

export interface ReviewContextConfig {
  diff?: boolean;
  files?: string[];
  ledger?: boolean;
  tests?: boolean | { command: string; args?: string[]; cwd?: string };
  maxChars?: number;
}

async function gitOutput(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const out = await execa('git', args, {
    cwd,
    reject: false,
    stripFinalNewline: false,
    cancelSignal: signal,
  });
  return out.stdout.trim();
}

async function resolveFiles(
  ctx: JobContext,
  patterns: string[],
): Promise<string[]> {
  const fromGit = await gitOutput(
    ctx.workspace.dir,
    ['ls-files', '--', ...patterns],
    ctx.signal,
  ).catch(() => '');
  const files = fromGit ? fromGit.split('\n').filter(Boolean) : [];
  if (files.length) return files;
  return patterns.filter((p) => existsSync(join(ctx.workspace.dir, p)));
}

export function reviewContext(config: ReviewContextConfig) {
  return async (ctx: JobContext, last: Outcome | undefined): Promise<string> => {
    const max = config.maxChars ?? 6000;

    const buildTests = async (): Promise<string[]> => {
      if (!config.tests) return [];
      if (config.tests === true) {
        const lines: string[] = [];
        if (last?.status) lines.push(`Last outcome status: ${last.status}`);
        if (last?.summary) lines.push(`Last outcome summary: ${last.summary}`);
        if (last?.data !== undefined) {
          // Guard the stringify: a circular or BigInt-bearing `data` would throw,
          // and agentCheck awaits context() outside its try/catch, so the throw
          // would fail the whole review instead of degrading the evidence.
          let rendered: string;
          try {
            rendered = JSON.stringify(last.data, null, 2);
          } catch {
            rendered = String(last.data);
          }
          lines.push(`Last outcome data: ${rendered}`);
        }
        return lines.length
          ? [`## Test and outcome context\n\n${lines.join('\n')}`]
          : [];
      }
      const cwd = config.tests.cwd ?? ctx.workspace.dir;
      // Unlike the git probes, an unspawnable or aborted command would otherwise
      // reject out of reviewContext and throw the whole review. Guard it, and
      // never report `exit: 0` for a command that did not actually run — that
      // would tell the judge the tests passed.
      const result = await execa(
        config.tests.command,
        config.tests.args ?? [],
        { cwd, reject: false, stripFinalNewline: false, cancelSignal: ctx.signal },
      ).catch((e: unknown) => {
        if (ctx.signal.aborted) throw e; // a real abort stops the run
        return {
          exitCode: undefined as number | undefined,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e),
        };
      });
      const exit = result.exitCode ?? '(command did not run)';
      return [
        `## Test command\n\n${config.tests.command} ${(config.tests.args ?? []).join(' ')}\n\n` +
          `exit: ${exit}\n\nstdout:\n${truncate(result.stdout ?? '', max)}\n\nstderr:\n${truncate(result.stderr ?? '', max)}`,
      ];
    };

    const buildDiff = async (): Promise<string[]> => {
      if (!config.diff) return [];
      const diff = await gitOutput(
        ctx.workspace.dir,
        ['diff', 'HEAD', '--'],
        ctx.signal,
      ).catch(() => '');
      return diff ? [`## Git diff\n\n${truncate(diff, max)}`] : [];
    };

    const buildFiles = async (): Promise<string[]> => {
      if (!config.files?.length) return [];
      const files = await resolveFiles(ctx, config.files);
      const out: string[] = [];
      for (const file of files) {
        const path = join(ctx.workspace.dir, file);
        if (!existsSync(path)) continue;
        out.push(`## File: ${file}\n\n${truncate(readFileSync(path, 'utf8'), max)}`);
      }
      return out;
    };

    const buildLedger = async (): Promise<string[]> => {
      if (!config.ledger) return [];
      const out: string[] = [];
      const live = [readPrompt(ctx.workspace), readLedger(ctx.workspace)]
        .filter(Boolean)
        .join('\n\n');
      if (live) out.push(`## Live ledger\n\n${truncate(live, max)}`);
      const committed = await groundingText(ctx.workspace, {
        max: 5,
        bodyChars: 1200,
        signal: ctx.signal,
      }).catch(() => '');
      if (committed) out.push(truncate(committed, max));
      return out;
    };

    // The four evidence sources are independent read-only probes; gather them
    // concurrently, then assemble in a fixed order.
    const [tests, diff, files, ledger] = await Promise.all([
      buildTests(),
      buildDiff(),
      buildFiles(),
      buildLedger(),
    ]);
    const sections = [...tests, ...diff, ...files, ...ledger];
    return sections.join('\n\n---\n\n') || '(no review context)';
  };
}
