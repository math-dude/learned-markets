"""Part A step 1: cluster pump.fun launches into memes and build hourly attention series.

Run:  uv run --no-project --with duckdb python3 packages/simulation/src/learned_markets_simulation/calibration/attention/build_series.py
Env:  LM_EXPORT (default /data/ssd/jetstreamer/export), LM_ATTN_OUT (default /data/eren/learned-markets/calibration/attention),
      LM_SKIP_TRADES=1 to skip the pump_trades join.

Clustering rule (deterministic, one key per launch):
  1. lower(name); drop every character that is not a Unicode letter or digit
     (same idea as data/sql/vamps.sql, which uses [^a-z0-9]; extended to non-Latin scripts).
  2. strip one leading "the"/"official" and one trailing "coin"/"token"/"onsolana"/"onsol"/"official",
     each only if at least 3 characters remain.
  3. if the result is empty, apply 1-2 to the symbol instead; if still empty the launch is dropped.
  meme = that key. vamps.sql keys on the symbol; we key on the name because tickers are far more
  generic (ticker "sol" covers 754 different names, "cat" 435).
"""
import os, time, duckdb

EXPORT = os.environ.get("LM_EXPORT", "/data/ssd/jetstreamer/export")
OUT = os.environ.get("LM_ATTN_OUT", "/data/eren/learned-markets/calibration/attention")
MIN_LAUNCHES = int(os.environ.get("LM_MIN_LAUNCHES", "20"))
PROLIFIC = 50  # a wallet with >= this many launches in the window counts as a launch bot
os.makedirs(OUT, exist_ok=True)
con = duckdb.connect()
con.execute("set threads=32")
t0 = time.time()

def norm(col):
    k0 = f"regexp_replace(lower({col}), '[^\\p{{L}}\\p{{N}}]', '', 'g')"
    k1 = f"(case when length(regexp_replace({k0}, '^(the|official)', '')) >= 3 then regexp_replace({k0}, '^(the|official)', '') else {k0} end)"
    k2 = f"(case when length(regexp_replace({k1}, '(coin|token|onsolana|onsol|official)$', '')) >= 3 then regexp_replace({k1}, '(coin|token|onsolana|onsol|official)$', '') else {k1} end)"
    return k2

con.execute(f"""
create table creates as
select mint, name, symbol, "user" as launcher, creator, timestamp as ts, epoch,
       case when {norm('name')} <> '' then {norm('name')} else {norm('symbol')} end as meme
from read_parquet('{EXPORT}/epoch=*/pump_creates.parquet', union_by_name=true)
""")
n_all, n_empty = con.execute("select count(*), count(*) filter (where meme = '') from creates").fetchall()[0]
con.execute("delete from creates where meme = ''")
w0, w1 = con.execute("select min(ts), max(ts) from creates").fetchall()[0]
print(f"launches={n_all} dropped_empty={n_empty} window={w0}..{w1} ({(w1-w0)/3600:.1f} h)")

# every cluster (any size) -> for new-meme arrival rates
con.execute(f"""
create table clusters as
with u as (select launcher, count(*) n from creates group by 1),
     top as (select meme, max(n) top_n from (select meme, launcher, count(*) n from creates group by 1, 2) group by 1)
select c.meme, mode(c.name) as display_name, mode(c.symbol) as display_symbol,
       count(*) as launches, count(distinct c.launcher) as distinct_launchers,
       min(c.ts) as first_ts, max(c.ts) as last_ts,
       count(distinct c.ts // 3600) as active_hours,
       count(*) filter (where c.ts < f.first_ts + 72 * 3600) as launches_72h,
       any_value(top.top_n) / count(*) as top_launcher_share,
       avg(case when u.n >= {PROLIFIC} then 1.0 else 0.0 end) as prolific_share
from creates c join u using (launcher) join top using (meme)
     join (select meme, min(ts) first_ts from creates group by 1) f using (meme)
group by c.meme
""")
con.execute(f"copy (select * from clusters order by launches desc) to '{OUT}/clusters_all.parquet' (format parquet)")
n_cl, n_big = con.execute(f"select count(*), count(*) filter (where launches >= {MIN_LAUNCHES}) from clusters").fetchall()[0]
print(f"clusters={n_cl} with>={MIN_LAUNCHES} launches={n_big}  [{time.time()-t0:.0f}s]")

con.execute(f"create table big as select meme, first_ts from clusters where launches >= {MIN_LAUNCHES}")
con.execute("create table mints as select c.mint, c.meme from creates c join big using (meme)")
con.execute(f"copy mints to '{OUT}/meme_mints.parquet' (format parquet)")
con.execute("""create table lh as select meme, ts // 3600 * 3600 as hour_ts, count(*) launches,
               count(distinct launcher) distinct_launchers from creates join big using (meme) group by 1, 2""")

con.execute(f"copy (select meme, ts from creates join big using (meme) order by meme, ts) to '{OUT}/meme_launch_times.parquet' (format parquet)")

if os.environ.get("LM_SKIP_TRADES") == "1":
    con.execute("create table th (meme varchar, hour_ts bigint, n_trades bigint, distinct_buyers bigint, sol_volume double)")
else:
    con.execute(f"""
    create table th as
    select m.meme, t.timestamp // 3600 * 3600 as hour_ts, count(*) n_trades,
           count(distinct case when t.is_buy then t."user" end) distinct_buyers,
           sum(t.sol_amount) / 1e9 as sol_volume
    from read_parquet('{EXPORT}/epoch=*/pump_trades.parquet', union_by_name=true) t
    join mints m on t.mint = m.mint
    group by 1, 2""")
    print(f"trades joined rows={con.execute('select count(*) from th').fetchall()[0][0]}  [{time.time()-t0:.0f}s]")

# dense zero-filled grid: each meme from its first launch hour to the end of the window
con.execute(f"""
copy (
  select b.meme, g.hour_ts::bigint as hour_ts,
         coalesce(lh.launches, 0) as launches, coalesce(lh.distinct_launchers, 0) as distinct_launchers,
         coalesce(th.n_trades, 0) as n_trades, coalesce(th.distinct_buyers, 0) as distinct_buyers,
         coalesce(th.sol_volume, 0.0) as sol_volume
  from big b
  join (select unnest(range({w0 // 3600 * 3600}, {w1 // 3600 * 3600 + 1}, 3600)) as hour_ts) g
    on g.hour_ts >= b.first_ts // 3600 * 3600
  left join lh on lh.meme = b.meme and lh.hour_ts = g.hour_ts
  left join th on th.meme = b.meme and th.hour_ts = g.hour_ts
  order by b.meme, g.hour_ts
) to '{OUT}/meme_hourly.parquet' (format parquet, compression zstd)""")
print(f"wrote {OUT}/meme_hourly.parquet and clusters_all.parquet  [{time.time()-t0:.0f}s]")
for r in con.execute("select meme, launches, distinct_launchers, active_hours, round(top_launcher_share,2), round(prolific_share,2) from clusters order by launches desc limit 25").fetchall():
    print(r)
print(con.execute(f"""select count(*), count(*) filter (where top_launcher_share>=0.5), count(*) filter (where prolific_share>=0.5),
   count(*) filter (where prolific_share>=0.8), count(*) filter(where active_hours>=200) from clusters where launches >= {MIN_LAUNCHES}""").fetchall())
print(con.execute(f"select quantile_cont(prolific_share,[0.1,0.25,0.5,0.75,0.9]) from clusters where launches >= {MIN_LAUNCHES}").fetchall())
print(con.execute("select count(*), sum(n) from (select launcher, count(*) n from creates group by 1) where n>=50").fetchall())
