#!/usr/bin/env python3
"""Inspect SWE-ContextBench: group base->related, show repo coverage + SWE-bench overlap."""
from collections import Counter
from datasets import load_dataset

REPO = "jiayuanz3/SWEContextBench"
def load(fn):
    return load_dataset(REPO, data_files=fn, split="train")

rel  = load("data/SWEContextBench_Related_Lite.parquet")
exp  = load("data/SWEContextBench_Lite_Experience.parquet")
link = load("data/SWEContextBench_Relationship.parquet")
expF = load("data/SWEContextBench_Experience.parquet")  # fallback base pool

print(f"Lite_Related={len(rel)}  Lite_Experience={len(exp)}  Relationship={len(link)}  Experience(full)={len(expF)}")
print("Relationship columns:", link.column_names)
print("Related columns:", rel.column_names)

# Standard SWE-bench Python repos (prebuilt Docker images -> buildable locally)
SWEBENCH = {
 "astropy/astropy","django/django","matplotlib/matplotlib","mwaskom/seaborn",
 "pallets/flask","psf/requests","pydata/xarray","pylint-dev/pylint","pytest-dev/pytest",
 "scikit-learn/scikit-learn","sphinx-doc/sphinx","sympy/sympy",
}
def repo_of(rows): return Counter(r["repo"] for r in rows)

print("\n-- Lite_Related repo distribution --")
for repo, n in repo_of(rel).most_common():
    print(f"  {n:3d}  {repo}{'   [SWE-bench]' if repo in SWEBENCH else ''}")

# Build related_id -> experience_id(s)
by_rel = {}
for L in link:
    by_rel.setdefault(L["related_instance_id"], []).append(L["experience_instance_id"])

exp_ids = {r["instance_id"] for r in exp} | {r["instance_id"] for r in expF}
rel_in_swebench = [r for r in rel if r["repo"] in SWEBENCH]
mapped = [r for r in rel_in_swebench if by_rel.get(r["instance_id"]) and any(e in exp_ids for e in by_rel[r["instance_id"]])]
print(f"\nLite_Related in SWE-bench repos: {len(rel_in_swebench)}")
print(f"  of those, with a resolvable base in Experience: {len(mapped)}")
print("\n-- candidate groups (related -> base), SWE-bench repos --")
for r in mapped[:20]:
    bases = [e for e in by_rel[r['instance_id']] if e in exp_ids]
    print(f"  {r['repo']:24s} {r['instance_id']}  <- {bases[0]}")
