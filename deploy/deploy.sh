#!/usr/bin/env bash
# Sync the project from mission-control to the Hetzner box. Does NOT start anything.
set -euo pipefail
HOST=${HOST:-77.42.75.71}
rsync -av --delete --exclude .git --exclude data/ "$(dirname "$0")/.." "$HOST:~/chainvault-demo/"
ssh "$HOST" 'mkdir -p ~/chainvault && cp -n ~/chainvault-demo/data/providers.json ~/chainvault/ 2>/dev/null || true'
echo "synced. Next on the box: see README 'Deploy'."
