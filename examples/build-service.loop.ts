/**
 * An engineering TEAM, defined as files.
 *
 * Four specialists build a small service with cross-cutting contracts only one of them
 * decides (stable ids, the `SSv1|` snapshot wire tag). Each engineer is an `AgentDef`, and a
 * component is "done" only when its deterministic test passes AND a five-lens, report-only
 * review battery clears it — each reviewer a named specialist that closes with a
 * `<confidence>N%</confidence>`, the adversarial lens running on a DIFFERENT model (codex /
 * GPT-5) for genuinely different priors. A failing review hands its findings to the next
 * iteration (the fix-up loop), so the team converges by addressing concrete concerns, never by
 * grading its own homework.
 *
 *   - The `dag` is the manager: toposort + dispatch.
 *   - Each node is a Converge loop: build to the test (`until`), then clear the battery (`review`).
 *   - `isolate` runs serialize in its own worktree, parallel with api, landed back on pass.
 *   - `ground: true` carries the store's contracts to the engineers (and reviewers) downstream.
 *
 *   loops run examples/build-service.loop.ts --engine claude-cli
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defineJob,
  dag,
  loop,
  agentJob,
  agentCheck,
  commandSucceeds,
  defineAgent,
  defineSkill,
  fromFile,
  groundingText,
  type JobContext,
  type Job,
  type Outcome,
} from '../src/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = (p: string) => join(HERE, 'build-service', p);

// Shared engineer methodologies, authored as markdown and folded into each agent's system.
const tdd = defineSkill({ name: 'tdd', instructions: fromFile(file('skills/tdd.md')) });
const contractFirst = defineSkill({
  name: 'contract-first',
  instructions: fromFile(file('skills/contract-first.md')),
});

// One engineer per component: persona in markdown, structure typed here.
export const engineerFor = (name: string) =>
  defineAgent({
    name: `${name}-engineer`,
    system: fromFile(file(`agents/${name}-engineer.md`)),
    skills: [tdd, contractFirst],
  });

// One reviewer per lens: a report-only specialist persona that closes with <confidence>N%</confidence>.
export const reviewerAgent = (lens: string) =>
  defineAgent({ name: `${lens}-reviewer`, system: fromFile(file(`agents/reviewers/${lens}.md`)) });

// The evidence each reviewer judges: the actual source under review plus the project's
// recorded decisions (the contracts, via grounding) — the same context the engineer had.
// A judge that cannot see the artifact cannot honestly confirm it.
export const reviewEvidence = (name: string) => async (ctx: JobContext) => {
  let src = '(source missing — nothing was written)';
  try {
    src = readFileSync(join(ctx.workspace.dir, `${name}.mjs`), 'utf8');
  } catch {
    /* the engineer wrote nothing — the reviewer should see that and refuse */
  }
  const contracts = await groundingText(ctx.workspace);
  return (
    `PROJECT DECISIONS (the contracts to honour):\n${contracts || '(none recorded yet)'}\n\n` +
    `SOURCE of ${name}.mjs under review:\n\`\`\`js\n${src}\n\`\`\``
  );
};

/** One lens as a `<confidence>%`-reporting review condition over the component's evidence. */
export const reviewer = (
  name: string,
  lens: string,
  opts: { engine?: string; model?: string; threshold?: number },
) =>
  agentCheck({
    agent: reviewerAgent(lens),
    engine: opts.engine,
    model: opts.model,
    confidenceTag: true,
    threshold: opts.threshold ?? 0.9,
    context: reviewEvidence(name),
    question:
      `Review the ${name} component (its deterministic test already passes) against the ` +
      `project contracts in the evidence.`,
  });

// The review battery — five near-disjoint lenses. Different blind spots find more than one
// reviewer cloned across models. The bar is unanimous: every lens must clear `THRESHOLD`.
// 0.8 is where honest correct-work confidence lands — the inherently-cautious adversarial and
// security lenses sit ~0.82 on correct code while a real violation scores ~0.1, so 0.8 passes
// correct work unanimously and blocks a violation by a wide margin.
const THRESHOLD = 0.8;

// Thoroughness vs cost is a dial, not a rewrite — add/remove lenses, pick the model per lens.
// The adversarial lens runs on a genuinely DIFFERENT model: codex (GPT-5) by default for the
// real second-model signal; set LOOPS_ADVERSARIAL_ENGINE=claude to trade it for speed/cost.
const adversarialLens: { lens: string; engine?: string; model?: string } =
  process.env.LOOPS_ADVERSARIAL_ENGINE === 'claude'
    ? { lens: 'adversarial', model: process.env.LOOPS_ADVERSARIAL_MODEL || 'opus' }
    : { lens: 'adversarial', engine: 'codex' };

const PANEL: Array<{ lens: string; engine?: string; model?: string }> = [
  adversarialLens,
  { lens: 'security', model: 'opus' },
  { lens: 'correctness', model: 'sonnet' },
  { lens: 'conformance', model: 'opus' },
  { lens: 'simplicity', model: 'haiku' },
];

/**
 * Run the whole battery; pass only when EVERY lens clears the bar (the unanimous Ship Gate).
 * A failing review composes its findings into the outcome, which the loop threads to the next
 * iteration as `ctx.lastReview` — so the engineer addresses concrete concerns (the fix-up loop)
 * rather than self-grading.
 */
export const reviewPanel =
  (name: string): Job =>
  async (ctx): Promise<Outcome> => {
    const results = await Promise.all(
      PANEL.map(async (p) => {
        const r = await reviewer(name, p.lens, {
          engine: p.engine,
          model: p.model,
          threshold: THRESHOLD,
        })(ctx, ctx.lastOutcome);
        return { lens: p.lens, met: r.met, confidence: r.confidence ?? 0, reason: r.reason };
      }),
    );
    const cleared = results.filter((r) => r.met).length;
    const lines = results.map(
      (r) =>
        `- ${r.lens}: ${r.met ? 'CLEARED' : 'BLOCKING'} (${Math.round(r.confidence * 100)}%) — ${r.reason}`,
    );
    return {
      status: cleared === results.length ? 'pass' : 'fail',
      confidence: results.reduce((a, r) => a + r.confidence, 0) / results.length,
      summary: `Review battery for ${name}: ${cleared}/${results.length} lenses cleared ${Math.round(
        THRESHOLD * 100,
      )}%.\n${lines.join('\n')}`,
    };
  };

const engineer = (name: string) =>
  loop({
    name,
    body: agentJob({ agent: engineerFor(name), prompt: fromFile(file(`briefs/${name}.md`)), ground: true }),
    until: commandSucceeds('node', [`test-${name}.mjs`]), // deterministic truth
    review: reviewPanel(name), // the report-only battery; a fail re-enters with the findings
    commit: true,
    max: 8,
    maxReviewRestarts: 4,
  });

export default defineJob(
  dag({
    name: 'build-service',
    nodes: {
      store: engineer('store'),
      api: { needs: ['store'], job: engineer('api') },
      serialize: { needs: ['store'], isolate: true, job: engineer('serialize') }, // parallel worktree
      client: { needs: ['api', 'serialize'], job: engineer('client') },
    },
    isolation: 'worktree',
  }),
);
