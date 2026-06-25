/**
 * An engineering TEAM, defined as files.
 *
 * Four specialists build a small service with cross-cutting contracts only one of them
 * decides (stable ids, the `SSv1|` snapshot wire tag). Each engineer is an `AgentDef` — a
 * markdown persona plus shared skills — and converges only when the deterministic tests pass
 * AND an adversarial panel across THREE models agrees, each reviewer prompted to REFUTE.
 *
 *   - The `dag` is the manager: it toposorts the components and dispatches them.
 *   - Each node is a Converge `loop` = one engineer driving its component to green + review.
 *   - `isolate` runs serialize in its own worktree, in parallel with api, landed back on pass.
 *   - `ground: true` carries the store's contracts to the engineers downstream of it.
 *
 * A single autonomous agent grades its own homework. This team cannot: a component is "done"
 * only past an independent, multi-model, dimensional review it never applies to itself. That
 * enforced honest-convergence gate is the point; memory is one free pillar underneath it.
 *
 *   loops run examples/build-service.loop.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defineJob,
  dag,
  loop,
  agentJob,
  agentCheck,
  commandSucceeds,
  quorum,
  defineAgent,
  defineSkill,
  fromFile,
} from '../src/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = (p: string) => join(HERE, 'build-service', p);

// Shared methodologies, authored as markdown and folded into each agent's system.
const tdd = defineSkill({ name: 'tdd', instructions: fromFile(file('skills/tdd.md')) });
const contractFirst = defineSkill({
  name: 'contract-first',
  instructions: fromFile(file('skills/contract-first.md')),
});
const adversarial = defineSkill({
  name: 'adversarial-review',
  instructions: fromFile(file('skills/adversarial-review.md')),
});

// One reviewer persona, run across three models — diverse judges, one stance.
const reviewer = defineAgent({
  name: 'reviewer',
  system: fromFile(file('agents/reviewer.md')),
  skills: [adversarial],
});

// One engineer per component: persona in markdown, structure typed here.
const engineerFor = (name: string) =>
  defineAgent({
    name: `${name}-engineer`,
    system: fromFile(file(`agents/${name}-engineer.md`)),
    skills: [tdd, contractFirst],
  });

// An engineer is "done" only when the deterministic test passes AND 2 of 3 model-diverse
// adversarial reviewers, each scoring correctness/security/edge-cases, fail to refute it.
const reviewed = (name: string) => [
  commandSucceeds('node', [`test-${name}.mjs`]),
  quorum(
    2,
    ...['opus', 'sonnet', 'haiku'].map((model) =>
      agentCheck({
        agent: reviewer,
        model,
        threshold: 0.8,
        question:
          `Try to REFUTE that the ${name} component is correct, robust, and honours the ` +
          `project's contracts (read the history). Approve only if you cannot.`,
        dimensions: ['correctness', 'security', 'edge cases'],
      }),
    ),
  ),
];

const engineer = (name: string) =>
  loop({
    name,
    body: agentJob({ agent: engineerFor(name), prompt: fromFile(file(`briefs/${name}.md`)), ground: true }),
    until: reviewed(name),
    commit: true,
    max: 8,
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
