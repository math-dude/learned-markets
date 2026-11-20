import base64, json, sys, urllib.request
url, path = sys.argv[1], sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else None
d = json.load(open(path))
def rpc(method, params):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))
ok = bad = 0
for i, (key, a) in enumerate(d.items()):
    if limit and i >= limit: break
    if a is None: continue
    data = a["data"]
    raw = base64.b64decode(data[0]) if isinstance(data, list) else base64.b64decode(data)
    r = rpc("surfnet_setAccount", [key, {"lamports": a["lamports"], "owner": a["owner"], "executable": a["executable"], "rentEpoch": 0, "data": raw.hex()}])
    if "error" in r:
        bad += 1
        if bad < 4: print(key, r["error"])
    else: ok += 1
print("ok", ok, "bad", bad)
