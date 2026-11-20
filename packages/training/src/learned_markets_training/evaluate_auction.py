"""Grade lever policies with the quoter frozen, on the same seeds and crowd.

Policies: "learned" (a trained auction network), "standin" (fixed levers, with
the launch fee following how full the line is) and "open" (an open door: no
launch fee and no line cap, so every launch that arrives is listed while a
slot is free). Cut rounds are a fixed mechanic and run under all three.

The launch arrival rate is a placeholder, so each policy is run at several
multiples of it. Example:

    uv run --all-packages python -m learned_markets_training.evaluate_auction \\
        --quoter artifacts/checkpoints/quoter-v3/final.zip --auction artifacts/checkpoints/auction-v1/final.zip
"""

from __future__ import annotations

import argparse
import json
from dataclasses import replace

import torch
from learned_markets_core import LINE
from learned_markets_core.lifecycle import default_lever_values, step_lever_values
from learned_markets_simulation.params import SimConfig
from learned_markets_simulation.reward import platform_reward
from learned_markets_simulation.world import World
from stable_baselines3 import PPO

from .common import OUT, market_config, policy_fn, quoter_params, sim_config
from .evaluate import table
from .features import AuctionStats, auction_features

SOL = 1e9


def run(
    mode: str, quoter, auction, seed: int, n_worlds: int, epochs: int, sim: SimConfig, n_slots: int, warm: int
) -> dict:
    cfg = replace(market_config(n_worlds), n_slots=n_slots)
    world = World(cfg, sim, seed=seed, quoter="params" if quoter else "rule")
    stats = AuctionStats(world)
    values = default_lever_values(cfg)
    if mode == "open":
        world.clamp_levers = False
        values[:, 0] = 0.0  # no launch fee
        values[:, 1] = n_slots - values[:, 2]  # the line may use every slot the seats do not
    acc = dict.fromkeys(
        ("reward", "traders", "closeness", "live", "line", "launches", "refused", "cuts", "deaths", "trapped", "fee"),
        0.0,
    )
    steps = 0
    for epoch in range(epochs):
        if mode == "learned":
            with torch.no_grad():
                move = auction.policy._predict(auction_features(world, stats), deterministic=True).long() - 1
            values = step_lever_values(values, move)
        stats.reset()
        for _ in range(cfg.epoch):
            out = world.step(quoter_params(world, quoter), None if mode == "standin" else values)
            stats.add(out)
            if epoch < warm:
                continue
            live = world.state.stage > 0
            acc["reward"] += float(platform_reward(out.reward).mean())
            acc["traders"] += float(out.result.traders.sum(1).float().mean())
            acc["closeness"] += float((out.closeness * live).sum() / live.sum().clamp(min=1))
            acc["live"] += float(live.sum(1).float().mean())
            acc["line"] += float((world.state.stage == LINE).sum(1).float().mean())
            acc["launches"] += float(out.events.launched.sum(1).float().mean())
            acc["refused"] += float(out.events.launch_refused.float().mean())
            acc["cuts"] += float((out.events.reason == 1).sum(1).float().mean())
            acc["deaths"] += float((out.events.reason >= 2).sum(1).float().mean())
            acc["trapped"] += float(out.events.trapped.double().mean() / SOL)
            acc["fee"] += float(world.lever_values[:, 0].mean() / SOL)
            steps += 1
    per_batch = ("reward", "traders", "closeness", "live", "line", "fee")
    row = {k: (v / steps if k in per_batch else v / steps * cfg.epoch) for k, v in acc.items()}
    return {
        "policy": mode, "slots": n_slots,
        "reward_per_batch": row["reward"], "traders_per_batch": row["traders"], "closeness": row["closeness"],
        "live_coins": row["live"], "line_coins": row["line"], "launch_fee_sol": row["fee"],
        "launches_per_epoch": row["launches"], "refused_per_epoch": row["refused"], "cuts_per_epoch": row["cuts"],
        "deaths_per_epoch": row["deaths"], "trapped_sol_per_epoch": row["trapped"],
    }  # fmt: skip


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quoter", default="")
    ap.add_argument("--auction", default="", help="trained auction network; omit to grade only the fixed policies")
    ap.add_argument("--name", default="auction")
    ap.add_argument("--worlds", type=int, default=64)
    ap.add_argument("--epochs", type=int, default=16)
    ap.add_argument("--warm", type=int, default=4, help="epochs excluded from the averages")
    ap.add_argument("--seed", type=int, default=30_001)
    ap.add_argument("--rates", default="1,5,25", help="multiples of the placeholder launch arrival rate")
    ap.add_argument("--open-slots", type=int, default=64)
    args = ap.parse_args()

    quoter = policy_fn(PPO.load(args.quoter, device="cuda")) if args.quoter else None
    auction = PPO.load(args.auction, device="cuda") if args.auction else None
    base = sim_config()
    out_dir = OUT / "eval" / args.name
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for mult in [float(x) for x in args.rates.split(",")]:
        sim = replace(base, launch_rate=base.launch_rate * mult)
        cases = [("standin", 32), ("open", 32), ("open", args.open_slots)]
        if auction is not None:
            cases.insert(0, ("learned", 32))
        for mode, slots in cases:
            r = run(mode, quoter, auction, args.seed, args.worlds, args.epochs, sim, slots, args.warm)
            r["launch_rate_x"] = mult
            rows.append(r)
            print(json.dumps(r), flush=True)
            torch.cuda.empty_cache()
    (out_dir / "levers.json").write_text(json.dumps(rows, indent=1))
    keys = ["slots", "launch_rate_x", "reward_per_batch", "traders_per_batch", "closeness", "live_coins",
            "launches_per_epoch", "refused_per_epoch", "cuts_per_epoch", "trapped_sol_per_epoch", "launch_fee_sol"]  # fmt: skip
    md = f"# Lever policies `{args.name}`\n\n{args.worlds} worlds, {args.epochs} epochs ({args.warm} warm-up), seed {args.seed}.\n\n"
    md += table(rows, keys, label="policy") + "\n"
    (out_dir / "levers.md").write_text(md)
    print(md)


if __name__ == "__main__":
    main()
