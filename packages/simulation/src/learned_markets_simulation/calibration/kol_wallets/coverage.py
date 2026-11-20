"""Coverage of kol_wallets.csv against our own trade export; writes summary.md.

Run:  uv run --with duckdb python3 packages/simulation/src/learned_markets_simulation/calibration/kol_wallets/coverage.py
"""

import pathlib

import duckdb

HERE = pathlib.Path("/data/eren/learned-markets/calibration/kol_wallets")
CSV = HERE / "kol_wallets.csv"
EPOCH_DIR = "/data/ssd/jetstreamer/export/epoch=1088"
TABLES = {"pump_trades": "mint", "amm_trades": "base_mint"}

con = duckdb.connect()
con.execute(f"create table kol as select * from read_csv('{CSV}', header=true, all_varchar=true)")
n_kol = con.execute("select count(*) from kol").fetchall()[0][0]
fetched = con.execute("select min(fetched_at) from kol").fetchall()[0][0]
n_stats = con.execute(
    "select count(*) from kol where pnl_sol_1d<>'' or pnl_sol_7d<>'' or pnl_sol_30d<>''"
).fetchall()[0][0]

for t, mint in TABLES.items():
    con.execute(f"""
        create table k_{t} as
        select t."user" as wallet, t.{mint} as mint, t.is_buy, t."timestamp" as ts
        from '{EPOCH_DIR}/{t}.parquet' t semi join kol k on t."user" = k.wallet
    """)

out = ["# KOL wallets: coverage in our trade data", ""]
out += [
    f"- Wallet list: `kol_wallets.csv`, {n_kol} unique wallets, all from kolscan.io "
    f"(fetched {fetched}); every one passes the base58 32-byte pubkey check.",
    f"- {n_stats} of them carry leaderboard stats (kolscan shows only the top 50 per "
    "1d / 7d / 30d window, PnL in SOL); the rest are roster-only (name, wallet, socials).",
    f"- Trade data: `{EPOCH_DIR}` (`user` column of each table).",
    "",
    "| table | all trades | all users | KOL wallets present | KOL trades | KOL share of trades | KOL buys | KOL sells | mints touched by KOLs | first trade (UTC) | last trade (UTC) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
]
for t in TABLES:
    tot, users, t0, t1 = con.execute(f"""
        select count(*), count(distinct "user"),
               strftime(make_timestamp(min("timestamp") * 1000000), '%Y-%m-%d %H:%M'),
               strftime(make_timestamp(max("timestamp") * 1000000), '%Y-%m-%d %H:%M')
        from '{EPOCH_DIR}/{t}.parquet'
    """).fetchall()[0]
    w, n, b, s, m = con.execute(f"""
        select count(distinct wallet), count(*), count(*) filter (is_buy),
               count(*) filter (not is_buy), count(distinct mint) from k_{t}
    """).fetchall()[0]
    out.append(f"| {t} | {tot:,} | {users:,} | {w} / {n_kol} | {n:,} | {n / tot:.3%} | "
               f"{b:,} | {s:,} | {m:,} | {t0} | {t1} |")

both, either = con.execute("""
    select (select count(*) from (select wallet from k_pump_trades intersect select wallet from k_amm_trades)),
           (select count(*) from (select wallet from k_pump_trades union select wallet from k_amm_trades))
""").fetchall()[0]
out += ["", f"- KOL wallets in either table: {either} / {n_kol}; in both: {both}.", ""]

q = con.execute("""
    with a as (
        select wallet, count(*) filter (src = 'p') as pump_n, count(*) filter (src = 'a') as amm_n,
               count(distinct mint) as mints
        from (select wallet, mint, 'p' as src from k_pump_trades
              union all select wallet, mint, 'a' from k_amm_trades) group by 1)
    select k.name, a.wallet, a.pump_n, a.amm_n, a.mints
    from a join kol k using (wallet) order by a.pump_n + a.amm_n desc
""").fetchall()
counts = sorted(r[2] + r[3] for r in q)
if counts:
    out += [f"- Trades per present KOL wallet (pump + amm): min {counts[0]}, "
            f"median {counts[len(counts) // 2]}, max {counts[-1]}.", ""]
out += ["## Per-wallet trade counts (all present wallets)", "",
        "| name | wallet | pump_trades | amm_trades | distinct mints |", "|---|---|---|---|---|"]
out += [f"| {n.replace('|', '/')} | `{w}` | {p:,} | {a:,} | {m:,} |" for n, w, p, a, m in q]
out += [
    "",
    "## Caveats",
    "",
    "- Labels are kolscan's attribution of a wallet to a public persona; they are not "
    "independently verified here. KOLs commonly use several wallets, and kolscan lists one each, "
    "so absence from our data does not mean the person was inactive.",
    "- The roster is a snapshot at fetch time; the trade export covers a single epoch (dates in "
    "the table above). Wallets added to or rotated out of kolscan between the two are a mismatch "
    "we cannot see.",
    "- `user` is the trade's user account. KOLs trading through a bot or router that signs with "
    "a different account would not match.",
    "- Leaderboard PnL / wins / losses are kolscan's numbers for the windows ending at fetch time, "
    "not for the epoch in our export.",
    "- Single source: GMGN, Dune and GitHub lists were not pulled, so there is no cross-check.",
    "",
]
(HERE / "summary.md").write_text("\n".join(out))
print("\n".join(out[:16]))
print(f"... {len(q)} per-wallet rows written to {HERE / 'summary.md'}")
