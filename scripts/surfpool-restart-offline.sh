#!/usr/bin/env bash
# On chungus: snapshot the running Surfpool, then restart it --offline from that snapshot in tmux "surfpool".
# Offline Surfpool never asks mainnet about absent accounts, which otherwise stalls under 429s.
# The slot restarts near 0, so reset the backend DB afterwards (participants stay on chain).
set -euo pipefail
B=/data/ssd/jetstreamer/surfpool-bench
GENESIS=${GENESIS:-5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d}
D=$B/runs/offline-$(date +%H%M%S); mkdir -p "$D"; echo "$D" > /tmp/lm-offline-dir
cp $B/start.sh "$B/start.sh.bak-$(date +%H%M%S)"
rpc() { curl -s -m 120 -XPOST 127.0.0.1:8899 -H content-type:application/json -d "$1"; }
rpc '{"jsonrpc":"2.0","id":1,"method":"surfnet_exportSnapshot","params":[{"includeParsedAccounts":false,"filter":{"includeProgramAccounts":true,"includeAccounts":[],"excludeAccounts":[]},"scope":"network"}]}' > "$D/export.json"
python3 - "$D" <<'PY'
import json, sys
d = sys.argv[1]
e = json.load(open(d + "/export.json"))
v = e["result"]["value"]
print("slot", e["result"]["context"]["slot"], "accounts", len(v))
json.dump({k: x for k, x in v.items() if x is not None}, open(d + "/accounts.json", "w"))
assert v.get("nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz"), "learned_markets program missing from snapshot"
PY
PID=$(pgrep -x surfpool | head -1)
echo "stopping surfpool $PID"
kill -9 "$PID"
while [ -e "/proc/$PID" ]; do sleep 0.1; done
tmux kill-session -t surfpool 2>/dev/null || true
tmux new-session -d -s surfpool "$HOME/.local/bin/surfpool start --no-tui --no-deploy --offline --genesis-hash $GENESIS \
  --host 127.0.0.1 --port 8899 --ws-port 8900 --airdrop-amount 0 \
  --snapshot $D/accounts.json --log-path $D/logs 2>&1 | tee $D/surfpool.out"
for _ in $(seq 60); do rpc '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | grep -q result && break; sleep 0.5; done
rpc '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
echo
