"""Fetch on-chain metadata (upgrade authority, embedded security.txt) for candidate
router programs from a public RPC. Evidence for naming programs; cached in program_meta.json.

usage: uv run --with duckdb python3 02_program_meta.py [--top-tx 80] [--min-signers 300]
Needs program_stats.parquet from 01_program_stats.py.
"""
import base64
import json
import os
import re
import sys
import time
import urllib.request

from common import INFRA, PUMP, connect, out_dir

RPC = os.environ.get("SOLANA_RPC", "https://api.mainnet-beta.solana.com")
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def rpc(method, params):
    req = urllib.request.Request(RPC, json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        {"content-type": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                out = json.loads(r.read())
            if "error" in out:
                raise RuntimeError(out["error"])
            return out["result"]
        except Exception as e:  # rate limits on the public endpoint
            time.sleep(2 + 3 * attempt)
            err = e
    raise err


def meta(pid):
    acc = rpc("getAccountInfo", [pid, {"encoding": "base64"}])["value"]
    if acc is None:
        return {"exists": False}
    m = {"exists": True, "owner": acc["owner"], "executable": acc["executable"]}
    data = base64.b64decode(acc["data"][0])
    if acc["owner"] == "BPFLoaderUpgradeab1e11111111111111111111111" and len(data) >= 36:
        pd = b58(data[4:36])
        pacc = rpc("getAccountInfo", [pd, {"encoding": "base64"}])["value"]
        if pacc is None:
            m["closed"] = True
            return m
        data = base64.b64decode(pacc["data"][0])
        m["last_deploy_slot"] = int.from_bytes(data[4:12], "little")
        m["upgrade_authority"] = b58(data[13:45]) if data[12] == 1 else None
        data = data[45:]
    m["size"] = len(data)
    i = data.find(b"=======BEGIN SECURITY.TXT V1=======")
    if i >= 0:
        j = data.find(b"=======END SECURITY.TXT V1=======", i)
        parts = data[i + 35:j].split(b"\0")
        kv = dict(zip(parts[0::2], parts[1::2]))
        m["security_txt"] = {k.decode(errors="replace"): v.decode(errors="replace")[:200]
                             for k, v in kv.items() if k}
    # cheap hint: printable strings that look like product names / urls
    urls = set(re.findall(rb"https?://[\w./-]{4,60}", data))
    if urls:
        m["urls"] = sorted(u.decode() for u in urls)[:8]
    return m


def main():
    args = sys.argv[1:]
    top_tx = int(args[args.index("--top-tx") + 1]) if "--top-tx" in args else 80
    min_sg = int(args[args.index("--min-signers") + 1]) if "--min-signers" in args else 300
    od = out_dir()
    con = connect()
    skip = "', '".join(set(INFRA) | set(PUMP))
    ids = [r[0] for r in con.execute(f"""
        with s as (select * from '{od}/program_stats.parquet' where program_id not in ('{skip}'))
        (select program_id from s order by tx_count desc limit {top_tx})
        union
        (select program_id from s where distinct_signers >= {min_sg}
           and tx_count >= 1.2 * distinct_signers)
    """).fetchall()]
    path = f"{od}/program_meta.json"
    cache = json.load(open(path)) if os.path.exists(path) else {}
    for n, pid in enumerate(ids):
        if pid in cache:
            continue
        try:
            cache[pid] = meta(pid)
        except Exception as e:
            print("fail", pid, e, file=sys.stderr)
            continue
        if n % 10 == 0:
            json.dump(cache, open(path, "w"), indent=1)
        time.sleep(0.4)
    json.dump(cache, open(path, "w"), indent=1)
    print(f"{len(cache)} programs in {path}")


if __name__ == "__main__":
    main()
