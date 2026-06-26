#!/usr/bin/env bash
# Score a SWE-ContextBench predictions file with the OFFICIAL swebench Docker harness.
# Handles the two macOS Docker Desktop gotchas the GCP runbook flagged: the socket is
# not at /var/run/docker.sock, and a credsStore helper (e.g. gcloud) breaks the Python
# SDK's anonymous public pulls. On a Linux x86 box neither applies.
#
#   bench/contextbench/score.sh <predictions.jsonl> <run_id>
#   BENCH_WORKERS=4 bench/contextbench/score.sh /tmp/loops-cb-out/predictions-summary.jsonl cb-summary
set -euo pipefail

PRED="${1:?usage: score.sh <predictions.jsonl> <run_id>}"
RUN_ID="${2:?usage: score.sh <predictions.jsonl> <run_id>}"
DATASET="${BENCH_CB_DATASET:-bench/contextbench/related_lite.jsonl}"  # local jsonl (HF default config won't load by name)
PY="${BENCH_PY:-bench/.venv/bin/python}"

# Docker socket from the active context (Desktop puts it under ~/.docker/run on macOS).
export DOCKER_HOST="${DOCKER_HOST:-$(docker context inspect -f '{{.Endpoints.docker.Host}}' 2>/dev/null || echo unix:///var/run/docker.sock)}"
# Neutralise any credsStore/credHelpers so anonymous pulls of the public base image work.
CFG="$(mktemp -d)"; printf '{}' > "$CFG/config.json"; export DOCKER_CONFIG="$CFG"

# Absolutise inputs, then run from a gitignored scratch dir so the harness's report
# (<model>.<run_id>.json) and logs/ land there, not in the repo root.
abspath() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }
PY="$(abspath "$PY")"; DATASET="$(abspath "$DATASET")"; PRED="$(abspath "$PRED")"
EVAL_DIR="$(dirname "$0")/eval"; mkdir -p "$EVAL_DIR"; cd "$EVAL_DIR"

# --namespace none builds env+instance images locally (these instances have no prebuilt
# images on the swebench dockerhub namespace). --cache_level env keeps the env images.
exec "$PY" -m swebench.harness.run_evaluation \
  --dataset_name "$DATASET" --split train \
  --predictions_path "$PRED" --run_id "$RUN_ID" \
  --cache_level env --namespace none --max_workers "${BENCH_WORKERS:-2}"
