# yardstick — comparable numbers against an external SWE-bench study

The reference study is a published controlled cost/quality experiment on
SWE-bench Lite (data source: <https://github.com/professorpalmer/swebench-pm>,
cited here only as the provenance of the numbers below). This folder makes a loops run
**directly comparable** to it: the same instances, the same official grader,
and the same cost semantics. Run the loops arm, grade it, and `report.ts`
prints your numbers next to theirs with the caveats attached.

## What the yardstick actually is

The reference study's graded run is **not** the full Lite-300: the generation run died
partway, so the committed, graded set is a specific **135-instance slice that
is 84% django** (django is the easiest repo family; the full set is 38%
django). That makes its headline rates look high against leaderboards — but it
is a perfectly good *yardstick* as long as both systems run the **same** slice.
The frozen id list is [`instances.slice135.json`](instances.slice135.json), extracted
from the reference study's committed predictions.

Its verified numbers on that slice (from the committed grade JSONs and the
`swe_lite_ledger.sqlite`, not the README — the README's "47% cheaper at equal
quality" does not survive its own artifacts):

| Arm | Resolved | Measured $ | Reconstructed frontier baseline $ | Tokens in/out |
|---|---|---|---|---|
| A — frontier baseline (gpt-5.5 every turn) | 98/135 = 72.6% | $27.51 | $27.51 (self) | 20.2M / 221k |
| B — A + CodeGraph + cost router | 80/135 = 59.3% | $17.44 | $32.66 | 23.7M / 310k |
| C — B + durable retries | 90/135 = 66.7% | $19.45 | $37.13 | 27.0M / 338k |

So the honest yardstick reading: the router arm B is **37% cheaper measured
against the real arm A, at a cost of 18 resolves**; arm C claws quality back
with retries (29% cheaper, −8 resolves). Those are the numbers a loops arm is
competing with.

## Run the loops arm

```bash
# 1. Fetch the slice's full instance data (repo, base_commit, problem statement)
pip install datasets
python bench/yardstick/fetch-instances.py > /tmp/slice135-instances.json

# 2. Generate predictions with the loops harness (real engine, real spend)
BENCH_SWE_INSTANCES=/tmp/slice135-instances.json \
BENCH_ENGINE=claude-cli BENCH_MODEL=<your-model> BENCH_K=2 \
BENCH_SWE_OUT=/tmp/pm135-out \
  npx tsx bench/swebench.ts

# 3. Grade with the OFFICIAL harness (deterministic; Docker; no keys)
python -m swebench.harness.run_evaluation -d princeton-nlp/SWE-bench_Lite \
  -p /tmp/pm135-out/predictions-on.jsonl -id loops-on -n none \
  --cache_level env --max_workers 2

# 4. Price and compare
npx tsx bench/yardstick/report.ts \
  --ledger /tmp/pm135-out/ledger.jsonl \
  --grades loops-on.<...>.json \
  --prices prices.json --baseline-model <ceiling-model-id> \
  --arm on
```

The generation harness ([`bench/swebench.ts`](../swebench.ts)) keeps the same
disciplines the reference study's generation kept, plus the ones its audit flagged:

- **No test leakage.** The agent never sees FAIL_TO_PASS; the hidden suite
  grades via the official harness only. (Same as the reference study.)
- **Real acceptance between attempts.** the reference study's arm-C retries accepted
  any non-empty diff. loops attempts ground in the Ledger — each retry reads
  *why* the prior attempt went the way it did — and the run records every
  attempt's diff for pass@K, so a later regression can't silently erase a
  correct earlier fix.
- **Dead-engine circuit breaker.** Two consecutive zero-token empty runs abort
  loudly instead of writing a full set of empty predictions that grade as a
  fake null result.
- **A per-instance ledger** (`ledger.jsonl`): tokens per model per instance,
  which `report.ts` prices with your `--prices` table — measured dollars, plus
  the reconstructed baseline, labeled as such.

## Adding curated-grounding / ladder arms

Curated grounding and the ladder ship default-off with run-level kill
switches, so extra arms cost nothing to define: give the recipe `ground.sources`
/ `ground.curate` / `ladder`, then run the same slice once per arm --

```bash
# arm 1: plain grounding            --no-curate --no-ladder
# arm 2: curated, static lane       --no-ladder
# arm 3: curated + routed           (no flags)
```

-- each with `--prices`, and compare $/resolve across arms exactly the way the
reference study's arms A/B/C compare. The routing arm earns a place in your
recipes only if arm 3 beats arm 2 here; that is the experiment the flags exist
to run.

## Comparability rules (read before quoting numbers)

1. **Resolve rates are comparable on this slice, and only on this slice.**
   84% django means rates here overstate full-set rates for *both* systems.
   Compare loops against the reference arms; do not compare either to a leaderboard.
2. **Compare measured to measured.** the reference study's only fully-measured
   frontier number is arm A ($27.51). Its arms B/C "baseline" columns are
   reconstructions (their own token stream re-priced) — compare those only to
   your own reconstructed baseline, never to a measured figure.
3. **Name your ceiling.** Theirs is gpt-5.5 at temperature 1.0. If your loops
   arm runs a different family, the quality comparison carries that asterisk;
   the cost-structure comparison (cheap-lane fraction, $/resolve) still holds.
4. **Single seed, both sides.** Neither study has confidence intervals.
   Differences within a few points are noise; say so.
5. **$/resolve is the honest headline**, not raw dollars: a cheaper arm that
   resolves less is not "cheaper at equal quality".

## Files

| File | What |
|---|---|
| `instances.slice135.json` | The frozen 135 instance ids — the like-for-like slice. |
| `fetch-instances.py` | Pulls the slice's full instance data from the official dataset. |
| `report.ts` | Folds `ledger.jsonl` + the official grade report + your prices into the comparison table (yardstick constants embedded, with provenance). |
