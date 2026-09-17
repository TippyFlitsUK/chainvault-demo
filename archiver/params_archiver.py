#!/usr/bin/env python3
"""ChainVault proof-parameter archiver: proofs.filecoin.io parameter set -> Filecoin PDP SPs -> manifest per file.

Reads the parameters.json manifest Lotus and Curio use, downloads each file from a mirror, verifies the manifest
digest (blake2b-512 truncated to 16 bytes, exactly what the nodes check), splits it into pieces, uploads with
filecoin-pin and records a ChainVault manifest keyed by the file's original CID. State: <workdir>/params_state.json.
"""
import argparse, fcntl, hashlib, json, os, shutil, subprocess, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import archiver as core  # env file, filecoin-pin wrapper, split, log

MANIFEST_URL = os.environ.get("CV_PARAMS_MANIFEST_URL", "https://raw.githubusercontent.com/filecoin-project/filecoin-ffi/master/parameters.json")
MIRROR = os.environ.get("CV_PARAMS_MIRROR", "https://filecoin-proofs.chainsafe.dev/ipfs/").rstrip("/") + "/"
UA = core.UA
PARAMS_PROVIDERS = [p for p in os.environ.get("CV_PARAMS_PROVIDERS", "9").split(",") if p]
PARAMS_COPIES = int(os.environ.get("CV_PARAMS_COPIES", "1"))


def blake2b16_file(path):
    h = hashlib.blake2b(digest_size=64)
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()[:32]


def head_size(url):
    req = urllib.request.Request(url, method="HEAD", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get("Content-Length") or 0)


def load_state(path):
    if path.exists():
        return json.loads(path.read_text())
    return {"network": core.NETWORK, "manifest_url": MANIFEST_URL, "mirror": MIRROR, "files": {}, "updated_at": None}


def save_state(path, state):
    with core.STATE_LOCK:
        state["updated_at"] = core.now()
        tmp = path.with_suffix(".tmp"); tmp.write_text(json.dumps(state, indent=2)); tmp.replace(path)


def archive_file(name, meta, workdir, state, spath):
    rec = state["files"].setdefault(name, {"name": name, "cid": meta["cid"], "digest": meta["digest"], "sector_size": meta.get("sector_size", 0)})
    previous_parts = {p["sha256"]: p for p in rec.get("parts", []) if p.get("sha256")}
    rec.update({"status": "downloading", "started_at": core.now(), "error": None, "parts": [], "manifest": None})
    save_state(spath, state)
    url = MIRROR + meta["cid"]
    size = rec.get("size") or head_size(url)
    rec["size"] = size; rec["source_url"] = url
    dl = workdir / "params_downloads" / name
    core.download(url, dl, size)
    core.log(f"verifying blake2b digest of {name}")
    got = blake2b16_file(dl)
    if got != meta["digest"]:
        dl.unlink(missing_ok=True)
        raise RuntimeError(f"digest mismatch {got} != {meta['digest']}")
    rec["verified_at"] = core.now(); rec["status"] = "splitting"; save_state(spath, state)
    parts = core.split_file(dl, workdir / "params_parts" / name, core.CHUNK)
    rec["parts"] = [{k: v for k, v in p.items() if k != "file"} for p in parts]
    for prec in rec["parts"]:
        old = previous_parts.get(prec["sha256"])
        if old and old.get("piece_cid"):
            prec.update({k: old[k] for k in ("root_cid", "piece_cid", "copies", "uploaded_at") if k in old})
    rec["status"] = "uploading"; save_state(spath, state)

    def upload(p, prec):
        r = core.pin_add(Path(p["file"]), {"chainvault": "params"}, PARAMS_PROVIDERS, PARAMS_COPIES)
        with core.STATE_LOCK:
            prec.update(r); prec["uploaded_at"] = core.now(); prec["degraded"] = len(r["copies"]) < PARAMS_COPIES
            save_state(spath, state)

    todo = [(p, prec) for p, prec in zip(parts, rec["parts"]) if not prec.get("piece_cid")]
    core.log(f"{name}: uploading {len(todo)} parts, {core.PARALLEL} at a time")
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=core.PARALLEL) as pool:
        futures = [pool.submit(upload, p, prec) for p, prec in todo]
        errors = [f.exception() for f in futures if f.exception()]
    if errors:
        raise RuntimeError(f"{len(errors)} part upload(s) failed: {errors[0]}")
    manifest = {
        "version": core.MANIFEST_VERSION, "object_type": "PROOF_PARAMS", "name": name, "original_cid": meta["cid"],
        "digest_blake2b512_16": meta["digest"], "sector_size": meta.get("sector_size", 0), "size": size,
        "source_url": url, "chunk_bytes": core.CHUNK,
        "parts": [{"index": p["index"], "size": p["size"], "sha256": p["sha256"], "root_cid": p["root_cid"],
                   "piece_cid": p["piece_cid"], "copies": p["copies"]} for p in rec["parts"]],
        "created_at": core.now(),
    }
    mdir = workdir / "params_manifests"; mdir.mkdir(exist_ok=True)
    mpath = mdir / f"{name}.manifest.json"; mpath.write_text(json.dumps(manifest, indent=2))
    r = core.pin_add(mpath, {"chainvault": "params-manifest"}, PARAMS_PROVIDERS, PARAMS_COPIES)
    rec["manifest"] = {"path": str(mpath), "root_cid": r["root_cid"], "piece_cid": r["piece_cid"], "copies": r["copies"]}
    rec["degraded_parts"] = sum(1 for p in rec["parts"] if p.get("degraded"))
    rec["status"] = "done"; rec["completed_at"] = core.now(); save_state(spath, state)
    core.log(f"archived {name} ({size/1e9:.2f} GB, {len(parts)} parts): manifest {r['root_cid']}")
    dl.unlink(missing_ok=True); shutil.rmtree(workdir / "params_parts" / name, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=os.environ.get("CV_WORKDIR", str(Path.home() / "chainvault")))
    ap.add_argument("--only", help="archive just this file name")
    ap.add_argument("--max-files", type=int, default=0, help="stop after this many files (0 = all remaining)")
    a = ap.parse_args()
    workdir = Path(a.workdir); workdir.mkdir(parents=True, exist_ok=True)
    lock = open(workdir / ".params.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        core.log("another params run holds the lock; exiting"); return 0
    spath = workdir / "params_state.json"
    state = load_state(spath)
    manifest = core.http_json(MANIFEST_URL)
    state["manifest_entries"] = len(manifest)
    pending = {n: m for n, m in manifest.items() if state["files"].get(n, {}).get("status") != "done" and (not a.only or n == a.only)}
    for n, m in pending.items():
        rec = state["files"].setdefault(n, {"name": n, "cid": m["cid"], "digest": m["digest"], "sector_size": m.get("sector_size", 0)})
        if not rec.get("size"):
            try:
                rec["size"] = head_size(MIRROR + m["cid"])
            except Exception as e:
                core.log(f"HEAD failed for {n}: {e}")
        rec.setdefault("status", "pending")
    save_state(spath, state)
    order = sorted(pending, key=lambda n: state["files"][n].get("size") or 0)  # small first so the page fills quickly
    core.log(f"{len(order)} of {len(manifest)} parameter files still to archive")
    done_now = 0
    for n in order:
        try:
            archive_file(n, manifest[n], workdir, state, spath)
        except Exception as e:
            rec = state["files"][n]; rec["status"] = "failed"; rec["error"] = str(e); rec["failed_at"] = core.now()
            save_state(spath, state); core.log(f"FAILED {n}: {e}")
            shutil.rmtree(workdir / "params_parts" / n, ignore_errors=True)
        done_now += 1
        if a.max_files and done_now >= a.max_files:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
