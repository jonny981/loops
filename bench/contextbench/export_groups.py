#!/usr/bin/env python3
"""Export SWE-ContextBench base->related groups to the JSON manifest the TS harness reads.

Each related task is paired with its oracle base task (the known dependency/reference
relationship). loops solves the base to generate the "experience" (its committed way =
a summary, and the raw working log = a trajectory), then solves the related task with
that experience in context. Only the RELATED task is test-scored.

  python bench/contextbench/export_groups.py --out /tmp/cb.json --limit 12
  python bench/contextbench/export_groups.py --repos psf/requests,pallets/flask --out /tmp/cb.json
"""
import argparse
import json
from datasets import load_dataset
from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS as SPECS

REPO = "jiayuanz3/SWEContextBench"
DATA = "data/SWEContextBench_"

# Pure-Python repos first (fastest Docker env builds for a local slice); the
# C/Fortran-heavy ones (scikit-learn, matplotlib) build slowly under x86 emulation.
DEFAULT_REPOS = (
    "psf/requests,sympy/sympy,sphinx-doc/sphinx,mwaskom/seaborn,"
    "astropy/astropy,django/django,scikit-learn/scikit-learn,matplotlib/matplotlib"
)

def load(name):
    return load_dataset(REPO, data_files=f"{DATA}{name}.parquet", split="train")

def slim(r):
    return {
        "instance_id": r["instance_id"],
        "repo": r["repo"],
        "base_commit": r["base_commit"],
        "problem_statement": r["problem_statement"],
        "version": str(r["version"]),
    }

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--repos", default=DEFAULT_REPOS, help="comma-separated repo allow-list, in priority order")
    p.add_argument("--limit", type=int, default=12)
    p.add_argument("--per-repo", type=int, default=3, help="cap groups per repo (diversity)")
    a = p.parse_args()

    related = load("Related_Lite")
    experience = {r["instance_id"]: r for r in load("Experience")}
    link = {}
    for L in load("Relationship"):
        link.setdefault(L["related_instance_id"], []).append(L["experience_instance_id"])

    order = [x for x in (s.strip() for s in a.repos.split(",")) if x]
    rank = {repo: i for i, repo in enumerate(order)}
    allow = set(order)

    groups = []
    for r in related:
        if r["repo"] not in allow:
            continue
        # Only keep instances the official swebench harness can build+score (its
        # spec map is keyed by exact repo+version; ~11/99 Lite related tasks fall outside).
        if r["repo"] not in SPECS or str(r["version"]) not in SPECS[r["repo"]]:
            continue
        # Oracle base: the mapped experience task in the SAME repo.
        base = next(
            (experience[e] for e in link.get(r["instance_id"], [])
             if e in experience and experience[e]["repo"] == r["repo"]),
            None,
        )
        if base is None:
            continue
        groups.append({"repo": r["repo"], "base": slim(base), "related": slim(r)})

    # Order by repo priority, then cap per-repo for diversity, then overall limit.
    groups.sort(key=lambda g: rank.get(g["repo"], 1e9))
    seen, picked = {}, []
    for g in groups:
        n = seen.get(g["repo"], 0)
        if n >= a.per_repo:
            continue
        seen[g["repo"]] = n + 1
        picked.append(g)
        if len(picked) >= a.limit:
            break

    with open(a.out, "w") as f:
        json.dump(picked, f, indent=2)
    from collections import Counter
    dist = Counter(g["repo"] for g in picked)
    print(f"wrote {len(picked)} groups to {a.out}")
    for repo, n in dist.most_common():
        print(f"  {n}  {repo}")

if __name__ == "__main__":
    main()
