"""Write summary.md from the outputs of 01 and 03.

usage: uv run --with duckdb python3 04_summary.py 1074-1089
(the epoch list is used for the header and for the scan that breaks the `direct`
class down by program set).
"""
import csv
import sys

from common import connect, files, out_dir, parse_epochs
from importlib import import_module
from summary_notes import NOTES

L = import_module("03_label_wallets")
LABELS = L.LABELS
# Suggested (not applied) cut for the `direct` class: keep as human-like if all hold.
CUT_TX_PER_DAY = 50      # direct txs per active day
CUT_OK_SHARE = 0.5       # share of direct txs that succeed
CUT_SNIPE0 = 0.2         # share of bonding-curve buys landing in the coin's create slot


def md(rows, head):
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for r in rows:
        out.append("| " + " | ".join(
            f"{x:,.2f}" if isinstance(x, float) else f"{x:,}" if isinstance(x, int) else str(x)
            for x in r) + " |")
    return "\n".join(out)


def main():
    scan = "--no-scan" not in sys.argv  # --no-scan skips the pump_txs pass (program-set table)
    epochs = parse_epochs([a for a in sys.argv[1:] if not a.startswith("--")])
    od = out_dir()
    con = connect()
    q = lambda s: con.execute(s).fetchall()
    parts = f"read_parquet('{od}/wallet_label_parts/e=*.parquet')"
    W = f"'{od}/wallet_labels.parquet'"
    human = (f"(direct_tx_per_active_day <= {CUT_TX_PER_DAY} and direct_ok_share >= {CUT_OK_SHARE} "
             f"and coalesce(direct_snipe0_share, 0) <= {CUT_SNIPE0})")
    S = []
    tot = q(f"select sum(n_tx)::bigint, sum(n_ok)::bigint, sum(bc_sol + amm_sol) from {parts}")[0]
    nw = q(f"select count(*) from {W}")[0][0]
    S.append(f"# pump.fun wallet labels: bot / terminal / user\n\n"
             f"Epochs {epochs[0]}-{epochs[-1]} ({len(epochs)} epochs, about {2 * len(epochs)} days). "
             f"{tot[0]:,} pump/PumpSwap transactions ({tot[1]:,} successful), {nw:,} signers, "
             f"{tot[2]:,.0f} SOL traded (bonding curve + SOL-quoted PumpSwap pools).\n\n"
             "A wallet here is the transaction's fee payer (`signer`). Labels come from the "
             "top-level programs of each transaction; see `program_labels.csv` for the program table "
             "and the caveats at the end.\n")

    S.append("## Transaction labels\n")
    S.append(md(q(f"""
        select label, sum(n_tx)::bigint, round(100 * sum(n_tx) / {tot[0]}, 2),
               sum(n_ok)::bigint, round(100 * sum(n_ok) / {tot[1]}, 2),
               round(100 * sum(n_ok) / sum(n_tx), 1),
               round(sum(bc_sol + amm_sol)), round(100 * sum(bc_sol + amm_sol) / {tot[2]}, 2)
        from {parts} group by 1 order by 2 desc"""),
        ["tx label", "txs", "% txs", "ok txs", "% ok txs", "ok rate %", "SOL volume", "% volume"]))

    S.append("\n## Wallet labels (majority tx label)\n")
    S.append(md(q(f"""
        select label, count(*), round(100 * count(*) / {nw}, 2),
               sum(n_tx)::bigint, round(100 * sum(n_tx) / {tot[0]}, 2),
               round(sum(sol_volume)), round(100 * sum(sol_volume) / {tot[2]}, 2),
               sum(mixed::int), round(median(n_tx)), round(median(tx_per_active_day), 1)
        from {W} group by 1 order by 2 desc"""),
        ["wallet label", "wallets", "% wallets", "txs", "% txs", "SOL volume", "% volume",
         f"mixed (<{L.MIXED_BELOW:.0%} majority)", "median txs", "median txs/active day"]))

    S.append("\n## The `direct` class (only pump / PumpSwap at top level)\n")
    S.append("Wallets whose majority label is `direct`, bucketed by direct txs per active day "
             "(a day is 216,000 slots).\n")
    S.append(md(q(f"""
        select case when d <= 5 then '1: <=5' when d <= 20 then '2: 5-20' when d <= 50 then '3: 20-50'
                    when d <= 200 then '4: 50-200' when d <= 1000 then '5: 200-1000' else '6: >1000' end,
               count(*), sum(n_direct)::bigint, round(sum(direct_sol_volume)),
               round(100 * sum(direct_ok_share * n_direct) / sum(n_direct), 1),
               round(100 * sum(n_snipe0) / nullif(sum(n_buy_known), 0), 2),
               round(100 * sum(direct_cb_share * n_direct) / sum(n_direct), 1),
               round(100 * sum(direct_lighthouse_share * n_direct) / sum(n_direct), 1),
               round(median(direct_med_fee)), round(median(direct_med_cu))
        from (select *, direct_tx_per_active_day d from {W} where label = 'direct')
        group by 1 order by 1"""),
        ["direct txs / active day", "wallets", "direct txs", "SOL volume", "ok rate %",
         "% buys in create slot", "% txs with ComputeBudget", "% txs with Lighthouse",
         "median of wallet median fee (lamports)", "median of wallet median CU"]))

    S.append(f"\n### Suggested cut-off (not applied to the stored labels)\n\n"
             f"Treat a `direct` wallet as human-like if direct txs per active day <= {CUT_TX_PER_DAY}, "
             f"direct success share >= {CUT_OK_SHARE:.0%} and share of bonding-curve buys in the coin's "
             f"create slot <= {CUT_SNIPE0:.0%}; otherwise bot-like. Effect on `direct` wallets:\n")
    S.append(md(q(f"""
        select case when {human} then 'human-like' else 'bot-like' end, count(*),
               sum(n_direct)::bigint, round(sum(direct_sol_volume))
        from {W} where label = 'direct' group by 1 order by 1"""),
        ["direct split", "wallets", "direct txs", "SOL volume"]))
    S.append("\nWhich rule removes how much (wallets failing each rule, not exclusive):\n")
    S.append(md(q(f"""
        select sum((direct_tx_per_active_day > {CUT_TX_PER_DAY})::int),
               sum((direct_ok_share < {CUT_OK_SHARE})::int),
               sum((coalesce(direct_snipe0_share, 0) > {CUT_SNIPE0})::int)
        from {W} where label = 'direct'"""),
        [f"> {CUT_TX_PER_DAY} txs/day", f"ok share < {CUT_OK_SHARE:.0%}", f"create-slot buys > {CUT_SNIPE0:.0%}"]))

    S.append("\n## Human-like flow under the suggested cut\n")
    S.append("`user` + `terminal` + human-like `direct` wallets, against everything else "
             "(`unknown_public` and `unknown` kept separate).\n")
    S.append(md(q(f"""
        select case when label in ('user', 'terminal') then label
                    when label = 'direct' and {human} then 'direct (human-like)'
                    when label = 'direct' then 'direct (bot-like)' else label end,
               count(*), round(100 * count(*) / {nw}, 2), sum(n_tx)::bigint,
               round(100 * sum(n_tx) / {tot[0]}, 2), round(sum(sol_volume)),
               round(100 * sum(sol_volume) / {tot[2]}, 2)
        from {W} group by 1 order by 2 desc"""),
        ["group", "wallets", "% wallets", "txs", "% txs", "SOL volume", "% volume"]))

    if scan:
        S.append("\n## `direct` transactions by top-level program set\n")
        S.append("System at top level next to a pump call usually means an extra SOL transfer in the "
                 "transaction: a Jito/validator tip, or a terminal's fee transfer. This is the only trace "
                 "of fee-wallet terminals visible in this data.\n")
        S.append(md(q(f"""
            with d as (
              select signer, success, list_sort(list_distinct(programs)) c
              from read_parquet({files('pump_txs', epochs)})
              where len(list_filter(programs, p -> p not in ('{"', '".join(set(L.INFRA) | set(L.PUMP))}'))) = 0)
            select list_contains(c, '11111111111111111111111111111111') has_system,
                   list_contains(c, '{L.CB}') has_cb, list_contains(c, '{L.LIGHTHOUSE}') has_lh,
                   count(*), round(100 * avg(success::int), 1), approx_count_distinct(signer)
            from d group by 1, 2, 3 order by 4 desc"""),
            ["System", "ComputeBudget", "Lighthouse", "txs", "ok rate %", "signers (approx)"]))

    S.append("\n## Top router programs\n")
    rows = [r for r in csv.DictReader(open(f"{od}/program_labels.csv"))
            if r["class"] not in ("infra", "pump")]
    S.append(md([(r["program_id"], r["name"], r["class"], r["confidence"], int(r["tx_count"]),
                  int(r["distinct_signers"])) for r in rows[:40]],
                ["program", "name", "class", "confidence", "txs", "signers"]))
    cl = {}
    for r in rows:
        c = cl.setdefault(r["class"], [0, 0])
        c[0] += 1
        c[1] += int(r["tx_count"])
    S.append("\nPrograms per class (programs with >= 1000 txs or a curated name):\n")
    S.append(md([(k, v[0], v[1]) for k, v in sorted(cl.items(), key=lambda kv: -kv[1][1])],
                ["class", "programs", "txs (a tx can count in several)"]))

    S.append("\n" + NOTES)
    open(f"{od}/summary.md", "w").write("\n".join(S) + "\n")
    print(f"wrote {od}/summary.md")


if __name__ == "__main__":
    main()
