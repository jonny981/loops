---
name: design-agent-team
description: Use when composing a team of specialist agents in a loops `dag`: defining an `AgentDef`, folding in `defineSkill` methodologies, wiring review feedback (`reviewPanel`/`consumeFeedback`/`revisionRequest`), and gating nodes so the graph orchestrates and the agents stay workers, never dispatchers. Load this before turning a loop into a multi-agent team.
---

# Designing an agent team

A `dag` of specialist agents is a team. The load-bearing rule that keeps it a team and not a swarm:

**The graph orchestrates; agents do not.** The `dag` is the manager (toposort + dispatch), `Condition`/`quorum` are the gates, `Outcome` is the result channel. An `AgentDef` is only the *contract*: who the agent is, what it may touch, how it works. It carries no scheduling authority. An agent produces an `Outcome`; the graph decides what runs next. Never build an agent whose job is to dispatch other agents; make the graph do it.

**REQUIRED BACKGROUND:** you compose these agents into a loop/dag. Read `skills/author-loop/SKILL.md` for the loop mental model, the honest gate, and git-memory first.

## Two builders: a skill is a method, an agent is a worker

- `defineSkill({ name, instructions })` is a **methodology** (how to work: TDD, writing-plans). Prose only. A skill never dispatches an agent.
- `defineAgent({ ... })` is a **worker**: a persona plus its contract. It *composes* skills; the skills' instructions fold into its system prompt.

Persona and methodology live in editable markdown (`fromFile`); structure and types live in TS. The `.ts` is the typed wrapper around the `.md`.

```ts
import { defineAgent, defineSkill, fromFile, agentJob } from '@loops-adk/core';

const tdd = defineSkill({
  name: 'tdd',
  instructions: fromFile(new URL('./skills/tdd.md', import.meta.url)),
});

const storeEngineer = defineAgent({
  name: 'store-engineer',
  system: fromFile(new URL('./agents/store-engineer.md', import.meta.url)), // persona, as markdown
  model: 'sonnet',
  tools: ['edit', 'bash'],        // the permission boundary
  leaf: true,                     // may not spawn sub-agents; bottoms the branch out here
  tier: 'worker',                 // contract metadata (no scheduling power)
  capabilities: ['storage engine', 'id stability'],
  outputs: [{ name: 'patch' }, { name: 'test-report' }],
  skills: [tdd],                  // methodologies fold into the system
  requiresSkills: ['contract-first'], // metadata unless also in `skills`
  usesSkills: ['small-diff'],
  humanGates: [{ name: 'prod-approval', when: 'deploying production changes' }],
  failureModes: [{ mode: 'tests-flaky', recovery: 'isolate the flake, retry once', severity: 'should-fix' }],
});
```

`agentJob({ agent: storeEngineer, prompt, ground: true })` resolves the def into the engine request (`system` = persona + folded skills, plus `model`/`tools`). Inline `system`/`model`/`tools`/`allowedTools` on the `agentJob` still override the def. The contract fields beyond `system`/`model`/`tools` are **optional metadata** for validation, `loops describe`, docs, and future discovery. They change nothing at runtime; they do not grant dispatch authority.

**`leaf` is the fan-out brake.** A leaf agent cannot spawn sub-agents (the engine withholds the sub-agent tool). Use it to stop a thorough worker from quietly expanding into a slow, expensive swarm. The team's shape stays the graph you drew, not one the agent invents.

## Wire the team as a graph

```ts
import { dag, loop, agentJob, gateJob, quorum, agentCheck, commandSucceeds } from '@loops-adk/core';

dag({
  name: 'ship',
  nodes: {
    store:  loop({ name: 'store', body: agentJob({ agent: storeEngineer, prompt: 'Build the store to its tests.', ground: true }), until: commandSucceeds('npm', ['test']) }),
    api:    { needs: ['store'], job: loop({ /* apiEngineer, same shape */ }) },
    review: { needs: ['api'], job: gateJob('review', quorum(2,
      agentCheck({ agent: securityReviewer, question: 'Is it safe?' }),
      agentCheck({ agent: correctnessReviewer, question: 'Is it correct?' }),
    )) },
  },
});
```

Each engineer is a Converge loop (build to a `test` gate); reviewers are gates. `quorum(k, ...)` is a k-of-n jury; `gateJob(name, condition)` turns a `Condition` into a `Job` so it can be a node. Because a reviewer is just an agent and `agentCheck` takes an `engine`/`model`, any reviewer runs on any model, so put the adversarial lens on a second model for a genuinely independent signal.

## Feedback is a loop boundary, not a back-edge

Review findings are structured, and they flow back to the worker on the same channel whether they come from a loop's `review` slot or a dag kickback.

**In a loop:** a failing `review` outcome is threaded into the next body turn as `ctx.lastReview`. Set `consumeFeedback: true` so the worker reads it without you hand-writing "address the feedback" into every prompt:

```ts
const implement = agentJob({ agent: implementationAgent, prompt: brief, consumeFeedback: true });
```

**Aggregate several reviewers** with `reviewPanel`. Every reviewer is a gate: the panel passes when all of them clear, or `pass: N` of them (k-of-n). An empty panel is a construction error. Give each reviewer real evidence with `reviewContext`:

```ts
import { reviewPanel, reviewContext, agentCheck } from '@loops-adk/core';

const review = reviewPanel({
  pass: 2, // optional: k-of-n instead of all
  reviewers: [
    { name: 'security',    review: agentCheck({ question: 'Is it safe?',    context: reviewContext({ diff: true, ledger: true }) }) },
    { name: 'correctness', review: agentCheck({ question: 'Is it correct?', context: reviewContext({ tests: { command: 'npm', args: ['test'] } }) }) },
    { name: 'simplicity',  review: agentCheck({ question: 'Is it simple?',  context: reviewContext({ files: ['src/**'] }) }) },
  ],
});
```

A failing panel emits a `revisionRequest` carrying each failing reviewer's concern as a finding, threaded into the next pass.

**Route feedback across a DAG** with a targeted revision. When `DagConfig.maxKickbacks > 0`, a `revisionRequest({ target, findings })` (or the terse `kickback(to, reason)`) re-runs the target node and its transitive dependents, threading the reason in as their `lastReview`. Constrain valid targets with `DagNode.acceptsKickbackTo`. Because every cycle is a bounded re-run, not a graph edge, it always terminates.

Give a worker just enough map to act on routed feedback without seeing the whole orchestration, with `graphContext: true`, which appends a small block naming this node, its direct dependencies, and its direct dependents.

## Verify the contract before spending a turn

```bash
loops validate team.loop.ts          # loads + constructs, no model calls
loops describe team.loop.ts --json   # the shape, incl. each agent node's contract (tier, outputs, failure modes)
```

`describe --json` reflects the contract you declared back at you, so you confirm the team you built is the team you meant. To watch or supervise the team once it runs, see `skills/supervise-loop-run/SKILL.md`.
