#!/usr/bin/env bash
# Start the live Surfpool demo on chungus in tmux sessions bound to 127.0.0.1.
#   scripts/live-chungus.sh            # (re)start attestation, backend, web and population
#   scripts/live-chungus.sh web        # restart only the named sessions
# Sessions: lm-attest (8787), lm-backend (8000), lm-web (vite 5173), lm-operator (auto-approval), lm-pump (pump.fun names), lm-pop (population runner).
# Population knobs: WALLETS WORKERS LAUNCH_MIN LAUNCH_MAX MAX_LIVE POP_ARGS; logs in /tmp/lm-*.log.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/node-v24.12.0-linux-x64/bin:$PATH"
ROOT=$(pwd)
ENVS="export PATH=$PATH LM_NETWORK=surfpool LM_RPC_URL=http://127.0.0.1:8899 DB_PATH=${DB_PATH:-attestation-surfpool.sqlite} \
LM_KEYS_DIR=keys LM_ATTESTATION_URL=http://127.0.0.1:8787 SERVICE_ORIGIN=${SERVICE_ORIGIN:-http://localhost:5173} \
LM_BATCH_SLOTS=${LM_BATCH_SLOTS:-10} LM_SETTLE_POLL=${LM_SETTLE_POLL:-0.5} LM_BATCH_ORDERS=${LM_BATCH_ORDERS:-4}"
# The trained quoter prices every batch when its export is present (LM_QUOTER= forces the fixed rule).
QUOTER=${LM_QUOTER-models/quoter-v3/quoter.pt}
[ -n "$QUOTER" ] && [ -f "$QUOTER" ] && ENVS="$ENVS LM_QUOTER=$QUOTER"
POPENV="WALLETS=${WALLETS:-192} WORKERS=${WORKERS:-4} LAUNCH_MIN=${LAUNCH_MIN:-0.2} LAUNCH_MAX=${LAUNCH_MAX:-0.5} MAX_LIVE=${MAX_LIVE:-40} PER_MARKET=${PER_MARKET:-1} SKIP_ENROLL=${SKIP_ENROLL:-0} POP_ARGS=\"${POP_ARGS:---replay-patience 3 --replay-max-gap 20}\""
declare -A CMD=(
  [attest]="HOST=127.0.0.1 PORT=8787 node apps/attestation-service/src/main.ts"
  [backend]=".venv/bin/uvicorn learned_markets_backend.chain_web:app --host 127.0.0.1 --port 8000"
  [web]="cd apps/web && LM_WEB_API=http://127.0.0.1:8000 VITE_LM_EXECUTION=chain VITE_LM_NETWORK=surfpool node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort"
  [operator]="SERVICE_URL=http://127.0.0.1:8787 node scripts/auto-operator.mjs"
  [pump]=".venv/bin/python scripts/pump-feed.py"
  [pop]="sleep 5; $POPENV scripts/live-population.sh"
)
targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(attest backend web operator pump pop)
for name in "${targets[@]}"; do
  tmux kill-session -t "lm-$name" 2>/dev/null || true
  [ "$name" = pop ] && { pkill -f scripts/sim-population.py || true; }
  tmux new-session -d -s "lm-$name" -c "$ROOT" "bash -c '$ENVS; { ${CMD[$name]}; } 2>&1 | tee -a /tmp/lm-$name.log'"
  echo "started lm-$name"
done
