"""Grade markets side by side on the same seeds and crowd.

Markets: "pump" (bonding curve, orders one at a time, bots first), "curve"
(the same curve inside the batch auction), "rule" (rule-based quoter) and
"learned" (a trained quoter). The grade is chart health and who-pays-whom,
which are deliberately not the training reward. Example:

    uv run --all-packages python -m learned_markets_training.evaluate --quoter /data/eren/learned-markets/checkpoints/quoter-v1/final.zip --name v1
"""

from __future__ import annotations

import argparse
import json
from dataclasses import replace

import torch
from learned_markets_simulation.metrics import Recorder, chart_health, money
from learned_markets_simulation.params import ATTACKERS, SimConfig
from learned_markets_simulation.world import World
from stable_baselines3 import PPO

from .common import OUT, market_config, policy_fn, quoter_params, sim_config

MARKETS = ("pump", "curve", "rule", "learned")


def run_market(kind: str, act, seed: int, n_worlds: int, steps: int, sim: SimConfig) -> dict:
    cfg = market_config(n_worlds, baseline=kind in ("pump", "curve"))
    world = World(cfg, sim, seed=seed, quoter="params" if kind == "learned" else kind)
    rec = Recorder(world)
    for _ in range(steps):
        rec.add(world.step(quoter_params(world, act) if kind == "learned" else None))
    out = {"market": kind, **chart_health(rec), **money(rec)}
    del rec, world
    torch.cuda.empty_cache()
    return out


def table(rows: list[dict], keys: list[str], label: str = "market") -> str:
    head = f"| {label} | " + " | ".join(keys) + " |\n|" + " --- |" * (len(keys) + 1)
    fmt = lambda v: f"{v:.4g}" if isinstance(v, float) else str(v)
    body = "\n".join(f"| {r[label]} | " + " | ".join(fmt(r.get(k, "")) for k in keys) + " |" for r in rows)
    return head + "\n" + body


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quoter", default="", help="path to a trained quoter; omit to grade only the fixed markets")
    ap.add_argument("--name", default="eval")
    ap.add_argument("--worlds", type=int, default=64)
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=20_001)
    ap.add_argument("--scenario-worlds", type=int, default=32)
    ap.add_argument("--scenario-steps", type=int, default=1200)
    ap.add_argument("--skip-scenarios", action="store_true")
    ap.add_argument("--markets", default=",".join(MARKETS))
    args = ap.parse_args()

    out_dir = OUT / "eval" / args.name
    out_dir.mkdir(parents=True, exist_ok=True)
    act = policy_fn(PPO.load(args.quoter, device="cuda")) if args.quoter else None
    markets = [m for m in args.markets.split(",") if m != "learned" or act is not None]
    sim = sim_config()

    rows = [run_market(m, act, args.seed, args.worlds, args.steps, sim) for m in markets]
    (out_dir / "standard.json").write_text(json.dumps(rows, indent=1))
    health = ["reward_per_batch", "tracking_error", "1_top10_share", "2_traders_per_coin_batch", "3_variance_ratio",
              "4_transient_vol", "5_gap_p999", "6_collapse_share", "7_half_recovered_60", "8_amihud_per_sol"]  # fmt: skip
    cash = ["pnl_sol_per_person/noise", "pnl_sol_per_person/retail", "pnl_sol_per_person/informed",
            "attacker_profit_sol_per_seat", "reserve_pnl_sol_per_world", "trapped_at_death_sol_per_world",
            "fees_sol_per_world"]  # fmt: skip
    regimes = [k for k in rows[0] if k.startswith("tracking_error/")]
    md = [f"# Evaluation `{args.name}`", "", f"{args.worlds} worlds x {args.steps} batches, seed {args.seed}, mixed attackers.",
          "", "## Chart health", "", table(rows, health), "", "## Money (SOL)", "", table(rows, cash),
          "", "## Tracking error by regime", "", table(rows, regimes)]  # fmt: skip

    if not args.skip_scenarios:
        scen = []
        for script in range(len(ATTACKERS)):
            s2 = replace(sim, attacker_script=max(script, 1), attacker_rate=1.0 if script else 0.0, n_attacker_seats=2)
            for m in markets:
                r = run_market(m, act, args.seed + 1, args.scenario_worlds, args.scenario_steps, s2)
                r["scenario"] = ATTACKERS[script]
                scen.append(r)
                print(
                    json.dumps(
                        {
                            k: r[k]
                            for k in ("scenario", "market", "attacker_profit_sol_per_seat", "attacker_exit_fee_rate")
                        }
                    ),
                    flush=True,
                )
        (out_dir / "scenarios.json").write_text(json.dumps(scen, indent=1))
        keys = ["attacker_profit_sol_per_seat", "attacker_exit_fee_rate", "pnl_sol_per_person/retail", "5_gap_p999",
                "1_top10_share", "tracking_error", "reserve_pnl_sol_per_world", "reward_per_batch"]  # fmt: skip
        md += [
            "",
            "## Behaviour scenarios",
            "",
            "Two attacker seats per world run one script each; `none` is the clean reference.",
        ]
        for name in ATTACKERS:
            md += ["", f"### {name}", "", table([r for r in scen if r["scenario"] == name], keys)]

    (out_dir / "report.md").write_text("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
