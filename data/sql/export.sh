#!/usr/bin/env bash
# Exports every pump-events table for one epoch to Parquet (deduplicated with FINAL).
# Talks to ClickHouse over HTTP, so it works against the server a running Jetstreamer spawned
# (never start a second server alongside a run: they share bin/).
#
# Usage: ./export.sh <epoch> [out_dir]
set -euo pipefail

EPOCH="${1:?usage: export.sh <epoch> [out_dir]}"
OUT="${2:-/data/ssd/jetstreamer/export}"
CH="${CH_URL:-http://127.0.0.1:8123/}"
FIRST=$(( EPOCH * 432000 ))
LAST=$(( FIRST + 431999 ))
DIR="$OUT/epoch=$EPOCH"
mkdir -p "$DIR"

curl -sf "${CH}ping" >/dev/null || { echo "ClickHouse not reachable at $CH" >&2; exit 2; }

for t in pump_creates pump_trades pump_completes amm_trades amm_pools token_deltas pump_txs; do
  exists=$(curl -sf "$CH" --data-binary "EXISTS TABLE $t")
  [ "$exists" = "1" ] || continue
  f="$DIR/$t.parquet"
  curl -sf "$CH?output_format_parquet_compression_method=zstd" --data-binary "
    SELECT * FROM $t FINAL
    WHERE slot BETWEEN $FIRST AND $LAST
    ORDER BY slot, tx_index
    FORMAT Parquet" > "$f.part"
  mv "$f.part" "$f"
  echo "$t -> $f ($(du -h "$f" | cut -f1))"
done
# Slot -> block time for this epoch.
curl -sf "$CH?output_format_parquet_compression_method=zstd" --data-binary "
  SELECT slot, block_time FROM jetstreamer_slot_status FINAL
  WHERE slot BETWEEN $FIRST AND $LAST ORDER BY slot FORMAT Parquet" > "$DIR/slot_times.parquet"
touch "$DIR/_SUCCESS"
