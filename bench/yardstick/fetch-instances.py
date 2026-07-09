#!/usr/bin/env python3
"""Fetch the yardstick slice's full instance data from SWE-bench Lite.

The frozen id list (instances.slice135.json) pins WHICH instances the comparison
runs on; this script pulls their repo / base_commit / problem_statement from
the official dataset into the shape bench/swebench.ts expects.

  pip install datasets
  python bench/yardstick/fetch-instances.py > /tmp/slice135-instances.json
"""

import json
import pathlib
import sys

try:
    from datasets import load_dataset
except ImportError:
    sys.exit("pip install datasets  # needed to pull princeton-nlp/SWE-bench_Lite")

HERE = pathlib.Path(__file__).parent
ids = set(json.loads((HERE / "instances.slice135.json").read_text()))

rows = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
out = [
    {
        "instance_id": r["instance_id"],
        "repo": r["repo"],
        "base_commit": r["base_commit"],
        "problem_statement": r["problem_statement"],
    }
    for r in rows
    if r["instance_id"] in ids
]
missing = ids - {r["instance_id"] for r in out}
if missing:
    sys.exit(f"dataset is missing {len(missing)} slice ids: {sorted(missing)[:5]}...")
json.dump(out, sys.stdout, indent=1)
print(f"\n{len(out)} instances", file=sys.stderr)
