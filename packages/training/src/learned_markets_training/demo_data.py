"""Export the time series behind the replay page as one small JSON file.

Three scenes, each the same crowd on pump's curve and on the learned market:
a whale trying to corner a coin, one meme of each kind with its hidden
interest, and where the money ends up over a full run.

    uv run --all-packages --all-extras python -m learned_markets_training.demo_data \\
        --quoter artifacts/checkpoints/quoter-gap5/final.zip --out artifacts/demo-data.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import replace

import numpy as np
from learned_markets_core import ROOKIE
from learned_markets_core.units import prices
from learned_markets_simulation.params import A_HOARDER, A_NONE, A_PUMPER, BATCH_SECONDS, REGIMES, RETAIL
from learned_markets_simulation.world import World
from stable_baselines3 import PPO

from .common import market_config, policy_fn, quoter_params, sim_config
from .figures import REGIME_TITLES, paired_run

SOL = 1e9


def _r(x, digits: int = 4) -> list:
    return [round(float(v), digits) for v in x]


def money_run(kind: str, act, seed: int, n_worlds: int, steps: int, every: int) -> dict:
    """A full market (line, launches, cuts, mixed attackers), sampled every `every` batches."""
    cfg = market_config(n_worlds, baseline=kind == "pump")
    world = World(cfg, sim_config(), seed=seed, quoter="pump" if kind == "pump" else "params")
    crowd = world.crowd
    A = world.sim.n_attacker_seats
    retail = crowd.kind == RETAIL
    retail[:, :A] &= crowd.attackers.script == A_NONE
    wealth0 = world.wealth()
    out = {"minutes": [], "retail": [], "dead": [], "fees": [], "top10": []}
    trapped = fees = 0.0
    for t in range(steps):
        step = world.step(quoter_params(world, act) if kind != "pump" else None)
        trapped += float(step.events.trapped.double().mean()) / SOL
        fees += float(step.result.fees.sum(1).double().mean()) / SOL
        if (t + 1) % every == 0:
            gain = world.wealth() - wealth0 - crowd.cum_topup.double()
            live = world.state.stage > 0
            out["minutes"].append((t + 1) * BATCH_SECONDS / 60)
            out["retail"].append(float(gain[retail].mean()) / SOL)
            out["dead"].append(trapped)
            out["fees"].append(fees)
            out["top10"].append(float(world.tape.top10[live].mean()) * 100)
    return {k: _r(v) for k, v in out.items()}


def play_by_play(kind: str, act, seed: int, script: int, steps: int, world_idx: int = 0) -> list[dict]:
    """What one attacking wallet asked for, what the market let through, and what it cost, batch by batch.

    Same setup as `paired_run` (six seated coins, no launches); follows seat 0 of one world.
    """
    cfg = replace(market_config(8, baseline=kind == "pump"), cut_round=10**9, epoch=10**9)
    sim = replace(
        sim_config(attacker_rate=1.0, attacker_script=script, n_attacker_seats=2),
        launch_rate=0.0,
        reflexivity=(0.0, 0.0),
    )
    world = World(cfg, sim, seed=seed, quoter="pump" if kind == "pump" else "params", initial_coins=6)
    world.state.stage[:, :6] = ROOKIE
    table = prices(world.dev)
    w, rows, start = world_idx, [], float(world.wealth()[world_idx, 0])
    for t in range(steps):
        params = quoter_params(world, act) if kind != "pump" else None
        cap = world.state.cap_tokens(world.quote(params).cap_share, cfg)
        tick_before, hold_before = world.state.tick.clone(), world.state.hold.clone()
        out = world.step(params)
        o, res = out.orders, out.result
        mine = ((o.w == w) & (o.p == 0)).nonzero().squeeze(1)
        if mine.numel() == 0 or int(o.qty[mine[0]].max()) == 0:
            continue
        i = mine[0]
        c = int(o.c[i])
        before, after = float(table[tick_before[w, c]]), float(table[world.state.tick[w, c]])
        held = int(hold_before[w, c, 0])
        rows.append({
            "t": t, "side": "buy" if int(o.side[i]) == 0 else "sell",
            "asked": int(o.qty[i].max()), "accepted": int(res.accepted[i].max()), "got": int(res.fill[i]),
            "room": max(int(cap[w, c]) - held, 0), "cap": int(cap[w, c]), "held_before": held,
            "holds": int(world.state.hold[w, c, 0]), "cash": round(-float(res.cash_delta[i]) / SOL, 4),
            "fee_rate": round(float(res.fee_rate[i]), 4), "fee": round(float(res.fee[i]) / SOL, 4),
            "price_move": round(after / before - 1, 4), "price": round(after / float(table[cfg.launch_tick]), 3),
            "others": int(res.traders[w, c]), "quoter_sold": int(res.q_sell[w, c]),
            "wealth": round((float(world.wealth()[w, 0]) - start) / SOL, 3),
        })  # fmt: skip
    return rows


def _pick(rows: list[dict], buys: tuple[int, ...]) -> list[dict]:
    """Keep the chosen buy batches and every sell, so the page steps through a readable number of plays."""
    return [r for r in rows if r["side"] == "sell" or r["t"] in buys]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quoter", required=True)
    ap.add_argument("--out", default="artifacts/demo-data.json")
    ap.add_argument("--seed", type=int, default=40_001)
    args = ap.parse_args()
    act = policy_fn(PPO.load(args.quoter, device="cuda"))

    hoard = sim_config(attacker_rate=1.0, attacker_script=A_HOARDER, n_attacker_seats=2)
    ours, pump = (paired_run(k, a, args.seed, 32, 360, hoard) for k, a in (("ours", act), ("pump", None)))
    share = lambda run: np.median(run["biggest"].max(axis=2) * 100, axis=1)
    whale = {
        "minutes": _r(np.arange(360) * BATCH_SECONDS / 60, 2),
        "pump": _r(share(pump), 2),
        "ours": _r(share(ours), 2),
    }

    clean = sim_config(attacker_rate=0.0)
    ours, pump = (paired_run(k, a, args.seed, 32, 1500, clean) for k, a in (("ours", act), ("pump", None)))
    err_o = np.abs(ours["logp"] - ours["logv"]).mean(0)
    err_p = np.abs(pump["logp"] - pump["logv"]).mean(0)
    memes, pick = [], slice(None, None, 5)
    for i, name in enumerate(REGIMES):
        mask = ours["regime"] == i
        if not mask.any():
            continue
        diff = (err_p - err_o)[mask]
        w, c = np.argwhere(mask)[np.argsort(diff)[len(diff) // 2]]  # the median meme of its kind
        memes.append({
            "key": name, "title": REGIME_TITLES[name], "memes": int(mask.sum()),
            "ours_closer_share": round(float((diff > 0).mean()), 3),
            "minutes": _r((np.arange(1500) * BATCH_SECONDS / 60)[pick], 2),
            "interest": _r(np.exp(ours["logv"][pick, w, c]), 3),
            "pump": _r(np.exp(pump["logp"][pick, w, c]), 3),
            "ours": _r(np.exp(ours["logp"][pick, w, c]), 3),
            "pump_off": round(float(np.expm1(err_p[w, c])), 3), "ours_off": round(float(np.expm1(err_o[w, c])), 3),
        })  # fmt: skip

    # Pump-and-dump: two wallets buy a new coin hard for 15 batches, wait 10, then dump.
    cabal = sim_config(attacker_rate=1.0, attacker_script=A_PUMPER, n_attacker_seats=2)
    T = 150
    ours, pump = (paired_run(k, a, args.seed, 32, T, cabal) for k, a in (("ours", act), ("pump", None)))
    W = np.arange(32)
    price = lambda run: np.exp(run["logp"][:, W, run["target"]])  # [T, W] target coin, multiple of launch
    peak_p, peak_o = price(pump).max(0), price(ours).max(0)
    same = pump["target"] == ours["target"]
    w = int(np.argsort(np.where(same, peak_p, -1))[-(same.sum() // 2) - 1])  # median world by pump's peak
    pnl = lambda run: np.median(run["seat_wealth"] - run["seat_wealth"][0], axis=1) / SOL
    pnd = {
        "minutes": _r(np.arange(T) * BATCH_SECONDS / 60, 2),
        "interest": _r(np.exp(ours["logv"][:, w, ours["target"][w]]), 3),
        "pump": _r(price(pump)[:, w], 3), "ours": _r(price(ours)[:, w], 3),
        "attacker_pump": _r(pnl(pump), 3), "attacker_ours": _r(pnl(ours), 3),
        "peak_pump_median": round(float(np.median(peak_p)), 2), "peak_ours_median": round(float(np.median(peak_o)), 2),
        "same_target_worlds": int(same.sum()), "buy_until_min": 15 * BATCH_SECONDS / 60, "dump_from_min": 25 * BATCH_SECONDS / 60,
    }  # fmt: skip

    money = {k: money_run(k, a, 20_001, 64, 2000, 20) for k, a in (("pump", None), ("ours", act))}
    plays = {
        "whale": {k: _pick(play_by_play(k, a, args.seed, A_HOARDER, 12), tuple(range(12))) for k, a in (("pump", None), ("ours", act))},
        "pnd": {k: _pick(play_by_play(k, a, args.seed, A_PUMPER, 60), (0, 1, 2, 5, 9, 14))[:14] for k, a in (("pump", None), ("ours", act))},
    }  # fmt: skip
    data = {"whale": whale, "memes": memes, "pnd": pnd, "money": money, "plays": plays,
            "note": "Simulated crowd calibrated on pump.fun data; identical crowd and seeds on both markets."}  # fmt: skip
    with open(args.out, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    last = lambda k, f: {m: money[m][f][-1] for m in money}
    print(json.dumps({"whale_end": {"pump": whale["pump"][-1], "ours": whale["ours"][-1]},
                      "retail_end": last(0, "retail"), "dead_end": last(0, "dead"), "fees_end": last(0, "fees"),
                      "top10_end": last(0, "top10"), "bytes": len(json.dumps(data)),
                      "pnd": {k: pnd[k] for k in ("peak_pump_median", "peak_ours_median", "same_target_worlds")},
                      "pnd_attacker_end": {"pump": pnd["attacker_pump"][-1], "ours": pnd["attacker_ours"][-1]},
                      "plays": {sc: {k: [(r["t"], r["side"], r["asked"], r["accepted"], r["got"], r["holds"], r["cash"], r["fee_rate"], r["price_move"], r["wealth"]) for r in v] for k, v in d.items()} for sc, d in plays.items()},
                      "pnd_example_peak": {"pump": max(pnd["pump"]), "ours": max(pnd["ours"]), "interest": max(pnd["interest"])}}, indent=1))  # fmt: skip


if __name__ == "__main__":
    main()
