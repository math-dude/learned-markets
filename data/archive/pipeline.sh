#!/usr/bin/env bash
# Download-then-replay pipeline: each epoch's CAR is fetched once to the HDD mirror, then the
# pump-events plugin runs over the local copy while the next epoch downloads. Once the mirror
# would pass CAP_BYTES, the remaining epochs are streamed from Old Faithful as before.
#
# Usage: pipeline.sh [first_epoch] [last_epoch]   (newest first, e.g. 1086 1060)
set -uo pipefail

FIRST="${1:-1086}"
LAST="${2:-1060}"
MIRROR=/data/oldfaithful
CAP_BYTES="${CAP_BYTES:-10000000000000}"   # 10 TB
JS=/data/ssd/jetstreamer
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG=$JS/run.log
PORT=8765

mirror_bytes() { du -sb "$MIRROR" | cut -f1; }
car_size() { curl -sfI "https://files.old-faithful.net/$1/epoch-$1.car" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}'; }

# 1. Mirror server (idempotent).
if ! curl -sf -o /dev/null -I "http://127.0.0.1:$PORT/"; then
  pgrep -f "serve_mirror.py $MIRROR" >/dev/null || nohup python3 "$HERE/serve_mirror.py" "$MIRROR" "$PORT" >>"$JS/mirror.log" 2>&1 &
fi

# 2. Downloader: newest first, stops saving once the cap would be exceeded.
download_loop() {
  for ((e = FIRST; e >= LAST; e--)); do
    [ -f "$MIRROR/$e/epoch-$e.car" ] && continue
    need=$(car_size "$e")
    if [ -z "$need" ] || (( $(mirror_bytes) + need > CAP_BYTES )); then
      echo "=== MIRROR cap reached before $e ($(mirror_bytes) bytes saved)" >>"$LOG"
      touch "$MIRROR/.cap-reached"
      return
    fi
    echo "=== DOWNLOAD START $e $(date -u +%FT%TZ)" >>"$LOG"
    until python3 "$HERE/fetch_epoch.py" "$e" "$MIRROR" >>"$JS/download-$e.log" 2>&1; do
      echo "=== DOWNLOAD retry $e $(date -u +%FT%TZ)" >>"$LOG"; sleep 60
    done
    echo "=== DOWNLOAD END $e $(date -u +%FT%TZ)" >>"$LOG"
  done
}
download_loop &
DL=$!

# 3. Wait for any jetstreamer run already in progress (only one may own ClickHouse).
#    PREV_RANGE / PREV_PARENT: an earlier run_all.sh chunk that was paused (SIGSTOP) so it
#    wouldn't start its next chunk; log its end and retire the paused loop.
while pgrep -f "target/release/jetstreamer" >/dev/null; do sleep 30; done
if [ -n "${PREV_RANGE:-}" ]; then
  echo "=== END $PREV_RANGE (logged by pipeline) $(date -u +%FT%TZ): $(grep 'firehose summary' "$JS/run-$PREV_RANGE.log" | tail -1 | cut -c1-200)" >>"$LOG"
  [ -n "${PREV_PARENT:-}" ] && kill -9 "$PREV_PARENT" 2>/dev/null
fi

# 4. Processor: replay each epoch locally when its CAR is ready; stream it once the cap is hit.
cd "$JS/src"
for ((e = FIRST; e >= LAST; e--)); do
  while [ ! -f "$MIRROR/$e/epoch-$e.car" ] && [ ! -f "$MIRROR/.cap-reached" ]; do sleep 30; done
  if [ -f "$MIRROR/$e/epoch-$e.car" ]; then
    src=local
    env_args=(JETSTREAMER_HTTP_BASE_URL="http://127.0.0.1:$PORT/"
              JETSTREAMER_COMPACT_INDEX_BASE_URL="http://127.0.0.1:$PORT/"
              JETSTREAMER_NETWORK_CAPACITY_MB=4000 JETSTREAMER_TURBO=1)
  else
    src=stream
    env_args=(JETSTREAMER_NETWORK_CAPACITY_MB=1000)
  fi
  echo "=== START $e ($src) $(date -u +%FT%TZ)" >>"$LOG"
  env "${env_args[@]}" ./target/release/jetstreamer "$e" --with-plugin pump-events >>"$JS/run-$e.log" 2>&1
  code=$?
  echo "=== END $e exit=$code $(date -u +%FT%TZ)" >>"$LOG"
  if [ $code -ne 0 ]; then
    echo "=== STOPPED on failure in $e; see run-$e.log for the resume slot" >>"$LOG"
    exit $code
  fi
done
wait $DL
echo "=== ALL DONE $(date -u +%FT%TZ)" >>"$LOG"
