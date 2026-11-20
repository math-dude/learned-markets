"""Cut real pump.fun trade tapes for the population runner's --replay mode.

Reads one exported Jetstreamer epoch (pump_creates.parquet, pump_trades.parquet) and writes
one gzipped JSON line per coin: its first minutes of real trades as
[seconds since first trade, wallet, is_buy, lamports]. Only coins created inside the epoch
with enough early trading are kept, so every tape starts at a launch.

    uv run --with duckdb python scripts/build-pump-replay.py /data/ssd/jetstreamer/export/epoch=1089 .pump-replay.jsonl.gz
"""

import argparse
import gzip
import json

import duckdb

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("epoch_dir")
parser.add_argument("out")
parser.add_argument("--coins", type=int, default=800)
parser.add_argument("--seconds", type=int, default=1800, help="length of each tape")
parser.add_argument("--min-trades", type=int, default=80)
parser.add_argument("--max-trades", type=int, default=4000)
args = parser.parse_args()

db = duckdb.connect()
db.execute("SET threads=8")
rows = db.execute(
    f"""
    WITH t AS (
        SELECT mint, slot, tx_index, ev_idx, "user" AS wallet, is_buy, sol_amount,
               min(slot) OVER (PARTITION BY mint) AS first_slot
        FROM read_parquet('{args.epoch_dir}/pump_trades.parquet')
        WHERE mint IN (SELECT mint FROM read_parquet('{args.epoch_dir}/pump_creates.parquet'))
    ), early AS (
        SELECT * FROM t WHERE (slot - first_slot) * 0.4 < {args.seconds}
    ), picked AS (
        SELECT mint FROM early GROUP BY mint
        HAVING count(*) BETWEEN {args.min_trades} AND {args.max_trades} AND count(DISTINCT wallet) >= 20
        ORDER BY hash(mint) LIMIT {args.coins}
    )
    SELECT mint, round((slot - first_slot) * 0.4, 1), wallet, is_buy, sol_amount
    FROM early WHERE mint IN (SELECT mint FROM picked) ORDER BY mint, slot, tx_index, ev_idx
    """
).fetchall()

coins, trades = 0, 0
with gzip.open(args.out, "wt") as out:
    current, tape = None, []
    for mint, at, wallet, is_buy, lamports in [*rows, (None, 0, "", False, 0)]:
        if mint != current:
            if tape:
                out.write(json.dumps({"mint": current, "trades": tape}, separators=(",", ":")) + "\n")
                coins, trades = coins + 1, trades + len(tape)
            current, tape = mint, []
        tape.append([float(at), wallet, bool(is_buy), int(lamports)])
print(f"{coins} coins, {trades} trades -> {args.out}")
