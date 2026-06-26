# SWE-ContextBench — scale run (Linux x86 box)

The local macOS run is capped: Rosetta makes test execution slow and the
network-test repos (requests, django) hang in the sandbox, so only the ~30
offline-test instances score locally. A Linux x86 box (no emulation, real
network) runs the full 88 scoreable instances across all 9 languages at proper
concurrency. This is the path to a resolve-rate signal at adequate power (a ~+8pp
memory effect ≈ 7 resolves at n=88; it is ~0.5 at the local n≈8).

## Cost note (read first)

A headless box cannot use the `claude` CLI's Max/Pro **subscription** auth — it
uses the **Anthropic API** (`BENCH_ENGINE=agent-sdk`, an API key), i.e. pay per
token. That is a *separate* pool from the weekly subscription allowance, so it
does not compete with local usage, but it is real money.

Rough full run: 88 groups × 4 solves (base + 3 related arms) ≈ 352 solves ×
~15k tokens ≈ 5M tokens → order of $30–80 at Sonnet rates. Levers to cut it:
- `BENCH_MODEL=claude-haiku-4-5-20251001` for a cheaper pass (lower resolve, more headroom).
- Drop the `dump` arm (off-vs-summary is the core ablation) — ⅓ fewer related solves.
- A targeted subset (the harder tasks, where the paper's summary effect concentrates).

## Provision

```bash
# from the repo root, on a fresh Ubuntu x86 box
bash bench/gcp/setup.sh            # Docker + python venv + swebench + node + npm ci
source ~/swebench-env/bin/activate # or use bench/.venv
export ANTHROPIC_API_KEY=sk-...
```

## Build the manifests (free — pure dataset export)

```bash
# all 88 scoreable base→related groups (every repo, no per-repo cap)
python bench/contextbench/export_groups.py --out bench/contextbench/groups.json \
  --repos "django/django,sympy/sympy,scikit-learn/scikit-learn,matplotlib/matplotlib,psf/requests,sphinx-doc/sphinx,mwaskom/seaborn,pydata/xarray,astropy/astropy" \
  --limit 88 --per-repo 88
# related instances → the local jsonl the scorer reads (strips the ::context:: bug)
python bench/contextbench/export_eval.py --out bench/contextbench/related_lite.jsonl
```

## Solve (the spend)

On Linux, concurrency is safe and there is no Rosetta tax. Run groups concurrently
(one process per group, or batch). `BENCH_ENGINE=agent-sdk` uses the API key.

```bash
BENCH_ENGINE=agent-sdk BENCH_MODEL=sonnet BENCH_CB_GROUPS=bench/contextbench/groups.json \
  BENCH_CB_OUT=/tmp/cb BENCH_CB_CACHE=/tmp/cb-cache \
  npx tsx bench/swecontextbench.ts            # all groups; or pass instance_ids to shard
```

## Score (Docker, free of API)

No macOS gotchas on Linux (the socket/credsStore/`--namespace` handling in
`score.sh` is harmless there). Merge predictions per arm, then:

```bash
for arm in off summary dump; do cat /tmp/cb/*/predictions-$arm.jsonl > /tmp/cb/predictions-$arm.jsonl; done
for arm in off summary dump; do
  BENCH_WORKERS=8 bash bench/contextbench/score.sh /tmp/cb/predictions-$arm.jsonl cb-$arm
done
# reports: bench/contextbench/eval/loops-<arm>.cb-<arm>.json
```

## Read

Per arm: `resolved_instances / completed_instances`. The comparison:
- `summary − off`  — uplift over the bare model (the No-Context baseline).
- `summary − dump` — curated experience vs raw-context dumping (the competitor axis).
- vs the paper (Lite): No-Context 26.3% → Oracle-Context 27.3% → Oracle-Summary 34.3%.

A partial-credit view (mean FAIL_TO_PASS fraction per arm) is in the per-instance
`report.json` under `eval/logs/run_evaluation/` and is more sensitive at small n.
