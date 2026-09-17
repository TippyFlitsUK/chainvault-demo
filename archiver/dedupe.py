#!/usr/bin/env python3
"""One pass of duplicate cleanup for a PDP data set this archive uses.

Removes: extra copies of a piece CID this archive recorded (keeps one), and every piece of a snapshot
whose payload was pruned. Never touches a CID the state files do not know. filecoin-pin removes by CID
and resolves to one piece ID per call, and the provider applies scheduled removals at a proving-period
boundary, so this is designed to run repeatedly (cron) and does nothing while removals are still pending.
Exits 0 and retires its own cron line when the set is clean.
"""
import argparse, collections, json, os, re, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import archiver as core
import proofs

SEL_SCHEDULED = "0x6fa44692"  # getScheduledRemovals(uint256), PDPVerifier (toFunctionSelector via viem)


def scheduled_removals(set_id):
    raw = proofs.rpc("eth_call", [{"to": proofs.PDP_VERIFIER, "data": SEL_SCHEDULED + f"{set_id:064x}"}, "latest"])[2:]
    n = int(raw[64:128], 16)
    return [int(raw[128 + i * 64:192 + i * 64], 16) for i in range(n)]


def onchain_cids(set_id):
    out = subprocess.run([core.FILECOIN_PIN, "data-set", "piece-status", str(set_id), "--network", core.NETWORK], capture_output=True, text=True).stdout
    return collections.Counter(re.findall(r"PieceCID:\s*(\S+)", out))


def expectations(workdir, set_id):
    keep, pruned = set(), set()
    def walk(rec, target):
        for p in rec.get("parts", []):
            if p.get("piece_cid") and any(c.get("data_set_id") == set_id for c in p.get("copies", [])):
                target.add(p["piece_cid"])
        m = rec.get("manifest") or {}
        if m and any(c.get("data_set_id") == set_id for c in m.get("copies", [])):
            keep.add(m["piece_cid"])
    st = json.loads((workdir / "state.json").read_text()) if (workdir / "state.json").exists() else {"snapshots": []}
    for s in st["snapshots"]:
        walk(s, pruned if s["status"] == "pruned" else keep)
    ps = workdir / "params_state.json"
    if ps.exists():
        for f in json.loads(ps.read_text()).get("files", {}).values():
            walk(f, keep)
    return keep, pruned - keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-set", type=int, required=True)
    ap.add_argument("--workdir", default=os.environ.get("CV_WORKDIR", str(Path.home() / "chainvault")))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--retire-cron", action="store_true", help="remove this script's crontab line once the set is clean")
    a = ap.parse_args()
    workdir = Path(a.workdir)
    pending = scheduled_removals(a.data_set)
    if pending:
        core.log(f"data set {a.data_set}: {len(pending)} removals still scheduled on-chain; nothing to do this pass")
        return 0
    keep, pruned = expectations(workdir, a.data_set)
    onchain = onchain_cids(a.data_set)
    todo = []
    for cid, n in onchain.items():
        if cid in keep and n > 1:
            todo.append((cid, "duplicate", n - 1))
        elif cid in pruned:
            todo.append((cid, "pruned", n))
    untouched = {c: n for c, n in onchain.items() if c not in keep and c not in pruned}
    core.log(f"data set {a.data_set}: {sum(onchain.values())} pieces, {len(onchain)} CIDs; excess on {len(todo)} CIDs "
             f"({sum(x for _, k, x in todo if k == 'duplicate')} duplicates, {sum(x for _, k, x in todo if k == 'pruned')} pruned); "
             f"{len(untouched)} unknown CIDs left alone")
    if not todo:
        core.log("clean")
        if a.retire_cron:
            cur = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
            new = "\n".join(l for l in cur.splitlines() if "dedupe.py" not in l) + "\n"
            subprocess.run(["crontab", "-"], input=new, text=True)
            core.log("cron line retired")
        return 0
    if a.dry_run:
        return 0
    ok = fail = 0
    for cid, kind, _ in todo:  # one removal per CID per pass: the SDK resolves a CID to a single piece ID
        try:
            core.run_pin(["rm", "--network", core.NETWORK, "--data-set-id", str(a.data_set), "--piece", cid])
            ok += 1
        except Exception as e:
            fail += 1
            core.log(f"rm failed for {cid} ({kind}): {e}")
    core.log(f"scheduled {ok} removals, {fail} failed; next pass after the provider applies them")
    return 0


if __name__ == "__main__":
    sys.exit(main())
