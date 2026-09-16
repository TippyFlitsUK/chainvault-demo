#!/usr/bin/env python3
"""ChainVault rehydrate: pull a snapshot back off Filecoin PDP providers, verify it, optionally import into Forest.

Every step logs one line; the demo site streams this log live.
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

UA = "chainvault-rehydrate/0.1"


def now():
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def log(msg):
    print(f"[{now()}] {msg}", flush=True)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def fetch(url, dest):
    t0 = time.time()
    subprocess.run(["curl", "-sS", "-L", "-A", UA, "--retry", "3", "-o", str(dest), url], check=True)
    dt = time.time() - t0
    size = dest.stat().st_size
    log(f"  fetched {size/1e6:.1f} MB in {dt:.1f}s ({size/1e6/max(dt,0.01):.1f} MB/s)")
    return size


def unpack_car(car, outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["npx", "--yes", "ipfs-car", "unpack", str(car), "--output", str(outdir)], check=True, capture_output=True)
    files = [p for p in outdir.rglob("*") if p.is_file()]
    if len(files) != 1:
        raise RuntimeError(f"expected one file in CAR, found {len(files)}")
    return files[0]


def load_manifest(a, workdir):
    if a.manifest_file:
        return json.loads(Path(a.manifest_file).read_text())
    if a.manifest_url:
        log(f"fetching manifest from {a.manifest_url}")
        req = urllib.request.Request(a.manifest_url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    if a.manifest_piece:
        if not a.provider_url:
            raise SystemExit("--manifest-piece needs --provider-url")
        log(f"fetching manifest piece {a.manifest_piece} from {a.provider_url}")
        with tempfile.TemporaryDirectory() as td:
            car = Path(td) / "manifest.car"
            fetch(f"{a.provider_url.rstrip('/')}/piece/{a.manifest_piece}", car)
            f = unpack_car(car, Path(td) / "out")
            return json.loads(f.read_text())
    state = json.loads((workdir / "state.json").read_text())
    done = [s for s in state["snapshots"] if s["status"] == "done"]
    if not done:
        raise SystemExit("no archived snapshot in state.json")
    if a.name:
        s = next(x for x in done if x["name"] == a.name)
    else:
        s = max(done, key=lambda x: x["height"])
    return json.loads(Path(s["manifest"]["path"]).read_text())


def provider_urls(workdir, a):
    urls = {}
    p = workdir / "providers.json"
    if p.exists():
        for pr in json.loads(p.read_text())["providers"]:
            urls[pr["id"]] = pr["service_url"]
    if a.provider_url and a.provider_id:
        urls[a.provider_id] = a.provider_url
    return urls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default=os.environ.get("CV_WORKDIR", str(Path.home() / "chainvault")))
    ap.add_argument("--latest", action="store_true")
    ap.add_argument("--name")
    ap.add_argument("--manifest-file")
    ap.add_argument("--manifest-url", help="any URL returning the manifest JSON (e.g. an IPFS gateway by root CID)")
    ap.add_argument("--manifest-piece", help="manifest piece CID, fetched from --provider-url")
    ap.add_argument("--provider-url")
    ap.add_argument("--provider-id", type=int, help="prefer this provider for part retrieval")
    ap.add_argument("--out", help="output snapshot path (default <workdir>/rehydrated/<name>)")
    ap.add_argument("--forest-bin", default=os.environ.get("CV_FOREST_BIN"))
    ap.add_argument("--forest-args", default=os.environ.get("CV_FOREST_ARGS", "--chain calibnet --halt-after-import"))
    ap.add_argument("--keep-parts", action="store_true")
    a = ap.parse_args()
    workdir = Path(a.workdir)

    t_start = time.time()
    log("ChainVault rehydrate starting")
    m = load_manifest(a, workdir)
    name = m["snapshot_name"]
    log(f"manifest: {name} height {m['end_height']} chain {m['chain_id']} parts {len(m['parts'])} size {m['size']/1e9:.2f} GB")
    log(f"expected sha256 {m['sha256']}")
    urls = provider_urls(workdir, a)
    out = Path(a.out) if a.out else workdir / "rehydrated" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="chainvault-rehydrate-", dir=str(out.parent)))
    try:
        with open(out, "wb") as sink:
            for part in m["parts"]:
                copies = part.get("copies", [])
                order = sorted(copies, key=lambda c: 0 if c.get("provider_id") == a.provider_id else 1)
                cands = [(c["provider_id"], urls.get(c["provider_id"])) for c in order if urls.get(c.get("provider_id"))]
                if not cands:
                    raise RuntimeError(f"no known provider URL for part {part['index']} (copies {copies})")
                got = None
                for pid, base in cands:
                    car = tmp / f"part{part['index']:03d}.car"
                    log(f"part {part['index']+1}/{len(m['parts'])}: GET {base}/piece/{part['piece_cid']} (provider {pid})")
                    try:
                        fetch(f"{base.rstrip('/')}/piece/{part['piece_cid']}", car)
                        f = unpack_car(car, tmp / f"part{part['index']:03d}")
                        h = sha256_file(f)
                        if h != part["sha256"]:
                            raise RuntimeError(f"sha256 mismatch on part {part['index']}: {h}")
                        log(f"  sha256 OK {h[:16]}…")
                        got = f
                        break
                    except Exception as e:
                        log(f"  provider {pid} failed: {e}")
                if got is None:
                    raise RuntimeError(f"all providers failed for part {part['index']}")
                with open(got, "rb") as src:
                    shutil.copyfileobj(src, sink, 1 << 22)
                if not a.keep_parts:
                    car.unlink(missing_ok=True); shutil.rmtree(tmp / f"part{part['index']:03d}", ignore_errors=True)
        log("verifying full snapshot sha256")
        h = sha256_file(out)
        if h != m["sha256"]:
            raise RuntimeError(f"FULL SHA256 MISMATCH {h}")
        log(f"SNAPSHOT VERIFIED {out} ({out.stat().st_size/1e9:.2f} GB) in {time.time()-t_start:.0f}s")
    finally:
        if not a.keep_parts:
            shutil.rmtree(tmp, ignore_errors=True)
    if a.forest_bin:
        cmd = [a.forest_bin] + a.forest_args.split() + ["--import-snapshot", str(out)]
        log("$ " + " ".join(cmd))
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            print("    " + line.rstrip(), flush=True)
        p.wait()
        log(f"forest exited {p.returncode}")
        return p.returncode
    log("no --forest-bin given; stopping after verification")
    return 0


if __name__ == "__main__":
    sys.exit(main())
