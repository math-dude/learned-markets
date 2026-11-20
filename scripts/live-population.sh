#!/usr/bin/env bash
# Enroll WALLETS population wallets in parallel, then run WORKERS sim-population processes.
# Worker 0 also launches coins. Expects the env exported by scripts/live-chungus.sh.
set -uo pipefail
cd "$(dirname "$0")/.."
WALLETS=${WALLETS:-192} WORKERS=${WORKERS:-4} ENROLLERS=${ENROLLERS:-8}
export SERVICE_URL=${SERVICE_ORIGIN:-http://localhost:5173}
per=$(( (WALLETS + ENROLLERS - 1) / ENROLLERS ))
[ "${SKIP_ENROLL:-0}" = 1 ] || for ((s = 0; s < WALLETS; s += per)); do
  n=$(( s + per > WALLETS ? WALLETS - s : per ))
  node scripts/enroll-population.ts "$n" "$s" > "/tmp/lm-enroll-$s.log" 2>&1 &
done
wait
echo "enrolled $(cat /tmp/lm-enroll-*.log | grep -c '"enrolled"') wallets"
# Traders per market per batch. One keeps settlement inside the batch that follows, so the board's
# last cleared batch stays right behind the clock; 3+ with position setup exceed the 1232-byte packet.
cap=${PER_MARKET:-1}
per=$(( (WALLETS + WORKERS - 1) / WORKERS ))
# Real pump.fun order flow when the tapes exist (scripts/build-pump-replay.py); REPLAY= keeps the crowd model.
REPLAY=${REPLAY-.pump-replay.jsonl.gz}
replay=(); [ -n "$REPLAY" ] && [ -f "$REPLAY" ] && replay=(--replay "$REPLAY")
for ((w = 0; w < WORKERS; w++)); do
  launch=(--launch-max 0)
  [ "$w" -eq 0 ] && launch=(--launch-min "${LAUNCH_MIN:-0.2}" --launch-max "${LAUNCH_MAX:-0.5}" --max-live "${MAX_LIVE:-60}")
  .venv/bin/python scripts/sim-population.py --start $(( w * per )) --wallets "$per" --per-batch "$cap" --shard "$w" --shards "$WORKERS" \
    --service http://127.0.0.1:5173 "${launch[@]}" "${replay[@]}" ${POP_ARGS:-} > "/tmp/lm-pop-$w.log" 2>&1 &
done
wait
