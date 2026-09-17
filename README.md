# ChainVault demo (calibnet)

Archives Forest's calibnet snapshots onto Filecoin PDP storage providers, publishes a content-addressed manifest per snapshot, and shows live on-chain proof status. This is the Node Snapshot Service half of the ChainVault PRD, run against calibnet as a demo.

## Pieces

- `archiver/archiver.py` polls `forest-archive.chainsafe.dev` for the newest calibnet snapshot, downloads it, verifies the publisher's SHA256, splits it into 1000 MiB parts (the PDP piece cap is 1,065,353,216 bytes), uploads every part with `filecoin-pin add` (N copies across providers), writes a manifest linking to the previous manifest, and uploads the manifest too. State is `<workdir>/state.json`.
- `archiver/proofs.py` reads PDPVerifier on calibnet for every data set the archive uses (live, leaf count, last proven epoch, next challenge) and writes `<workdir>/proofs.json`.
- `archiver/rehydrate.py` pulls a snapshot back: fetches each part's CAR from a provider's `/piece/<cid>`, unpacks with `ipfs-car`, verifies part and whole-file SHA256, optionally runs `forest --import-snapshot`.
- `site/` a dependency-free Node server: `/snapshot/<height|latest>` and `/ipfs/<cid>` stream files byte-exact out of their pieces on the SP (Range supported), so `forest --import-snapshot <url>` and `IPFS_GATEWAY=<url>` work against it; plus the pages: counters, snapshot list with retrieval links, proof status bars, manifest chain, and a live rehydration log (SSE). Serves `rehydrate.py` for the one-liner.

## Requirements

Node 22+, Python 3.10+, curl, `filecoin-pin` 2.x installed globally, `npx` reachable (for `ipfs-car`).

## First-time setup (on the box that runs the archiver)

```bash
set -a && . deploy/chainvault.env && set +a && filecoin-pin payments setup --auto --network calibration && filecoin-pin balance --network calibration
```

Then copy `deploy/chainvault.env.example` to `deploy/chainvault.env` (git-ignored, mode 600), add the calibnet wallet `PRIVATE_KEY`, set `CV_PROVIDERS` to the provider IDs you want (calibration: 9 = ezpdpz-calib, 2 = ezpdpz-calib2, 4 = infrafolio-calib) and `CV_COPIES` to match.

## Run once by hand

```bash
python3 archiver/archiver.py --dry-run && python3 archiver/archiver.py && python3 archiver/proofs.py
```

`--dry-run` downloads, verifies and splits without uploading.

## Retention

- `CV_KEEP_ONCHAIN` (default 6): after each archive, payload pieces of older snapshots are removed with `filecoin-pin rm`; their manifests stay on Filecoin so the chain of manifests is complete. Forest publishes a calibnet snapshot every ~2 hours, so 6 keeps about 12 hours (~110 GB per copy).
- `CV_MIN_INTERVAL_EPOCHS` (default 0): archive only when the newest snapshot is at least this many epochs past the last archived one (2880 = daily).
- `CV_KEEP_LOCAL` (default 1): downloaded files kept on disk.
- `CV_FOREST_BIN` / `CV_FOREST_ARGS`: if set, every rehydration ends with `forest --import-snapshot`; `deploy/forest.sh` runs Forest from its Docker image (a calibnet import takes about 20 s). The rebuilt file is discarded afterwards.
- `CV_REHYDRATE_PROVIDER`: provider ID the site's rehydration button and one-liner prefer; other copies are only used on failure.
- `CV_PARALLEL` (default 4, 2 on the demo box; each secondary upload must finish inside filecoin-pin's 5-minute limit): parts uploaded concurrently; each filecoin-pin process holds one part in memory (~0.5 GB).

## Deploy

1. `HOST=user@host deploy/deploy.sh` from the machine holding the checkout.
2. On the box: `filecoin-pin login --network calibration` as above, then `crontab -e` and paste `deploy/crontab.txt`.
3. Set a real `CV_REHYDRATE_TOKEN` in `deploy/ecosystem.config.cjs`, then `pm2 start deploy/ecosystem.config.cjs && pm2 save`.
4. nginx: install `deploy/nginx-chainvault.conf`, add the DNS record and cert.

## Manifest

```
{ version, chain_id, object_type: "SNAPSHOT", start_height, end_height, finalized_height,
  snapshot_name, snapshot_date, source_url, size, sha256, chunk_bytes,
  parts: [{ index, size, sha256, root_cid, piece_cid, copies: [{ provider_id, data_set_id, piece_id }] }],
  parent_manifest_cid, created_at }
```

Manifest and payload parts are separately content addressed, as in the PRD.

Proof-parameter pieces carry the file's original CID in on-chain piece metadata (`orig=<cid>` on parts, `manifest=<cid>` on the manifest), so the link from the CID a node asks for to its pieces lives in the data set itself. One custom key per piece is all that fits: filecoin-pin adds `name` and the SDK adds `ipfsRootCID`, and the contract caps a piece at three.
