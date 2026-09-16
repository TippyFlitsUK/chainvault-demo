#!/usr/bin/env python3
"""ChainVault snapshot archiver: Forest calibnet snapshot -> Filecoin PDP SPs -> manifest.

One run = archive the newest snapshot not yet archived. Safe to cron; a lock file
prevents overlap. State lives in <workdir>/state.json and is what the site reads.
"""
import argparse, fcntl, hashlib, json, os, re, shutil, subprocess, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ARCHIVE = os.environ.get("CV_ARCHIVE_URL", "https://forest-archive.chainsafe.dev")
CHAIN = os.environ.get("CV_CHAIN", "calibnet")
NETWORK = os.environ.get("CV_NETWORK", "calibration")
COPIES = int(os.environ.get("CV_COPIES", "2"))
PROVIDERS = [p for p in os.environ.get("CV_PROVIDERS", "").split(",") if p]
CHUNK = int(os.environ.get("CV_CHUNK_BYTES", str(1000 * 1024 * 1024)))
KEEP_LOCAL = int(os.environ.get("CV_KEEP_LOCAL", "1"))
KEEP_ONCHAIN = int(os.environ.get("CV_KEEP_ONCHAIN", "6"))
MIN_INTERVAL_EPOCHS = int(os.environ.get("CV_MIN_INTERVAL_EPOCHS", "0"))
UPLOAD_RETRIES = int(os.environ.get("CV_UPLOAD_RETRIES", "3"))
FILECOIN_PIN = os.environ.get("CV_FILECOIN_PIN", "filecoin-pin")
MANIFEST_VERSION = 1
NAME_RE = re.compile(r"forest_snapshot_(?P<chain>[a-z]+)_(?P<date>\d{4}-\d{2}-\d{2})_height_(?P<height>\d+)\.forest\.car\.zst$")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def log(msg):
    print(f"[{now()}] {msg}", flush=True)


UA = {"User-Agent": "chainvault-archiver/0.1 (+https://github.com/filoz)"}


def http_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def http_text(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode()


def sha256_file(path, chunk=1 << 22):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def load_state(path):
    if path.exists():
        return json.loads(path.read_text())
    return {"chain": CHAIN, "network": NETWORK, "snapshots": [], "updated_at": None}


def save_state(path, state):
    state["updated_at"] = now()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(path)


def latest_listing():
    d = http_json(f"{ARCHIVE}/list/{CHAIN}/latest?format=json")
    items = d["items"]
    items.sort(key=lambda i: i["uploaded"], reverse=True)
    return items


def parse_name(url):
    name = url.rsplit("/", 1)[-1]
    m = NAME_RE.match(name)
    if not m:
        raise ValueError(f"unexpected snapshot name: {name}")
    return name, int(m["height"]), m["date"]


def download(url, dest, expected_size):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == expected_size:
        log(f"already downloaded {dest.name}")
        return
    log(f"downloading {url} -> {dest}")
    cmd = ["curl", "-sS", "-L", "-A", UA["User-Agent"], "--retry", "5", "--retry-delay", "10", "-C", "-", "-o", str(dest), url]
    subprocess.run(cmd, check=True)
    if dest.stat().st_size != expected_size:
        raise RuntimeError(f"size mismatch after download: {dest.stat().st_size} != {expected_size}")


def split_file(src, parts_dir, chunk):
    parts_dir.mkdir(parents=True, exist_ok=True)
    parts = []
    with open(src, "rb") as f:
        i = 0
        while True:
            data = f.read(chunk)
            if not data:
                break
            p = parts_dir / f"{src.name}.part{i:03d}"
            h = hashlib.sha256()
            with open(p, "wb") as out:
                out.write(data)
            h.update(data)
            parts.append({"index": i, "file": str(p), "size": len(data), "sha256": h.hexdigest()})
            i += 1
    return parts


def run_pin(args):
    cmd = [FILECOIN_PIN] + args
    log("$ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = r.stdout + r.stderr
    for line in out.splitlines():
        print("    " + line, flush=True)
    if r.returncode != 0:
        raise RuntimeError(f"filecoin-pin exited {r.returncode}")
    return out


def parse_add_output(out):
    def grab(pat):
        m = re.search(pat, out)
        return m.group(1).strip() if m else None
    res = {"root_cid": grab(r"Root CID:\s*(\S+)"), "piece_cid": grab(r"Piece CID:\s*(\S+)"), "copies": []}
    cur = None
    for line in out.splitlines():
        m = re.search(r"Provider (\d+)\s*$", line)
        if m:
            cur = {"provider_id": int(m.group(1))}
            res["copies"].append(cur)
            continue
        if cur is not None:
            m = re.search(r"Data Set ID:\s*(\d+)", line)
            if m:
                cur["data_set_id"] = int(m.group(1))
            m = re.search(r"Piece ID:\s*(\d+)", line)
            if m:
                cur["piece_id"] = int(m.group(1))
    if not res["root_cid"] or not res["piece_cid"]:
        raise RuntimeError("could not parse Root CID / Piece CID from filecoin-pin output")
    return res


def pin_add(path, metadata):
    args = ["add", "--network", NETWORK, "--copies", str(COPIES), "--skip-ipni-verification"]
    for p in PROVIDERS:
        args += ["--provider-id", p]
    for k, v in metadata.items():
        args += ["--metadata", f"{k}={v}"]
    args.append(str(path))
    last = None
    for attempt in range(1, UPLOAD_RETRIES + 1):
        try:
            return parse_add_output(run_pin(args))
        except Exception as e:
            last = e
            log(f"upload attempt {attempt} failed: {e}")
            time.sleep(30 * attempt)
    raise last


def archive_one(item, workdir, state, dry_run=False):
    name, height, date = parse_name(item["url"])
    rec = {
        "name": name, "chain": CHAIN, "height": height, "date": date,
        "source_url": item["url"], "source_sha256_url": item["sha256url"],
        "size": item["size"], "source_uploaded": item["uploaded"],
        "status": "downloading", "started_at": now(), "parts": [], "manifest": None,
    }
    state["snapshots"] = [s for s in state["snapshots"] if s["name"] != name] + [rec]
    save_state(workdir / "state.json", state)

    dl = workdir / "downloads" / name
    download(item["url"], dl, item["size"])
    expected = http_text(item["sha256url"]).split()[0]
    log("verifying sha256")
    got = sha256_file(dl)
    if got != expected:
        rec["status"] = "failed"; rec["error"] = f"sha256 mismatch {got} != {expected}"
        save_state(workdir / "state.json", state)
        raise RuntimeError(rec["error"])
    rec["sha256"] = got
    rec["verified_at"] = now()
    rec["status"] = "splitting"
    save_state(workdir / "state.json", state)

    parts = split_file(dl, workdir / "parts" / name, CHUNK)
    rec["parts"] = [{k: v for k, v in p.items() if k != "file"} for p in parts]
    rec["status"] = "uploading"
    save_state(workdir / "state.json", state)

    if dry_run:
        rec["status"] = "dry-run"
        save_state(workdir / "state.json", state)
        log(f"dry run: would upload {len(parts)} parts")
        return rec

    for p, prec in zip(parts, rec["parts"]):
        if prec.get("piece_cid"):
            continue
        meta = {"chainvault": "snapshot", "chain": CHAIN, "height": str(height), "snapshot": name,
                "part": f"{p['index']}/{len(parts)}", "part_sha256": p["sha256"]}
        r = pin_add(Path(p["file"]), meta)
        prec.update(r)
        prec["uploaded_at"] = now()
        save_state(workdir / "state.json", state)

    prev = [s for s in state["snapshots"] if s.get("manifest") and s["name"] != name]
    prev.sort(key=lambda s: s["height"])
    parent_cid = prev[-1]["manifest"]["root_cid"] if prev else None
    manifest = {
        "version": MANIFEST_VERSION, "chain_id": CHAIN, "object_type": "SNAPSHOT",
        "start_height": height, "end_height": height, "finalized_height": height,
        "snapshot_name": name, "snapshot_date": date, "source_url": item["url"],
        "size": item["size"], "sha256": got, "chunk_bytes": CHUNK,
        "parts": [{"index": p["index"], "size": p["size"], "sha256": p["sha256"],
                   "root_cid": p["root_cid"], "piece_cid": p["piece_cid"], "copies": p["copies"]}
                  for p in rec["parts"]],
        "parent_manifest_cid": parent_cid, "created_at": now(),
    }
    mdir = workdir / "manifests"; mdir.mkdir(exist_ok=True)
    mpath = mdir / f"{name}.manifest.json"
    mpath.write_text(json.dumps(manifest, indent=2))
    r = pin_add(mpath, {"chainvault": "manifest", "chain": CHAIN, "height": str(height)})
    rec["manifest"] = {"path": str(mpath), "root_cid": r["root_cid"], "piece_cid": r["piece_cid"],
                       "copies": r["copies"], "parent_manifest_cid": parent_cid}
    rec["status"] = "done"
    rec["completed_at"] = now()
    save_state(workdir / "state.json", state)
    log(f"archived {name}: manifest {r['root_cid']}")
    return rec


def prune_local(workdir, state):
    done = sorted([s for s in state["snapshots"] if s["status"] in ("done", "pruned")], key=lambda s: s["height"])
    for s in done[:-KEEP_LOCAL] if KEEP_LOCAL > 0 else done:
        for p in (workdir / "downloads" / s["name"], workdir / "parts" / s["name"]):
            if p.exists():
                log(f"removing local {p}")
                shutil.rmtree(p) if p.is_dir() else p.unlink()
    for s in done[-KEEP_LOCAL:] if KEEP_LOCAL > 0 else []:
        p = workdir / "parts" / s["name"]
        if p.exists():
            shutil.rmtree(p)


def prune_onchain(state):
    """Remove snapshot payload pieces beyond the newest KEEP_ONCHAIN archived snapshots. Manifests stay."""
    if KEEP_ONCHAIN <= 0:
        return
    done = sorted([s for s in state["snapshots"] if s["status"] == "done"], key=lambda s: s["height"])
    for s in done[:-KEEP_ONCHAIN]:
        log(f"pruning on-chain pieces for {s['name']} (keeping newest {KEEP_ONCHAIN})")
        failed = False
        for part in s["parts"]:
            for c in part.get("copies", []):
                if c.get("removed"):
                    continue
                try:
                    run_pin(["rm", "--network", NETWORK, "--data-set-id", str(c["data_set_id"]), "--piece", part["piece_cid"]])
                    c["removed"] = True; c["removed_at"] = now()
                except Exception as e:
                    failed = True
                    log(f"prune failed for piece {part['piece_cid']} in set {c.get('data_set_id')}: {e}")
        if not failed:
            s["status"] = "pruned"; s["pruned_at"] = now()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=os.environ.get("CV_WORKDIR", str(Path.home() / "chainvault")))
    ap.add_argument("--dry-run", action="store_true", help="download, verify and split only")
    ap.add_argument("--force", action="store_true", help="re-archive the latest snapshot even if done")
    a = ap.parse_args()
    workdir = Path(a.workdir); workdir.mkdir(parents=True, exist_ok=True)
    lock = open(workdir / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another run holds the lock; exiting")
        return 0
    state = load_state(workdir / "state.json")
    items = latest_listing()
    item = items[0]
    name, height, _ = parse_name(item["url"])
    existing = next((s for s in state["snapshots"] if s["name"] == name), None)
    if existing and existing["status"] in ("done", "pruned") and not a.force:
        log(f"latest {name} (height {height}) already archived")
        prune_local(workdir, state)
        return 0
    newest = max([s["height"] for s in state["snapshots"] if s["status"] in ("done", "pruned")] or [0])
    if MIN_INTERVAL_EPOCHS and height < newest + MIN_INTERVAL_EPOCHS and not a.force:
        log(f"latest {name} is only {height - newest} epochs past the last archive; waiting for {MIN_INTERVAL_EPOCHS}")
        return 0
    log(f"archiving {name} (height {height}, {item['size']/1e9:.2f} GB)")
    try:
        archive_one(item, workdir, state, dry_run=a.dry_run)
    except Exception as e:
        rec = next(s for s in state["snapshots"] if s["name"] == name)
        rec["status"] = "failed"; rec["error"] = str(e); rec["failed_at"] = now()
        save_state(workdir / "state.json", state)
        log(f"FAILED: {e}")
        return 1
    if not a.dry_run:
        prune_onchain(state)
        save_state(workdir / "state.json", state)
        prune_local(workdir, state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
