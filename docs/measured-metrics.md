# Measured metrics

Every measured Ledger result in one place: the ON−OFF ablation (loops' memory on vs
off, same model, same gate, varying only the memory). Numbers are live runs against
the official harness for the regime, never the model grading itself.

**Legend.** `resolve@K-final` = the bug is fixed after the full K-attempt process (the
final cumulative diff passes the hidden tests). `pass@K` = fixed by *any* attempt
(resolved if attempt 1 OR the final passes). `convergence Δ` = (resolved-at-final −
resolved-after-attempt-1); positive means the second attempt built on the first,
negative means it regressed it. `lift` = ON − OFF in percentage points (pp) unless
noted. On a 6-instance slice one instance is 16.7pp, so small samples are noisy and
the *direction* is more trustworthy than the pp magnitude.

| Experiment | Setup | Metric | OFF | ON | Lift |
|---|---|---|---|---|---|
| **SWE-bench cross-iteration (haiku, 6 `psf/requests`, 3 trials)** | | | | | |
| resolve@K-final | 18 runs | resolve@K-final | 9/18 (50%) | 11/18 (61%) | +11pp (noisy) |
| convergence Δ (final − attempt-1) | 3 trials | Δ | −3 | +2 | ON builds, OFF regresses (robust) |
| pass@K (either attempt) | 18 runs | pass@K | 12/18 (67%) | 11/18 (61%) | −6pp (red herring) |
| SWE-bench Lite requests, sonnet | n=6 | resolve@2 | 6/6 (100%) | 6/6 (100%) | +0pp (ceiling) |
| Trivial tasks, sonnet | 3 tasks | resolve | 100% | 100% | +0pp (ON +2% tokens) |
| Convergence suite, haiku | 40 runs | resolve | 100% | 100% | +0pp (ON +72% tokens) |
| **Cross-node (graph), haiku** | | | | | |
| Judgment fence | n=10 | resolve | 7/10 (70%) | 8/10 (80%) | +10pp (within noise) |
| Contract (unguessable `SSv1` tag) | n=10 | resolve | 0/10 (0%) | 9/10 (90%) | +90pp (p≈0.0001) |
| Contract vs vanilla orchestrator | n=10 | resolve | no-mem 0/10 · git-log-dump 10/10 | loops 9/10 | ties dump (ergonomics, not capability, at this scale) |
| Noisy log (foundation buried under 15 commits) | n=6 | resolve | recent-N 0/6 · dump 6/6 | retrieve 5/6 (83%) | retrieval rescues recent-N; dump still wins at 16 commits |
| **Cross-batch + memory-vs-competitors, haiku** | | | | | |
| Sweep, house-style conformance | 18 docs | conformance | 3/18 (17%) | 18/18 (100%) | +83pp (ON uniform, OFF erratic) |
| Accumulate, 12 unguessable conventions | 12 asserts | resolve | dump ✓ · RAG/select/summary ✗ | consolidate ✓ | top-k ceiling: only consolidation keeps all 12 |
| Capability vs dump (≈265k-token log) | n=4 | resolve | dump 0/4 (context overflow) | retrieve 4/4 (~9k tok) | dump infeasible at scale, ≈29× less context |

## How to read this

- **Cross-iteration on an easy slice is noise-dominated.** Haiku one-shots most of the
  6-instance `requests` slice, so per-trial swings reach ±67pp and the resolve-rate lift
  is not statistically significant. The robust cross-iteration finding is **convergence
  direction**: with memory the loop's second attempt builds on the first (Δ ≥ 0 every
  trial); without it, it regresses (Δ ≤ 0 every trial). That is loops' founding thesis —
  the workspace is the state, each iteration builds on the last — measured directly.
- **`pass@K` is the wrong lens for a convergence loop.** It rewards a lucky single attempt
  and is blind to whether the loop holds together, so it can credit a memoryless arm for
  an early attempt the process later destroyed. `resolve@K-final` and `convergence Δ` are
  the metrics that match what loops claims.
- **The clean wins are cross-boundary.** The lift scales with the number of context
  boundaries the work crosses. The single-node, one-shot regime is the floor (memory is
  only a token tax). The contract task (+90pp) is the ceiling: an upstream decision a
  downstream node genuinely cannot re-derive.
- **All numbers are loops' own ON−OFF ablation.** They isolate the contribution of the
  Ledger on a fixed model. They are not a head-to-head against other libraries.

## Honest limits

n is small (6–18 instance-runs), the model is weak (haiku, chosen to open headroom), and
the difficulty band is bounded by hardware (only the light SWE-bench repos build native;
heavier instances need a remote box). These are directional, in-kind results plus a
validated instrument, not statistically significant point estimates. The reproduce
commands live in `bench/RESULTS.md`.
