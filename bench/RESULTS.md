# Ledger A/B — measured results

What the Ledger (loops' git-memory: grounding + per-iteration commits) does to
convergence, measured by running each task twice — Ledger ON vs OFF — same model,
same gate, varying only the memory. The currency is **ON − OFF**, the way GCC
isolates its git-context layer (+6.2pp on SWE-bench Verified, Claude Sonnet 80.2%
vs 74.0%, arXiv 2508.00031).

All runs are live (real `claude-cli` editing real files), not the offline mock.

## The one finding everything rests on

The Ledger is a **token tax when one attempt suffices, and earns its keep the
moment one attempt does not.** A single agent turn is itself a loop with test
feedback, so any task the agent can one-shot leaves the outer loop — where the
Ledger lives — with nothing to do. The lift appears only in the **multi-attempt
regime**: enough difficulty (or a weak enough model) that attempt 1 fails, so
attempt 2 has prior reasoning to ground on.

## Summary

| regime | OFF | ON | lift | ON token cost |
|---|---|---|---|---|
| trivial tasks (sonnet, 3 tasks) | 100% | 100% | +0pp | +2% |
| convergence suite (haiku, 40 runs) | 100% | 100% | +0pp | +72% |
| SWE-bench Lite requests (sonnet, n=6) | 100% (6/6) | 100% (6/6) | +0pp | +58% |
| **SWE-bench Lite requests (haiku, n=6)** | **67% (4/6)** | **100% (6/6)** | **+33pp** | **+6%** |
| graph cross-node (haiku, 3-node, n=10) | 70% (7/10) | 80% (8/10) | +10pp (within noise) | +33% |

The first three are **ceiling effects**: the model solves everything in one
attempt, both arms max out, the Ledger only adds cost. The fourth opens headroom
— a weaker model on real bugs — and the Ledger converts it. The fifth (cross-node)
is directionally positive but **inconclusive at n=10** — a single-instance gap (see
below).

## Cross-node (graph) detail

`bench/graph.ts`, task `stable-store`: a chain (remove → find → serialize) where an
upstream node establishes an id-stability invariant whose rationale lives only in
its commit body, not its code. Only ON grounds each node in the accumulated ledger,
so only ON reads the upstream why; OFF re-derives from the files. A hidden invariant
gate decides resolved.

Result (haiku, 10 trials/arm): OFF held 7/10, ON held 8/10 — **+10pp, a one-instance
gap, within noise.** Two leaks compress it: OFF preserves the invariant ~70% of the
time by default (the fence is judgment-based, and a careful agent often re-derives
it), and ON broke 2/10 (grounding delivered the why, but a weak model does not
always act on it). The mechanism is real at the trial level — we observed the why
prevent a break — but the aggregate is not a claim.

The sharper, more faithful test of what graphs actually need is a cross-node
**contract**: an arbitrary upstream convention (a wire format, a field naming, a
protocol version) the downstream node cannot guess. There OFF cannot hold (it never
saw the convention) and ON holds whenever grounding surfaces it and the agent
applies it — a wide, noise-robust gap that measures the real question: does the
Ledger propagate cross-node decisions. (A contract-based `stable-store-contract`
variant follows.)

## SWE-bench detail (the comparable number)

SWE-bench hides the tests from the agent by design, so one attempt genuinely often
is not enough — the regime where the Ledger can matter. Each instance is a real
GitHub bug; the agent sees only the issue and the code; the **official swebench
Docker harness** decides resolved (all FAIL_TO_PASS pass AND all PASS_TO_PASS still
pass). loops never grades its own work. Subset: `psf/requests` Lite instances, the
light repos that build arm64-native; resolve@2 via `bench/swebench.ts`.

**Haiku (the regime with headroom):**

- OFF resolved 4/6: `requests-{863, 2148, 2317, 3362}`.
- ON resolved 6/6: the same four **plus** `requests-1963` and `requests-2674`.
- ON is a strict superset of OFF — zero regressions. Memory helped the hard cases
  without breaking the easy ones.
- `requests-2674` is the mechanism in one instance: OFF sprawled to a 77-line patch
  and failed; ON, grounded on its first attempt's recorded reasoning, converged to
  a tighter 45-line patch that passed — using fewer tokens (28.7k vs 34.7k).
- Where it helped, the tax was only +6% tokens (vs +58–72% in the no-benefit
  regimes): the agent is doing more real work, so the grounding preamble is a
  smaller slice.

**Sonnet:** 6/6 both arms — a credible resolve-rate on real SWE-bench bugs, but a
ceiling: sonnet one-shots these six, so there is no failure for memory to recover.

## Honest limits

- **n = 6, single trial per arm.** The +33pp is a strong directional signal (strict
  superset, zero regression, a mechanistically coherent win on the hardest
  instance), **not a statistically significant figure.** A real number needs
  multiple trials per instance (resolve-rate, not one pass) across more instances.
- **Hardware bounds the difficulty band.** This is an arm64 Mac; only the light
  repos (`requests`, `flask`) build native, so the heavy, harder instances
  (django/sympy/…) where the effect should be larger were out of reach.
- The effect is **small and regime-dependent**, consistent with GCC needing 500
  instances to show +6.2pp. The git-memory thesis is real and independently
  converged on (GCC, Letta, DiffMem), not a novel moat. loops' edge is being
  small, legible, fast, and engine/workspace/environment agnostic — plus a
  validated instrument to measure the lift properly at scale.

## What this points to

The lift scales with the number of context boundaries the work crosses (loop
iterations, fan-out across agents, horizon beyond one context). Single-node,
one-shot work is the floor; deep agent graphs — many nodes, each needing the
*why* of upstream nodes, not just their files — are where the value should
compound. That is the next measurement.

## Reproduce

```bash
# Trivial baseline (sonnet)
BENCH_MODEL=sonnet npx tsx bench/ab.ts && npx tsx bench/report.ts

# Convergence suite (haiku, 5 trials)
BENCH_TASKS=tasks-hard BENCH_TRIALS=5 BENCH_MODEL=haiku BENCH_MAX_ITERS=5 \
  BENCH_OUT=results-hard.json npx tsx bench/ab.ts
npx tsx bench/report.ts bench/results-hard.json

# SWE-bench Lite resolve@2 (needs Docker; see bench/swebench.ts header for the
# DOCKER_HOST / DOCKER_CONFIG setup and the eval command)
BENCH_SWE_INSTANCES=<instances.json> BENCH_K=2 BENCH_MODEL=haiku \
  npx tsx bench/swebench.ts
```
