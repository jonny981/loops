#!/usr/bin/env bash
# Provision an x86 Ubuntu box to run the bench at scale. Run from the loops repo root.
set -euo pipefail

echo "== Docker =="
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" || true

echo "== Python + swebench =="
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip git
python3 -m venv "$HOME/swebench-env"
# shellcheck disable=SC1091
source "$HOME/swebench-env/bin/activate"
pip install -U pip swebench datasets

echo "== Node 20 + deps =="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm ci

cat <<'NOTE'

Done. Next:
  - Log out and back in so the docker group applies (or: newgrp docker).
  - source ~/swebench-env/bin/activate
  - export ANTHROPIC_API_KEY=sk-...
  - See bench/gcp/RUNBOOK.md for the run commands.
On Linux the DOCKER_HOST / cred-store gotchas from macOS do NOT apply.
NOTE
