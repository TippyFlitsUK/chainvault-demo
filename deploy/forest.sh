#!/usr/bin/env bash
# Forest via Docker (the release binary needs glibc 2.38; Ubuntu 22.04 has 2.35).
# The work dir is mounted at the same path so host paths pass straight through; chain data lives in a named volume.
WORKDIR=${CV_WORKDIR:-$HOME/chainvault}
# every import starts from an empty data dir, so the volume never holds more than one snapshot's worth of chain data
docker volume rm -f chainvault-forest-calib >/dev/null 2>&1 || true
exec docker run --rm --network host \
  -v "$WORKDIR:$WORKDIR" \
  -v chainvault-forest-calib:/root/.local/share/forest \
  ghcr.io/chainsafe/forest:v0.36.1 "$@"
