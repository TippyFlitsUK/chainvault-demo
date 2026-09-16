#!/usr/bin/env bash
# Forest via Docker (the release binary needs glibc 2.38; Ubuntu 22.04 has 2.35).
# The work dir is mounted at the same path so host paths pass straight through; chain data lives in a named volume.
WORKDIR=${CV_WORKDIR:-$HOME/chainvault}
exec docker run --rm --network host \
  -v "$WORKDIR:$WORKDIR" \
  -v chainvault-forest-calib:/root/.local/share/forest \
  ghcr.io/chainsafe/forest:v0.36.1 "$@"
