# Running the bench at scale on GCP

This arm64 Mac can only build the light SWE-bench repos (requests, flask)
arm64-native; the hard ones (django, sympy, scikit-learn, matplotlib) are x86-only
and emulation is slow and fragile. To run the canonical SWE-bench (Lite 300 or
Verified 500) ON vs OFF with a real model — the run that settles whether loops'
recipe beats GCC's +6.2pp — use an **x86 Linux box**. On Linux the two
Docker-on-Mac gotchas (`DOCKER_HOST` socket, cred-store) do not apply.

## The box

- **Machine**: `c3-standard-22` (22 vCPU, 88 GB) or `n2-standard-16` (16 vCPU, 64
  GB). SWE-bench eval is CPU + IO heavy and parallelises well.
- **Disk**: 300 GB SSD minimum — per-task Docker images are GB each and the full
  set is large. Verified needs more headroom than Lite.
- **OS**: Ubuntu 22.04 LTS (x86_64).
- **Region**: anywhere with the machine type; co-locate with nothing in particular.

```bash
gcloud compute instances create loops-bench \
  --machine-type=c3-standard-22 --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud --boot-disk-size=300GB --boot-disk-type=pd-ssd
gcloud compute ssh loops-bench
```

## Setup

```bash
# on the box
git clone https://github.com/jonny981/loops && cd loops
bash bench/gcp/setup.sh           # Docker, Python+swebench, Node+tsx, deps
export ANTHROPIC_API_KEY=sk-...   # the editing agent + judges authenticate with this
```

## Editing engine on a headless box

The local runs used the interactive `claude` CLI. Headless, prefer the
**`agent-sdk`** engine (`@anthropic-ai/claude-agent-sdk`, file-editing, API-key
auth) — set it in `swebench.ts` (`engine: 'agent-sdk'`) or via `--engine`. It edits
files programmatically with `ANTHROPIC_API_KEY`, no interactive login.

## The run (ON vs OFF, at scale)

1. **Pick the slice**: start with SWE-bench Lite (300). Export instances:
   ```bash
   python bench/gcp/export_instances.py --dataset princeton-nlp/SWE-bench_Lite \
     --out /tmp/lite.json   # all 300, or --repos django,sympy,... to subset
   ```
2. **Generate predictions** for each arm (the editing loop; native x86, parallel):
   ```bash
   BENCH_SWE_INSTANCES=/tmp/lite.json BENCH_K=2 BENCH_MODEL=claude-sonnet-4-6 \
     BENCH_SWE_OUT=/tmp/preds npx tsx bench/swebench.ts   # writes predictions-{off,on}.jsonl
   ```
   (Scale the editing loop's concurrency in `swebench.ts` for the box — the local
   version is sequential to dodge rate limits.)
3. **Evaluate** both arms with the official harness, high parallelism:
   ```bash
   for arm in off on; do
     python -m swebench.harness.run_evaluation -d princeton-nlp/SWE-bench_Lite \
       -p /tmp/preds/predictions-$arm.jsonl -id loops-$arm \
       --max_workers 16 --cache_level instance
   done
   ```
4. **Read the lift**: `resolved_instances` from each `loops-{off,on}.*.json` report.
   The headline is **ON − OFF** — directly comparable to GCC's +6.2pp.

## What it answers

- Does loops' recipe (honest gates + the structured "way" + retrieval of the
  decision-set) move the resolve-rate **more, the same, or less** than GCC's
  git-commands? Open question; only this run answers it.
- A real n (300/500) + a frontier model kills the "n=6, haiku, easy instances"
  reply that the local runs cannot.

Keep the local arm64 runs for fast iteration on the harness; use the box for the
numbers that go in public.
