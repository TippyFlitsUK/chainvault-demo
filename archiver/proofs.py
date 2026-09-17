#!/usr/bin/env python3
"""Poll PDPVerifier on calibnet for every data set the archive uses and write proofs.json for the site."""
import json, os, sys, time, urllib.request
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

RPC = os.environ.get("CV_RPC_URL", "https://api.calibration.node.glif.io/rpc/v1")
PDP_VERIFIER = os.environ.get("CV_PDP_VERIFIER", "0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C")
WARM_STORAGE = os.environ.get("CV_WARM_STORAGE", "0x02925630df557F957f70E112bA06e50965417CA0")  # FilecoinWarmStorageService, calibnet
GET_SERVICE_PRICE = "0x5482bdf9"  # getServicePrice() -> (pricePerTiBPerMonthNoCDN, ...) in USDFC, 18 decimals
EPOCH_SECONDS = 30
SEL = {  # function selectors, PDPVerifier ABI from @filoz/synapse-core
    "dataSetLive": "0xca759f27",
    "getDataSetLastProvenEpoch": "0x04595c1a",
    "getNextChallengeEpoch": "0x6ba4608f",
    "getDataSetLeafCount": "0xa531998c",
    "getChallengeRange": "0x89208ba9",
    "getDataSetStorageProvider": "0x21b7cd1c",
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"content-type": "application/json", "User-Agent": "chainvault-proofs/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if "error" in d:
        raise RuntimeError(d["error"])
    return d["result"]


def call(fn, set_id):
    data = SEL[fn] + f"{set_id:064x}"
    return rpc("eth_call", [{"to": PDP_VERIFIER, "data": data}, "latest"])


def u256(hexstr):
    return int(hexstr, 16) if hexstr and hexstr != "0x" else 0


def data_sets_in(state):
    ids = {}
    for s in state.get("snapshots", []):
        for part in s.get("parts", []):
            for c in part.get("copies", []):
                if "data_set_id" in c and not c.get("removed"):
                    ids.setdefault(c["data_set_id"], {"provider_id": c.get("provider_id"), "pieces": 0, "bytes": 0})
                    ids[c["data_set_id"]]["pieces"] += 1
                    ids[c["data_set_id"]]["bytes"] += part.get("size", 0)
        m = s.get("manifest") or {}
        for c in m.get("copies", []):
            if "data_set_id" in c:
                ids.setdefault(c["data_set_id"], {"provider_id": c.get("provider_id"), "pieces": 0, "bytes": 0})
                ids[c["data_set_id"]]["pieces"] += 1
    return ids


def main():
    workdir = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CV_WORKDIR", str(Path.home() / "chainvault")))
    state = json.loads((workdir / "state.json").read_text()) if (workdir / "state.json").exists() else {"snapshots": []}
    prev = json.loads((workdir / "proofs.json").read_text()) if (workdir / "proofs.json").exists() else {"data_sets": {}}
    head = u256(rpc("eth_blockNumber", []))
    out = {"network": "calibration", "pdp_verifier": PDP_VERIFIER, "head_epoch": head, "head_time": now(), "data_sets": {}}
    try:
        raw = rpc("eth_call", [{"to": WARM_STORAGE, "data": GET_SERVICE_PRICE}, "latest"])
        out["pricing"] = {"price_per_tib_month_usdfc": int(raw[2:66], 16) / 1e18, "source": WARM_STORAGE, "checked_at": now()}
    except Exception as e:
        out["pricing"] = prev.get("pricing") or {"error": str(e)}
    for set_id, info in sorted(data_sets_in(state).items()):
        try:
            live = u256(call("dataSetLive", set_id)) == 1
            last = u256(call("getDataSetLastProvenEpoch", set_id))
            nxt = u256(call("getNextChallengeEpoch", set_id))
            leaves = u256(call("getDataSetLeafCount", set_id))
            rng = u256(call("getChallengeRange", set_id))
            sp = u256(call("getDataSetStorageProvider", set_id))
            rec = {"live": live, "last_proven_epoch": last, "next_challenge_epoch": nxt, "leaf_count": leaves,
                   "challenge_range": rng, "storage_provider_id": sp,
                   "last_proven_seconds_ago": (head - last) * EPOCH_SECONDS if last else None,
                   "next_challenge_in_seconds": (nxt - head) * EPOCH_SECONDS if nxt else None,
                   "provider_id": info["provider_id"], "pieces": info["pieces"], "bytes": info["bytes"],
                   "checked_at": now()}
            old = prev.get("data_sets", {}).get(str(set_id), {})
            hist = old.get("proof_history", [])
            if last and (not hist or hist[-1] != last):
                hist = (hist + [last])[-200:]
            rec["proof_history"] = hist
            rec["proofs_observed"] = len(hist)
            out["data_sets"][str(set_id)] = rec
        except Exception as e:
            out["data_sets"][str(set_id)] = {"error": str(e), "provider_id": info["provider_id"], "checked_at": now()}
    ds = [d for d in out["data_sets"].values() if "error" not in d]
    out["totals"] = {
        "data_sets": len(out["data_sets"]), "live": sum(1 for d in ds if d["live"]),
        "bytes_under_proof": sum(d["bytes"] for d in ds), "pieces": sum(d["pieces"] for d in ds),
        "proofs_observed": sum(d["proofs_observed"] for d in ds),
        "latest_proof_seconds_ago": min([d["last_proven_seconds_ago"] for d in ds if d["last_proven_seconds_ago"] is not None] or [None]),
    }
    tmp = workdir / "proofs.tmp"
    tmp.write_text(json.dumps(out, indent=2)); tmp.replace(workdir / "proofs.json")
    print(f"[{now()}] head {head}, {len(out['data_sets'])} data sets, {out['totals']['live']} live")


if __name__ == "__main__":
    main()
