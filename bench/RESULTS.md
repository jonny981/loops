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
| graph cross-node, judgment fence (haiku, n=10) | 70% (7/10) | 80% (8/10) | +10pp (within noise) | +33% |
| **graph cross-node, contract (haiku, n=10)** | **0% (0/10)** | **90% (9/10)** | **+90pp** | **+35%** |

The first three are **ceiling effects**: the model solves everything in one
attempt, both arms max out, the Ledger only adds cost. The rest open headroom and
the Ledger converts it: a weaker model recovering from its own failed attempts
(SWE-bench, +33pp), and — most cleanly — a downstream node honouring an upstream
decision it could not otherwise know (graph contract, +90pp, p ≈ 0.0001).

## The two faces of the Ledger

| face | mechanism | evidence |
|---|---|---|
| cross-**iteration** | recover from your own failed attempts | SWE-bench haiku +33pp (strict superset, zero regression) |
| cross-**node** | carry an upstream decision a downstream node can't otherwise know | graph contract +90pp |

Both require headroom (a regime where one attempt / the files alone are not
enough). On single-node, one-shot work — the floor — the Ledger is only a tax.

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
**contract**: an arbitrary upstream convention the downstream node cannot guess.
Task `stable-store-contract` adds one — node 1's commit specifies that snapshots
must begin with the exact wire-format tag `SSv1|` that the deployed client
requires. The serialize node cannot invent it; it lives only in the why.

Result (haiku, 10 trials/arm): **OFF held 0/10, ON held 9/10 — +90pp, p ≈ 0.0001.**
This is the cross-node mechanism, clean:

- OFF = 0/10 is by construction — an unguessable convention is unguessable. That is
  the point, not a trick: real upstream conventions (wire formats, field names,
  protocol versions) are unguessable downstream. The 0/10 also proves zero
  contamination — no OFF agent reached the why via `git log`.
- ON = 9/10, not 10/10, is what makes it a real test rather than a tautology:
  grounding *delivered* the contract, but the agent still had to *apply* it, and
  once (trial 8) it did not. The lift measures end-to-end delivery AND application.
- ON cost +35% tokens — and several OFF trials burned *more* tokens flailing
  without the contract and still failed.

The judgment-fence variant is the honest floor of the graph regime (a careful
agent often re-derives the right thing); the contract variant is the honest
ceiling (an upstream decision that genuinely cannot be re-derived). Real graph
work sits between them, and the deeper the graph, the more boundaries the why must
cross, the more the Ledger compounds.

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
one-shot work is the floor — the Ledger is only a tax there. The value lives in
the *why that crosses boundaries and is not in the files*: an agent recovering
from its own prior attempts (cross-iteration) or honouring an upstream node's
decision (cross-node). Both are now measured. Deep agent graphs stack many such
boundaries, so the lift should compound with depth — the next measurement is a
longer chain with several fence-bearing nodes.

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

# Graph cross-node (the judgment-fence floor and the contract ceiling)
BENCH_TRIALS=10 BENCH_MODEL=haiku BENCH_OUT=results-graph.json npx tsx bench/graph.ts
BENCH_GRAPH_TASK=graph-tasks/stable-store-contract BENCH_TRIALS=10 BENCH_MODEL=haiku \
  BENCH_OUT=results-graph-contract.json npx tsx bench/graph.ts
```
