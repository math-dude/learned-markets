"""Label pump transactions by routing program, then wallets by majority label.

usage: uv run --with duckdb python3 03_label_wallets.py 1074-1089 [--combine-only]
Needs program_stats.parquet (01_program_stats.py, same epoch list) and
program_labels_curated.csv (next to this file).

Outputs in out_dir():
  program_labels.csv          every non-infra program with tx_count >= 1000 or a curated name
  wallet_label_parts/e=<epoch>.parquet   per (signer, tx label) aggregates per epoch
  wallet_labels.parquet       one row per signer
  summary.md

Transaction label, first match wins over the tx's top-level programs:
  terminal        any known trading-terminal program
  bot             any private program (curated bot, or unnamed with <= PRIVATE_MAX signers)
  user            public aggregator / wallet router / official pump mobile router / public tool
  unknown_public  unnamed program with >= PUBLIC_MIN signers (or rotating-ID family)
  unknown         unnamed program in between
  bot             only other DEX programs called directly next to pump (hand-built multi-venue tx)
  direct          nothing but pump / PumpSwap and system-level programs
"""
import csv
import os
import sys

from common import HERE, INFRA, PUMP, connect, files, out_dir, parse_epochs

PRIVATE_MAX = 50     # unnamed program with <= this many distinct signers -> private bot
PUBLIC_MIN = 1000    # unnamed program with >= this many distinct signers -> unknown-public
RELAYER_MIN_TX = 1000  # with >= half of txs multi-signature -> relayer_suspect
MIXED_BELOW = 0.8    # wallet is "mixed" if its majority label has less than this tx share
LABELS = ["terminal", "bot", "user", "unknown_public", "unknown", "direct"]
WSOL = "So11111111111111111111111111111111111111112"
LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"
CB = "ComputeBudget111111111111111111111111111111"
# program class -> (tx label, priority; lower wins)
CLASS_TO_LABEL = {
    "terminal": ("terminal", 0), "bot": ("bot", 1), "unknown-private": ("bot", 1),
    "aggregator": ("user", 2), "official": ("user", 2), "public_tool": ("user", 2),
    "unknown-public": ("unknown_public", 3), "unknown": ("unknown", 4), "dex": ("bot", 5),
}


def program_classes(con, od):
    curated = {r["program_id"]: r for r in csv.DictReader(open(f"{HERE}/program_labels_curated.csv"))}
    rows = con.execute(f"select program_id, tx_count, ok_count, distinct_signers, top_signer_txs "
                       f"from '{od}/program_stats.parquet' order by tx_count desc").fetchall()
    table, cls = [], {}
    for pid, n, ok, sg, top in rows:
        if pid in INFRA or pid in PUMP:
            c = dict(name=(INFRA | PUMP)[pid], klass="infra" if pid in INFRA else "pump",
                     confidence="high", source="well known")
        elif pid in curated:
            r = curated[pid]
            c = dict(name=r["name"], klass=r["class"], confidence=r["confidence"], source=r["source"])
        elif sg <= PRIVATE_MAX:
            c = dict(name="unknown", klass="unknown-private", confidence="rule",
                     source=f"unnamed; <= {PRIVATE_MAX} distinct signers")
        elif sg >= PUBLIC_MIN or (sg > 500 and n < 1.2 * sg):
            fam = sg > 500 and n < 1.2 * sg
            c = dict(name="unknown (rotating-ID family, ~1 tx per signer)" if fam else "unknown",
                     klass="unknown-public", confidence="rule",
                     source="unnamed; one of ~600 near-identical program IDs each used once by "
                            "thousands of signers" if fam else f"unnamed; >= {PUBLIC_MIN} distinct signers")
        else:
            c = dict(name="unknown", klass="unknown", confidence="rule",
                     source=f"unnamed; {PRIVATE_MAX} < distinct signers < {PUBLIC_MIN}")
        cls[pid] = c["klass"]
        table.append(dict(program_id=pid, name=c["name"], **{"class": c["klass"]},
                          confidence=c["confidence"], source=c["source"], tx_count=n,
                          distinct_signers=sg, success_share=round(ok / n, 4),
                          top_signer_share=round(top / n, 4)))
    with open(f"{od}/program_labels.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(table[0]))
        w.writeheader()
        for r in table:
            if r["tx_count"] >= 1000 or r["confidence"] != "rule":
                w.writerow(r)
    return cls, table


def label_combo(progs, cls):
    best = ("direct", 9)
    for p in progs:
        lab = CLASS_TO_LABEL.get(cls.get(p, "unknown-private"))
        if lab and lab[1] < best[1]:
            best = lab
    return best[0]


def main():
    combine_only = "--combine-only" in sys.argv  # reuse existing per-epoch parts
    epochs = parse_epochs([a for a in sys.argv[1:] if not a.startswith("--")])
    od = out_dir()
    con = connect()
    cls, table = program_classes(con, od)
    if not combine_only:
        label_epochs(con, od, epochs, cls)
    combine(con, od, epochs)


def label_epochs(con, od, epochs, cls):

    # distinct top-level program sets -> label
    combos = con.execute(f"""
        select array_to_string(list_sort(list_distinct(programs)), ',') ck, count(*)
        from read_parquet({files('pump_txs', epochs)}) group by 1""").fetchall()
    con.execute("create table combo(ck varchar, label varchar, has_cb boolean, has_lh boolean)")
    con.executemany("insert into combo values (?,?,?,?)", [
        (ck, label_combo(ck.split(","), cls), CB in ck, LIGHTHOUSE in ck) for ck, _ in combos])
    print(f"{len(combos)} distinct program sets", flush=True)

    con.execute(f"""create table creates as select mint, min(slot) cslot
                    from read_parquet({files('pump_creates', epochs)}) group by 1""")
    os.makedirs(f"{od}/wallet_label_parts", exist_ok=True)
    for e in epochs:
        part = f"{od}/wallet_label_parts/e={e}.parquet"
        con.execute(f"""
        copy (
          with tx as (
            select slot, tx_index, signer, success, fee, n_signatures, compute_units,
                   array_to_string(list_sort(list_distinct(programs)), ',') ck
            from read_parquet({files('pump_txs', [e])})
          ), bc as (
            select t.slot, t.tx_index, sum(t.sol_amount) sol, count(*) n_ev,
                   sum((t.is_buy and c.cslot is not null)::int) n_buy_known,
                   sum((t.is_buy and c.cslot = t.slot)::int) n_snipe0,
                   sum((t.is_buy and c.cslot is not null and t.slot - c.cslot <= 2)::int) n_snipe2
            from read_parquet({files('pump_trades', [e])}) t left join creates c using (mint)
            group by 1, 2
          ), amm as (
            select slot, tx_index, count(*) n_ev,
                   sum(case when quote_mint = '{WSOL}' then quote_amount else 0 end) sol
            from read_parquet({files('amm_trades', [e])}) group by 1, 2
          )
          select tx.signer, combo.label, {e} as epoch,
                 count(*) n_tx, sum(success::int) n_ok,
                 sum(fee) fee_sum, sum(fee::bigint - 5000 * n_signatures) prio_fee_sum,
                 sum((n_signatures > 1)::int) n_multisig,
                 sum(has_cb::int) n_cb, sum(has_lh::int) n_lighthouse,
                 max((tx.slot // 216000) % 2 = 0)::int day_a,
                 max((tx.slot // 216000) % 2 = 1)::int day_b,
                 min(tx.slot) first_slot, max(tx.slot) last_slot,
                 approx_quantile(fee, 0.5) med_fee,
                 approx_quantile(compute_units, 0.5) med_cu,
                 approx_count_distinct(fee) n_fee_values,
                 coalesce(sum(bc.sol), 0) / 1e9 bc_sol, coalesce(sum(amm.sol), 0) / 1e9 amm_sol,
                 coalesce(sum(bc.n_ev), 0) + coalesce(sum(amm.n_ev), 0) n_trade_events,
                 coalesce(sum(bc.n_buy_known), 0) n_buy_known,
                 coalesce(sum(bc.n_snipe0), 0) n_snipe0, coalesce(sum(bc.n_snipe2), 0) n_snipe2
          from tx join combo using (ck)
          left join bc on bc.slot = tx.slot and bc.tx_index = tx.tx_index
          left join amm on amm.slot = tx.slot and amm.tx_index = tx.tx_index
          group by 1, 2
        ) to '{part}' (format parquet)""")
        print("epoch", e, "done", flush=True)



def combine(con, od, epochs):
    parts = "[" + ",".join(f"'{od}/wallet_label_parts/e={e}.parquet'" for e in epochs) + "]"
    lab_cols = ",\n".join(f"coalesce(sum(n_tx) filter (label = '{l}'), 0) n_{l}" for l in LABELS)
    con.execute(f"""
    copy (
      with sl as (  -- per signer x label over all epochs
        select signer, label, sum(n_tx) n_tx, sum(n_ok) n_ok, sum(bc_sol + amm_sol) sol,
               sum(n_trade_events) n_trade_events, sum(n_cb) n_cb, sum(n_lighthouse) n_lh,
               sum(n_buy_known) n_buy_known, sum(n_snipe0) n_snipe0, sum(n_snipe2) n_snipe2,
               sum(med_fee * n_tx) / sum(n_tx) med_fee, sum(med_cu * n_tx) / sum(n_tx) med_cu,
               sum(n_fee_values) n_fee_values, sum(prio_fee_sum) prio_fee_sum
        from read_parquet({parts}) group by 1, 2
      ), days as (  -- epochs are exactly two 216000-slot "days"
        select signer, sum(da + db) active_days,
               sum(dda + ddb) direct_active_days from (
          select signer, epoch, max(day_a) da, max(day_b) db,
                 coalesce(max(day_a) filter (label = 'direct'), 0) dda,
                 coalesce(max(day_b) filter (label = 'direct'), 0) ddb
          from read_parquet({parts}) group by 1, 2) group by 1
      ), w as (
        select signer, sum(n_tx) n_tx, sum(n_ok) n_ok, sum(sol) sol_volume,
               sum(n_trade_events) n_trade_events,
               {lab_cols},
               arg_max(label, n_tx) label, max(n_tx) / sum(n_tx) label_share,
               sum(n_buy_known) n_buy_known, sum(n_snipe0) n_snipe0, sum(n_snipe2) n_snipe2,
               sum(n_lh) n_lighthouse,
               any_value(n_ok / n_tx) filter (label = 'direct') direct_ok_share,
               any_value(sol) filter (label = 'direct') direct_sol_volume,
               any_value(n_trade_events) filter (label = 'direct') direct_trade_events,
               any_value(med_fee) filter (label = 'direct') direct_med_fee,
               any_value(med_cu) filter (label = 'direct') direct_med_cu,
               any_value(n_cb / n_tx) filter (label = 'direct') direct_cb_share,
               any_value(n_lh / n_tx) filter (label = 'direct') direct_lighthouse_share,
               any_value(prio_fee_sum / n_tx) filter (label = 'direct') direct_mean_prio_fee,
               any_value(n_snipe0 / nullif(n_buy_known, 0)) filter (label = 'direct') direct_snipe0_share,
               any_value(n_snipe2 / nullif(n_buy_known, 0)) filter (label = 'direct') direct_snipe2_share
        from sl group by 1
      ), ms as (
        select signer, sum(n_multisig) n_multisig from read_parquet({parts}) group by 1
      )
      select w.*, label_share < {MIXED_BELOW} as mixed, ms.n_multisig,
             -- fee payer for other people's trades (sponsored / intent-filled txs), not a trader
             (ms.n_multisig >= 0.5 * n_tx and n_tx >= {RELAYER_MIN_TX}) as relayer_suspect,
             days.active_days, days.direct_active_days,
             n_tx / days.active_days tx_per_active_day,
             n_direct / nullif(days.direct_active_days, 0) direct_tx_per_active_day,
             direct_trade_events / nullif(days.direct_active_days, 0) direct_trades_per_active_day
      from w join days using (signer) join ms using (signer)
    ) to '{od}/wallet_labels.parquet' (format parquet)""")
    print("wallet_labels.parquet written", flush=True)


if __name__ == "__main__":
    main()
