#!/usr/bin/env bash
# Exports each epoch to Parquet once its run has ended successfully, using the ClickHouse
# server of whatever Jetstreamer run is live at the time. Epochs whose run ends after the last
# Jetstreamer exits are exported by the final pass (see README).
#
# Usage: export_loop.sh   (runs until killed; safe to restart)
set -uo pipefail
JS=/data/ssd/jetstreamer
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=$JS/export
LOG=$JS/run.log

while true; do
  # Epochs (or epoch ranges) whose run ended with exit 0 or was logged by the pipeline.
  grep -E "^=== END [0-9]+(-[0-9]+)? (exit=0|\(logged by pipeline\))" "$LOG" | awk '{print $3}' |
  while read -r r; do
    a=${r%-*}; b=${r#*-}
    for ((e = b; e >= a; e--)); do
      [ -f "$OUT/epoch=$e/_SUCCESS" ] && continue
      curl -sf http://127.0.0.1:8123/ping >/dev/null || continue
      echo "$(date -u +%FT%TZ) exporting $e" >>"$JS/export.log"
      if "$HERE/../sql/export.sh" "$e" "$OUT" >>"$JS/export.log" 2>&1; then
        echo "=== EXPORTED $e $(date -u +%FT%TZ)" >>"$LOG"
      fi
    done
  done
  sleep 300
done
