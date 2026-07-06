/**
 * Generic feature-development loop.
 *
 * Offline by default, so it is cheap to validate and dogfood. Set
 * LOOPS_LIVE_AGENTS=1, or use examples/feature-dev.ts --live-agents, to run the
 * implementation and review steps through real engines.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  agentCheck,
  agentJob,
  dag,
  defineJob,
  fnJob,
  humanGate,
  predicate,
  prove,
  reviewPanel,
  type Condition,
  type Job,
  type JobContext,
} from '../src/api.ts';

const env = process.env;

function value(name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function csv(name: string, fallback: string[]): string[] {
  const raw = value(name);
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length ? values : fallback;
}

function flag(name: string, fallback = false): boolean {
  const raw = value(name);
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^-+|-+$)/g, '') || 'feature';
}

function normalizeEngine(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const normalized = input.toLowerCase();
  if (normalized === 'claude') return 'claude-cli';
  return input;
}

function engineFamily(engine: string | undefined): 'codex' | 'claude' | 'other' {
  const normalized = engine?.toLowerCase() ?? '';
  if (normalized.includes('codex')) return 'codex';
  if (
    normalized.includes('claude') ||
    normalized.includes('anthropic') ||
    normalized === 'agent-sdk'
  )
    return 'claude';
  return 'other';
}

function oppositeReviewerEngine(mainEngine: string | undefined): string {
  return engineFamily(mainEngine) === 'codex' ? 'claude-cli' : 'codex';
}

function defaultModel(engine: string | undefined): string | undefined {
  return engineFamily(engine) === 'claude' ? 'opus' : undefined;
}

function featureBrief(): string {
  const file = value('LOOPS_FEATURE_BRIEF_FILE');
  if (file) return readFileSync(resolve(file), 'utf8');
  return (
    value('LOOPS_FEATURE_BRIEF') ??
    value('LOOPS_FEATURE_PROMPT') ??
    'Implement the requested feature with a small diff, tests, and clear evidence.'
  );
}

const featureName = value('LOOPS_FEATURE_NAME') ?? 'feature-dev';
const featureSlug = slug(featureName);
const actionableScopes = csv('LOOPS_ACTIONABLE_SCOPES', ['implementation']);
const outputDir = resolve(
  value('LOOPS_PROOF_DIR') ?? join(tmpdir(), `loops-${featureSlug}`),
);
const proofPath = join(outputDir, `${featureSlug}-proof.html`);
const gateName = value('LOOPS_GATE_NAME') ?? `${featureSlug}-checkpoint`;
const requireGate = flag('LOOPS_REQUIRE_GATE', true);
const liveAgents = flag('LOOPS_LIVE_AGENTS');
const configuredMainEngine = normalizeEngine(value('LOOPS_MAIN_ENGINE'));
const mainModel = value('LOOPS_MAIN_MODEL');
const configuredAdversarialEngine = normalizeEngine(
  value('LOOPS_ADVERSARIAL_ENGINE'),
);
const configuredAdversarialModel = value('LOOPS_ADVERSARIAL_MODEL');

const setup = fnJob('setup', async (ctx) => {
  const prior = typeof ctx.state.setupRuns === 'number' ? ctx.state.setupRuns : 0;
  ctx.state.setupRuns = prior + 1;
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, 'config.json'),
    `${JSON.stringify(
      {
        featureName,
        gateName,
        actionableScopes,
        proofPath,
        liveAgents,
        mainEngine: configuredMainEngine ?? ctx.engine.name,
        adversarialEngine: adversarialEngine(ctx),
        adversarialModel: adversarialModel(ctx),
      },
      null,
      2,
    )}\n`,
  );
  return { status: 'pass', summary: `prepared ${featureName}` };
});

const gate = humanGate({
  name: gateName,
  prompt: `Acknowledge the checkpoint before developing ${featureName}.`,
});

const resumeCheck = fnJob('resume-check', async (ctx) => {
  if (ctx.state.setupRuns === 1)
    return { status: 'pass', summary: 'checkpoint restored setup node' };
  return {
    status: 'fail',
    summary: `expected setupRuns=1, got ${String(ctx.state.setupRuns)}`,
  };
});

const offlineImplement = fnJob('implement', async () => {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, 'implementation.md'),
    [
      `# ${featureName}`,
      '',
      '## Brief',
      featureBrief(),
      '',
      '## Work',
      'Offline placeholder implementation completed.',
      '',
    ].join('\n'),
  );
  return { status: 'pass', summary: `implemented ${featureName}` };
});

const liveImplement = agentJob({
  label: 'implement',
  engine: configuredMainEngine,
  model: mainModel,
  ground: true,
  consumeFeedback: true,
  graphContext: true,
  prompt: () =>
    [
      `Feature: ${featureName}`,
      '',
      featureBrief(),
      '',
      `Actionable scopes: ${actionableScopes.join(', ')}`,
      `Write implementation evidence under ${outputDir}.`,
      'Keep the change small, run the relevant checks, and leave a concise summary.',
    ].join('\n'),
});

const implement: Job = liveAgents ? liveImplement : offlineImplement;

const verify = fnJob('verify', async () => {
  const artifact = join(outputDir, 'implementation.md');
  if (!liveAgents && !existsSync(artifact))
    return { status: 'fail', summary: `missing implementation evidence at ${artifact}` };
  writeFileSync(join(outputDir, 'verify.txt'), 'verification passed\n');
  return { status: 'pass', summary: 'verification passed' };
});

function mainEngine(ctx: JobContext): string {
  return configuredMainEngine ?? ctx.engine.name;
}

function adversarialEngine(ctx: JobContext): string {
  return configuredAdversarialEngine ?? oppositeReviewerEngine(mainEngine(ctx));
}

function adversarialModel(ctx: JobContext): string | undefined {
  return configuredAdversarialModel ?? defaultModel(adversarialEngine(ctx));
}

function reviewEvidence(ctx: JobContext): string {
  const implementationPath = join(outputDir, 'implementation.md');
  const implementation = existsSync(implementationPath)
    ? readFileSync(implementationPath, 'utf8')
    : '(no offline implementation artifact; inspect the workspace diff and run evidence)';
  return [
    `Feature: ${featureName}`,
    `Workspace: ${ctx.workspace.dir}`,
    `Actionable scopes: ${actionableScopes.join(', ')}`,
    '',
    'Implementation evidence:',
    implementation,
  ].join('\n');
}

function offlineReview(name: string, reason: string): Condition {
  return async () => ({ met: true, confidence: 0.95, reason: `${name}: ${reason}` });
}

function liveReview(
  name: string,
  question: string,
  opts: (ctx: JobContext) => { engine?: string; model?: string },
): Condition {
  return (ctx, last) =>
    agentCheck({
      question,
      confidenceTag: true,
      threshold: 0.85,
      engine: opts(ctx).engine,
      model: opts(ctx).model,
      context: reviewEvidence,
    })(ctx, last);
}

const reviewer = (
  name: string,
  question: string,
  offlineReason: string,
  opts: (ctx: JobContext) => { engine?: string; model?: string },
): Condition =>
  liveAgents ? liveReview(name, question, opts) : offlineReview(name, offlineReason);

const review = reviewPanel({
  label: 'feature-review',
  concurrency: 4,
  actionableScopes,
  reviewers: [
    {
      name: 'correctness',
      scope: 'implementation',
      review: reviewer(
        'correctness',
        'Does the feature implementation satisfy the brief with adequate tests and no obvious regression?',
        'brief, tests, and regression evidence are present',
        (ctx) => ({ engine: mainEngine(ctx), model: mainModel }),
      ),
    },
    {
      name: 'simplicity',
      scope: 'implementation',
      review: reviewer(
        'simplicity',
        'Is the implementation appropriately small and free of speculative abstraction?',
        'implementation is intentionally small',
        (ctx) => ({ engine: mainEngine(ctx), model: mainModel }),
      ),
    },
    {
      name: 'scope',
      scope: 'implementation',
      review: reviewer(
        'scope',
        `Is the change confined to the actionable scopes: ${actionableScopes.join(', ')}?`,
        'change stays inside the declared scope',
        (ctx) => ({ engine: mainEngine(ctx), model: mainModel }),
      ),
    },
    {
      name: 'adversarial',
      scope: 'implementation',
      review: reviewer(
        'adversarial',
        'Find the strongest reason this feature should not ship. Approve only if no blocker survives inspection.',
        'no blocking counterexample found',
        (ctx) => ({
          engine: adversarialEngine(ctx),
          model: adversarialModel(ctx),
        }),
      ),
    },
  ],
});

const proof = prove(`${featureSlug}-proof`, () => {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    proofPath,
    [
      '<!doctype html>',
      '<html>',
      `<head><meta charset="utf-8"><title>${featureName} proof</title></head>`,
      '<body>',
      `<h1>${featureName} proof</h1>`,
      '<p>Checkpoint resume, implementation, verification, review, and proof records passed.</p>',
      `<p>Actionable scopes: ${actionableScopes.join(', ')}</p>`,
      `<p>Adversarial reviewer engine: ${configuredAdversarialEngine ?? 'opposite of main engine'}</p>`,
      '</body>',
      '</html>',
      '',
    ].join('\n'),
  );
  return {
    kind: 'html',
    path: proofPath,
    title: `${featureName} proof`,
    description: 'Feature-development verification proof page',
  };
});

export default defineJob(
  dag({
    name: featureSlug,
    nodes: {
      setup,
      gate: {
        needs: ['setup'],
        when: predicate(() => requireGate, 'checkpoint gate enabled'),
        job: gate,
      },
      'resume-check': { needs: ['gate'], job: resumeCheck },
      implement: { needs: ['resume-check'], job: implement },
      verify: { needs: ['implement'], job: verify },
      review: { needs: ['verify'], job: review },
      proof: { needs: ['review'], job: proof },
    },
  }),
);
