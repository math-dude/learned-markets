"""Rank top-level programs in pump_txs by tx count and distinct signers.

usage: uv run --with duckdb python3 01_program_stats.py 1086-1088
Writes <out_dir>/program_stats.parquet (every program) and prints the top 80.
"""
import sys

from common import INFRA, PUMP, connect, files, out_dir, parse_epochs

epochs = parse_epochs(sys.argv[1:])
con = connect()
out = f"{out_dir()}/program_stats.parquet"
con.execute(f"""
copy (
  with t as (
    select signer, success, list_distinct(programs) as progs
    from read_parquet({files('pump_txs', epochs)})
  ), u as (
    select signer, success, unnest(progs) as program_id from t
  ), ps as (  -- exact distinct signers via (program, signer) pre-aggregation
    select program_id, signer, count(*) as n, sum(success::int) as n_ok
    from u group by all
  )
  select program_id, sum(n)::bigint as tx_count, sum(n_ok)::bigint as ok_count,
         count(*)::bigint as distinct_signers, max(n)::bigint as top_signer_txs
  from ps group by 1 order by tx_count desc
) to '{out}' (format parquet)
""")
skip = set(INFRA) | set(PUMP)
rows = con.execute(f"select * from '{out}'").fetchall()
total = con.execute(f"select count(*) from read_parquet({files('pump_txs', epochs)})").fetchall()[0][0]
print(f"epochs {epochs}: {total} txs, {len(rows)} distinct top-level programs")
print(f"{'program_id':45s} {'txs':>11s} {'ok%':>5s} {'signers':>9s} {'top1%':>6s}")
by_tx = [r for r in rows if r[0] not in skip][:80]
by_sg = sorted((r for r in rows if r[0] not in skip), key=lambda r: -r[3])[:80]
seen = set()
for r in by_tx + by_sg:
    if r[0] in seen:
        continue
    seen.add(r[0])
    print(f"{r[0]:45s} {r[1]:11d} {100*r[2]/r[1]:5.1f} {r[3]:9d} {100*r[4]/r[1]:6.1f}")
print("-- infra / pump --")
for r in rows:
    if r[0] in skip:
        print(f"{r[0]:45s} {r[1]:11d} {100*r[2]/r[1]:5.1f} {r[3]:9d}  {(INFRA | PUMP)[r[0]]}")
