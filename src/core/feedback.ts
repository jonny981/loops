import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  ConditionInput,
  ConditionResult,
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
import { readLedger, readPrompt } from './draft.ts';
import { groundingText } from './ground.ts';

export type {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function findingLine(finding: FeedbackFinding): string {
  const reviewer = finding.reviewer ? `${finding.reviewer} ` : '';
  const severity = finding.severity ?? 'blocking';
  const recommendation = finding.recommendation
    ? ` Recommendation: ${oneLine(finding.recommendation)}`
    : '';
  return `- ${reviewer}[${severity}]: ${oneLine(finding.evidence)}${recommendation}`;
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
  };
}

export function revisionRequest(
  input: RevisionRequestInput,
  over: Partial<Outcome> = {},
): Outcome {
  const revision = normalizeRevision(input);
  const kick =
    revision.target !== undefined
      ? { to: revision.target, reason: revision.reason }
      : undefined;
  return {
    status: over.status ?? 'fail',
    confidence: over.confidence,
    summary: over.summary ?? revision.reason,
    data: over.data ?? { revisionRequest: revision },
    error: over.error,
    kickback: over.kickback ?? kick,
    revision,
  };
}

export function kickback(
  to: string,
  reason: string,
  over: Partial<Outcome> = {},
): Outcome {
  return revisionRequest(
    { target: to, reason, rerun: 'target-and-dependents' },
    { ...over, kickback: { to, reason } },
  );
}

export function revisionFromOutcome(outcome: Outcome): RevisionRequest | undefined {
  if (outcome.revision) return outcome.revision;
  if (outcome.kickback)
    return {
      target: outcome.kickback.to,
      reason: outcome.kickback.reason,
      rerun: 'target-and-dependents',
    };
  const data = outcome.data;
  if (isRecord(data) && isRecord(data.revisionRequest)) {
    const r = data.revisionRequest as Record<string, unknown>;
    if (typeof r.reason === 'string') {
      return {
        reason: r.reason,
        target: typeof r.target === 'string' ? r.target : undefined,
        findings: Array.isArray(r.findings)
          ? (r.findings as FeedbackFinding[])
          : undefined,
        rerun:
          r.rerun === 'target-and-dependents'
            ? 'target-and-dependents'
            : undefined,
        source: typeof r.source === 'string' ? r.source : undefined,
      };
    }
  }
  return undefined;
}

export function feedbackBlock(outcome: Outcome): string {
  const revision = revisionFromOutcome(outcome);
  const parts = [
    '## Feedback to address',
    'A review or downstream stage requested another pass. Address this before unrelated work.',
  ];
  if (revision?.target) parts.push(`Target: ${revision.target}`);
  if (revision?.source) parts.push(`Source: ${revision.source}`);
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
  | { name?: string; review: ConditionInput; severity?: FeedbackSeverity }
  | { name?: string; job: Job; severity?: FeedbackSeverity };

export interface ReviewPanelConfig {
  label?: string;
  reviewers: ReviewTarget[];
  /** Default `all`: every blocking reviewer must pass. A number means k-of-n. */
  pass?: 'all' | number;
  /** When set, a failing panel emits a targeted revision request for dag routing. */
  target?: string;
  rerun?: RevisionRerun;
}

interface ReviewResult {
  name: string;
  severity: FeedbackSeverity;
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
  const severity = reviewer.severity ?? 'blocking';
  if ('job' in reviewer) {
    const outcome = await reviewer.job(ctx);
    return {
      name,
      severity,
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
    severity,
    met: result.met,
    confidence: result.confidence,
    reason: result.reason,
  };
}

function reviewFinding(result: ReviewResult): FeedbackFinding {
  return {
    reviewer: result.name,
    severity: result.severity,
    evidence: result.reason,
  };
}

export function reviewPanel(config: ReviewPanelConfig): Job {
  const label = config.label ?? 'review-panel';
  const job: Job = async (ctx) => {
    ctx.emit({ kind: 'job:start', ts: Date.now(), path: [...ctx.path], label });
    const results = await Promise.all(
      config.reviewers.map((reviewer, i) => runReviewer(reviewer, i, ctx)),
    );
    const blocking = results.filter((r) => r.severity === 'blocking');
    const blockingPassed = blocking.filter((r) => r.met).length;
    const required =
      config.pass === undefined || config.pass === 'all'
        ? blocking.length
        : config.pass;
    const findings = results.filter((r) => !r.met).map(reviewFinding);
    const passed = blockingPassed >= required;
    const summaryHead = `Review panel: ${blockingPassed}/${blocking.length} blocking reviewer(s) cleared`;
    const summary = findings.length
      ? `${summaryHead}.\n${findings.map(findingLine).join('\n')}`
      : `${summaryHead}.`;
    const confidence = results.length
      ? results.reduce((sum, r) => sum + (r.confidence ?? 0), 0) / results.length
      : undefined;
    const data = { findings, results, passed: blockingPassed, required };
    const outcome: Outcome = passed
      ? { status: 'pass', summary, confidence, data }
      : revisionRequest(
          {
            target: config.target,
            reason: summary,
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}\n...` : text;
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
    const sections: string[] = [];

    if (config.tests) {
      if (config.tests === true) {
        const lines: string[] = [];
        if (last?.status) lines.push(`Last outcome status: ${last.status}`);
        if (last?.summary) lines.push(`Last outcome summary: ${last.summary}`);
        if (last?.data !== undefined)
          lines.push(`Last outcome data: ${JSON.stringify(last.data, null, 2)}`);
        if (lines.length) sections.push(`## Test and outcome context\n\n${lines.join('\n')}`);
      } else {
        const cwd = config.tests.cwd ?? ctx.workspace.dir;
        const result = await execa(config.tests.command, config.tests.args ?? [], {
          cwd,
          reject: false,
          stripFinalNewline: false,
          cancelSignal: ctx.signal,
        });
        sections.push(
          `## Test command\n\n${config.tests.command} ${(config.tests.args ?? []).join(' ')}\n\n` +
            `exit: ${result.exitCode ?? 0}\n\nstdout:\n${truncate(result.stdout, max)}\n\nstderr:\n${truncate(result.stderr, max)}`,
        );
      }
    }

    if (config.diff) {
      const diff = await gitOutput(
        ctx.workspace.dir,
        ['diff', 'HEAD', '--'],
        ctx.signal,
      ).catch(() => '');
      if (diff) sections.push(`## Git diff\n\n${truncate(diff, max)}`);
    }

    if (config.files?.length) {
      const files = await resolveFiles(ctx, config.files);
      for (const file of files) {
        const path = join(ctx.workspace.dir, file);
        if (!existsSync(path)) continue;
        sections.push(
          `## File: ${file}\n\n${truncate(readFileSync(path, 'utf8'), max)}`,
        );
      }
    }

    if (config.ledger) {
      const live = [readPrompt(ctx.workspace), readLedger(ctx.workspace)]
        .filter(Boolean)
        .join('\n\n');
      if (live) sections.push(`## Live ledger\n\n${truncate(live, max)}`);
      const committed = await groundingText(ctx.workspace, {
        max: 5,
        bodyChars: 1200,
        signal: ctx.signal,
      }).catch(() => '');
      if (committed) sections.push(truncate(committed, max));
    }

    return sections.join('\n\n---\n\n') || '(no review context)';
  };
}
