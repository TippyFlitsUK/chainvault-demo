#!/usr/bin/env python3
"""ChainVault snapshot archiver: Forest calibnet snapshot -> Filecoin PDP SPs -> manifest.

One run = archive the newest snapshot not yet archived. Safe to cron; a lock file
prevents overlap. State lives in <workdir>/state.json and is what the site reads.
"""
import argparse, fcntl, hashlib, json, os, re, shutil, subprocess, sys, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path


def _load_env_file():
    """cron and PM2 source deploy/chainvault.env; make the archiver self-sufficient when they don't export it."""
    p = Path(os.environ.get("CV_ENV_FILE", Path(__file__).resolve().parent.parent / "deploy" / "chainvault.env"))
    if p.exists():
        for line in p.read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file()

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
PARALLEL = max(1, int(os.environ.get("CV_PARALLEL", "4")))
STATE_LOCK = threading.RLock()
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
    with STATE_LOCK:
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


class PinError(RuntimeError):
    def __init__(self, msg, output):
        super().__init__(msg); self.output = output


def run_pin(args):
    cmd = [FILECOIN_PIN] + args
    tag = args[0] if args and args[0] != "add" else next((a.rsplit(".part", 1)[-1] for a in args if ".part" in a), "manifest")
    log(f"[{tag}] $ " + " ".join(cmd))
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    for line in p.stdout:
        line = line.rstrip("\n")
        if line.strip():
            print(f"    [{now()}] [{tag}] {line}", flush=True)
        lines.append(line)
    p.wait()
    if p.returncode != 0:
        raise PinError(f"filecoin-pin exited {p.returncode}", "\n".join(lines))
    return "\n".join(lines)


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


def pin_add(path, metadata, providers=None, copies=None):
    """Upload with `copies` copies across `providers` (defaults: CV_COPIES / CV_PROVIDERS). If only a secondary
    copy fails, top up that provider alone rather than re-adding everything (a full retry re-commits the
    primary and leaves duplicate pieces)."""
    PROVIDERS_ = list(providers) if providers is not None else PROVIDERS
    COPIES_ = int(copies) if copies is not None else COPIES
    base = ["add", "--network", NETWORK, "--skip-ipni-verification"]
    for k, v in metadata.items():
        base += ["--metadata", f"{k}={v}"]
    args = base[:1] + ["--copies", str(COPIES_)] + base[1:]
    for p in PROVIDERS_:
        args += ["--provider-id", p]
    args.append(str(path))
    last = None
    result = None
    for attempt in range(1, UPLOAD_RETRIES + 1):
        try:
            result = parse_add_output(run_pin(args))
            break
        except PinError as e:
            last = e
            try:
                partial = parse_add_output(e.output)
            except Exception:
                partial = None
            if partial and partial["copies"]:
                log(f"partial success: {len(partial['copies'])} of {COPIES_} copies committed; topping up the rest")
                result = partial
                break
            log(f"upload attempt {attempt} failed: {e}")
            time.sleep(30 * attempt)
        except Exception as e:
            last = e
            log(f"upload attempt {attempt} failed: {e}")
            time.sleep(30 * attempt)
    if result is None:
        raise last
    have = {c["provider_id"] for c in result["copies"]}
    for p in PROVIDERS_:
        if int(p) in have or len(result["copies"]) >= COPIES_:
            continue
        for attempt in range(1, UPLOAD_RETRIES + 1):
            try:
                extra = parse_add_output(run_pin(base[:1] + ["--copies", "1", "--provider-id", p] + base[1:] + [str(path)]))
                result["copies"] += [c for c in extra["copies"] if c["provider_id"] not in have]
                have |= {c["provider_id"] for c in extra["copies"]}
                break
            except Exception as e:
                log(f"top-up to provider {p} attempt {attempt} failed: {e}")
                time.sleep(30 * attempt)
    return result


def known_data_sets(state):
    """Data set IDs recorded by earlier successful uploads, per provider."""
    found = set()
    for s in state.get("snapshots", []):
        for part in s.get("parts", []):
            for c in part.get("copies", []):
                if "data_set_id" in c:
                    found.add((c.get("provider_id"), c["data_set_id"]))
    return found


def archive_one(item, workdir, state, dry_run=False):
    name, height, date = parse_name(item["url"])
    previous = next((s for s in state["snapshots"] if s["name"] == name), None)
    previous_parts = {p["sha256"]: p for p in (previous or {}).get("parts", []) if p.get("sha256")}
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
        dl.unlink(missing_ok=True)  # otherwise the next run sees a full-size file and repeats the same mismatch
        raise RuntimeError(rec["error"])
    rec["sha256"] = got
    rec["verified_at"] = now()
    rec["status"] = "splitting"
    save_state(workdir / "state.json", state)

    parts = split_file(dl, workdir / "parts" / name, CHUNK)
    rec["parts"] = [{k: v for k, v in p.items() if k != "file"} for p in parts]
    for prec in rec["parts"]:  # resume: reuse pieces already uploaded for identical part bytes
        old = previous_parts.get(prec["sha256"])
        if old and old.get("piece_cid"):
            prec.update({k: old[k] for k in ("root_cid", "piece_cid", "copies", "uploaded_at") if k in old})
            log(f"part {prec['index']} already on Filecoin as {old['piece_cid']}, skipping upload")
    rec["status"] = "uploading"
    save_state(workdir / "state.json", state)

    if dry_run:
        rec["status"] = "dry-run"
        save_state(workdir / "state.json", state)
        log(f"dry run: would upload {len(parts)} parts")
        return rec

    def upload(p, prec):
        meta = {"chainvault": "snapshot"}  # cap is 3 keys per piece; filecoin-pin adds name, the SDK adds ipfsRootCID
        r = pin_add(Path(p["file"]), meta)
        if len(r["copies"]) < COPIES:
            log(f"WARNING part {p['index']} has {len(r['copies'])} of {COPIES} copies on-chain (reduced redundancy)")
        with STATE_LOCK:  # never mutate a record while another thread serialises the state
            prec.update(r)
            prec["uploaded_at"] = now()
            prec["degraded"] = len(r["copies"]) < COPIES
            save_state(workdir / "state.json", state)

    todo = [(p, prec) for p, prec in zip(parts, rec["parts"]) if not prec.get("piece_cid")]
    if todo and not any(pr.get("copies") for pr in rec["parts"]) and not known_data_sets(state):
        # first ever upload for this wallet/provider set: run one part alone so each provider's data set
        # is created exactly once before parallel uploads try to reuse it
        p, prec = todo.pop(0)
        log(f"no data sets known yet; uploading part {p['index']} alone first")
        upload(p, prec)
    log(f"uploading {len(todo)} parts, {PARALLEL} at a time")
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futures = [pool.submit(upload, p, prec) for p, prec in todo]
        errors = [f.exception() for f in futures if f.exception()]
    if errors:
        raise RuntimeError(f"{len(errors)} part upload(s) failed: {errors[0]}")

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
    r = pin_add(mpath, {"chainvault": "manifest"})
    rec["manifest"] = {"path": str(mpath), "root_cid": r["root_cid"], "piece_cid": r["piece_cid"],
                       "copies": r["copies"], "parent_manifest_cid": parent_cid}
    rec["status"] = "done"
    rec["degraded_parts"] = sum(1 for p in rec["parts"] if p.get("degraded"))
    rec["completed_at"] = now()
    save_state(workdir / "state.json", state)
    log(f"archived {name}: manifest {r['root_cid']}")
    return rec


def prune_local(workdir, state):
    """Keep local files only for the newest KEEP_LOCAL completed snapshots and for a run still in progress."""
    done = sorted([s for s in state["snapshots"] if s["status"] in ("done", "pruned")], key=lambda s: s["height"])
    keep_download = {s["name"] for s in (done[-KEEP_LOCAL:] if KEEP_LOCAL > 0 else [])}
    in_progress = {s["name"] for s in state["snapshots"] if s["status"] in ("downloading", "splitting", "uploading")}
    for s in state["snapshots"]:
        dl = workdir / "downloads" / s["name"]
        parts = workdir / "parts" / s["name"]
        if s["name"] in in_progress:
            continue
        if parts.exists():
            log(f"removing local {parts}")
            shutil.rmtree(parts)
        if dl.exists() and s["name"] not in keep_download:
            log(f"removing local {dl}")
            dl.unlink()


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
        if not a.dry_run:
            prune_onchain(state)
            save_state(workdir / "state.json", state)
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
