#!/usr/bin/env python3
"""Export SWE-ContextBench related instances to a local jsonl the swebench harness scores against
(the HF 'default' config can't be loaded by name — its 5 parquet files have mismatched schemas)."""
import argparse, json
from datasets import load_dataset

p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
p.add_argument("--file", default="data/SWEContextBench_Related_Lite.parquet")
a = p.parse_args()

ds = load_dataset("jiayuanz3/SWEContextBench", data_files=a.file, split="train")
fields = ["instance_id","repo","base_commit","patch","test_patch","problem_statement",
          "hints_text","FAIL_TO_PASS","PASS_TO_PASS","environment_setup_commit","version"]

def fix_ids(blob):
    # SWE-ContextBench test IDs carry a spurious `::context::` infix the real pytest
    # node IDs lack (e.g. ...py::context::test_x -> ...py::test_x). Without stripping it
    # the harness matches no test and even the GOLD patch scores unresolved.
    return json.dumps([t.replace("::context::", "::") for t in json.loads(blob)])

with open(a.out, "w") as f:
    for r in ds:
        row = {k: r[k] for k in fields}
        row["version"] = str(r["version"])
        row["FAIL_TO_PASS"] = fix_ids(r["FAIL_TO_PASS"])
        row["PASS_TO_PASS"] = fix_ids(r["PASS_TO_PASS"])
        f.write(json.dumps(row) + "\n")
print(f"wrote {len(ds)} instances to {a.out}")
