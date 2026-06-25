#!/usr/bin/env python3
"""Export SWE-bench instances to the JSON shape bench/swebench.ts reads.

  python bench/gcp/export_instances.py --dataset princeton-nlp/SWE-bench_Lite --out /tmp/lite.json
  python bench/gcp/export_instances.py --repos django/django,sympy/sympy --out /tmp/hard.json
"""
import argparse
import json

from datasets import load_dataset

p = argparse.ArgumentParser()
p.add_argument("--dataset", default="princeton-nlp/SWE-bench_Lite")
p.add_argument("--split", default="test")
p.add_argument("--repos", default="", help="comma-separated repo filter, e.g. psf/requests,pallets/flask")
p.add_argument("--limit", type=int, default=0, help="cap the count (0 = all)")
p.add_argument("--out", required=True)
a = p.parse_args()

ds = load_dataset(a.dataset, split=a.split)
repos = set(filter(None, a.repos.split(",")))
rows = [r for r in ds if not repos or r["repo"] in repos]
if a.limit:
    rows = rows[: a.limit]

out = [
    {
        "instance_id": r["instance_id"],
        "repo": r["repo"],
        "base_commit": r["base_commit"],
        "problem_statement": r["problem_statement"],
    }
    for r in rows
]
with open(a.out, "w") as f:
    json.dump(out, f, indent=2)
print(f"wrote {len(out)} instances to {a.out}")
