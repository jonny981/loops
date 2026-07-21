# Memory

Every attempt starts with a fresh context, so memory is not a growing chat history — it is the workspace itself, and above all **git commit bodies**: a diff welded to its why. Nothing durable is a side file.

## Write: ground and commit

```ts
agentJob({
  prompt: 'Implement the next increment.',
  ground: true,   // read the notes and commit log before working
})

loop({
  // ...
  commit: { subject: 'feat: search' }, // on convergence, write the why into the commit body
})
```

During iterations, working memory accumulates in scratch files (`.loops/ledger.md`, `.loops/prompt.md`) — write-ahead buffers that crystallise into the next commit body and reset. A commit is a **milestone**, not an iteration: the loop composes one structured commit from everything the iterations learned.

## Read: recent-N → retrieval → consolidation

As the log grows, reading it has to scale:

- **Recent-N** (default) — read the last N commits. Cheap; fails on a long or noisy log, where the load-bearing commit falls out of the window.
- **Retrieval** (`ground: { retrieve: true }`) — a cheap model selects the *relevant* commits by subject, reaching past the window. Each retrieved commit carries the full way: the diff, the why, the alternatives ruled out. Use it for long-horizon work.
- **Consolidation** (`consolidateJob`) — fold the history into a decision-preserving ledger: current state, open threads, and every accrued decision kept verbatim, committed as a commit body so grounding surfaces it like any milestone. This is what an indefinitely-running process needs to stay coherent: top-k retrieval fetches the k most relevant commits, not *everything you have decided*.

## Curated grounding

Feed steps two memories at once — the commit history and a curated brief from your own knowledge base:

```ts
implement: {
  needs: ['context'],
  job: agentJob({
    prompt: 'Implement the next increment from PLAN.md.',
    ground: {
      sources: ['BRIEF.md', 'ISSUE.md'],                              // declared, contained, capped
      curate: { engine: 'anthropic-api', model: 'claude-haiku-4-5' }, // one cheap turn keeps only what helps
    },
  }),
},
```

## Surviving the squash

`pushJob` / `pullRequestJob` / `mergeJob` keep the squash-merge body a consolidation of the branch, so the ledger survives even a squash — the permanent record any later agent can read back, as far back as it wants.
