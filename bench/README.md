# Loops Benchmarks

This directory is the proof surface for Loops' Ledger thesis:

> Engineering memory should be verified work in git, not a parallel memory store.

The benchmarks ask whether Ledger grounding changes outcomes when work crosses a
context boundary: a retry loop, a graph node boundary, a sweep of independent
items, or a related issue that should reuse prior experience.

## Start Here

Read the measured results first:

```bash
open bench/RESULTS.md
```

Then run the cheapest wiring checks:

```bash
npm run bench:wow
npm run bench:report:sample
npm run bench:context:dry
```

`bench:wow` is the one-command mechanism demo: two deterministic runs, same files
and public prompts, but only the grounded arm reads the upstream contract from git
memory and passes the hidden gate. It is not a statistical benchmark.
`bench:report:sample` renders a synthetic checked-in result so the reporter is
verifiable in a fresh clone; it is not benchmark evidence. `bench:context:dry`
uses the mock engine path in `swecontextbench.ts`; it validates the acquisition,
prompt-shaping, and prediction-output wiring without spending model tokens.

## Local Live Runs

These commands drive a real coding agent through `claude-cli`, so they need local
Claude auth and will spend subscription/API capacity depending on your setup.

```bash
# Ledger ON/OFF across retry-loop tasks
npm run bench:ab
npm run bench:report -- bench/results.json

# Cross-node graph contract, where the upstream decision lives only in git history
BENCH_GRAPH_TASK=graph-tasks/stable-store-contract BENCH_TRIALS=10 BENCH_MODEL=haiku \
  npm run bench:graph
npm run bench:report -- bench/results-graph.json
```

The headline is always `ON - OFF`: same task, same model, same gate, varying only
Ledger grounding.

## Benchmark Map

| File | Question | Run |
|---|---|---|
| `ab.ts` | Does Ledger help a retry loop recover from failed attempts? | `npm run bench:ab` |
| `graph.ts` | Does Ledger carry upstream decisions across agent graph nodes? | `npm run bench:graph` |
| `wow.ts` | Can a fresh clone see the cross-node memory mechanism without model spend? | `npm run bench:wow` |
| `sweep.ts` | Does Ledger keep independent batch work consistent? | `npx tsx bench/sweep.ts` |
| `swebench.ts` | Does Ledger improve SWE-bench resolve@K? | `npx tsx bench/swebench.ts` |
| `swecontextbench.ts` | Does distilled experience help related issues? | `npm run bench:context:dry` for wiring, then `bench/contextbench/RUNBOOK.md` |
| `baseline.ts` | Does Loops beat or match vanilla orchestration baselines? | `npx tsx bench/baseline.ts` |

## Scale Runs

Use Linux x86 for public numbers. The local arm64 path is useful for harness
iteration, but canonical SWE-bench and SWE-ContextBench runs need native Docker
evaluation and enough parallelism.

- SWE-bench scale path: `bench/gcp/RUNBOOK.md`
- SWE-ContextBench scale path: `bench/contextbench/RUNBOOK.md`

## Interpreting Results

Ledger is expected to be a tax when one attempt is enough. The lift should appear
when the task crosses a boundary where the next agent turn cannot infer the prior
reason from files alone.

Useful claims:

- ON improves resolve rate.
- ON reduces regressions between attempts.
- ON carries an unguessable upstream contract across graph nodes.
- ON keeps a sweep consistent across independent items.
- ON costs more tokens but buys reliability in boundary-heavy work.

Weak claims:

- A one-shot task proves memory is useful.
- A small noisy slice gives a stable percentage-point lift.
- Pasting a tiny git log is a meaningful long-horizon baseline.
