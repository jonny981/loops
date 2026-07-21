# Getting started

`loops` is a library and CLI for driving AI agents in **convergence loops**: do a bit of work with a fresh context, check whether it is *actually* done against a gate you define, and if not, go again. Loops compose into dependency graphs, graphs can be rewritten while they run, and progress accumulates in git — so work of any size, up to and including work that never ends, stays inspectable and trustworthy.

## Installation

::: code-group

```bash [npm]
npm install @loops-adk/core
```

```bash [pnpm]
pnpm add @loops-adk/core
```

:::

Requires Node.js 20 or later. The package ships compiled ESM with full type declarations.

## Your first loop

A loop definition is a TypeScript file with a default export. This one drives an agent toward a task file until the tests pass **and** an independent judge agrees the intent was met:

```ts
// build.loop.ts
import {
  defineJob,
  loop,
  agentJob,
  agentCheck,
  commandSucceeds,
} from '@loops-adk/core';

export default defineJob(
  loop({
    name: 'build',
    body: agentJob({
      prompt: (c) => `Iteration ${c.iteration}: make concrete progress on TASK.md.`,
      ground: true, // read the commit log and notes before working
    }),
    until: [
      commandSucceeds('npm', ['test']),                                    // the truth
      agentCheck({ question: 'Does it match TASK.md?', threshold: 0.85 }), // the intent
    ],
    max: 12,
    commit: { subject: 'feat: TASK.md' }, // one commit on convergence, reasoning included
  }),
);
```

Run it:

```bash
npx loops validate build.loop.ts   # offline pre-flight: loads and checks, runs nothing
npx loops run build.loop.ts        # execute, with a live TUI
```

Three rules hold everywhere in the library:

- **"Done" is checked, not claimed.** The tests must pass, and a separate judge reviews the result. The model never grades its own work.
- **Every attempt starts fresh.** Progress lives in files and commits, not a growing chat history.
- **Git is the memory.** Decisions are written into commit messages and read back on the next attempt.

## Exit codes

The CLI maps every terminal outcome to a distinct exit code, so wrappers and CI can react precisely:

| Code | Outcome | Meaning |
|---|---|---|
| `0` | `pass` | the gate passed (and the review, if configured) |
| `1` | `fail` | the work ran but did not achieve its goal |
| `2` | `exhausted` | the iteration cap or a stall detector ended the loop |
| `75` | `paused` | a human gate, a limit, or an operator pause — **resumable** |
| `130` | `aborted` | a signal or `stopOn` cut the work short |

## Where next

- [Core concepts](/guide/concepts) — the mental model in four verbs and two tenets.
- [Loops and gates](/guide/loops) — everything a `loop()` can do.
- [Graphs](/guide/graphs) — stages, dependencies, parallel worktrees.
- [Steering](/guide/steering) — rewriting a running graph.
- [API reference](/api/) — every export, generated from the source types.
