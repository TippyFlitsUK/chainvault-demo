#!/usr/bin/env bash
# Sync the project to the deploy target. Does NOT start anything.
set -euo pipefail
HOST=${HOST:?set HOST to the deploy target, e.g. HOST=user@host}
rsync -av --delete --exclude .git --exclude data/ "$(dirname "$0")/.." "$HOST:~/chainvault-demo/"
ssh "$HOST" 'mkdir -p ~/chainvault && cp -n ~/chainvault-demo/data/providers.json ~/chainvault/ 2>/dev/null || true'
echo "synced. Next on the box: see README 'Deploy'."
