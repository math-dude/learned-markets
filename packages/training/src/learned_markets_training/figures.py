"""Pictures of one market against another, for people who do not read tables.

Three figures, written as PNGs:

1. same_meme.png: the same six memes (identical true-value paths) traded on
   pump's curve and on our market, one panel per regime.
2. scorecard.png: the standard evaluation's headline numbers, pump against ours.
3. hoarder.png: the largest single holder's share over time when two wallets
   try to buy everything.

    uv run --all-packages --all-extras python -m learned_markets_training.figures \\
        --quoter artifacts/checkpoints/quoter-gap5/final.zip --standard artifacts/eval/gap5/standard.json \\
        --pump-standard artifacts/eval/v3/standard.json --out docs/ai-gen/results/figures
"""

from __future__ import annotations

import argparse
import json
import textwrap
from dataclasses import replace
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import torch
from learned_markets_core import ROOKIE, SUPPLY
from learned_markets_simulation.params import A_HOARDER, BATCH_SECONDS, REGIMES, SimConfig
from learned_markets_simulation.world import World
from stable_baselines3 import PPO

from .common import market_config, policy_fn, quoter_params, sim_config

# Validated two-series palette (dataviz reference palette, slots 1 and 2) on its light surface.
OURS, PUMP = "#2a78d6", "#eb6834"
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e1"
N_COINS = 6
REGIME_TITLES = {
    "up_drift": "Meme that keeps growing",
    "down_drift": "Meme that launches hot and fades",
    "swings": "Meme with violent swings",
    "quiet": "Quiet meme",
    "info_jump": "Meme hit by real news",
    "near_dead": "Meme nobody wants",
}


def _style() -> None:
    plt.rcParams.update({
        "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
        "font.family": "DejaVu Sans", "font.size": 10, "text.color": INK, "axes.labelcolor": INK2,
        "axes.edgecolor": GRID, "xtick.color": INK2, "ytick.color": INK2, "axes.grid": True,
        "grid.color": GRID, "grid.linewidth": 0.8, "axes.spines.top": False, "axes.spines.right": False,
        "axes.titlesize": 11, "axes.titleweight": "bold", "axes.titlelocation": "left", "legend.frameon": False,
    })  # fmt: skip


def paired_run(kind: str, act, seed: int, n_worlds: int, steps: int, sim: SimConfig) -> dict:
    """Six seated coins per world, no launches, cuts or deaths, so both markets trade identical memes."""
    cfg = replace(market_config(n_worlds, baseline=kind == "pump"), cut_round=10**9, epoch=10**9)
    sim = replace(sim, launch_rate=0.0, reflexivity=(0.0, 0.0))
    world = World(cfg, sim, seed=seed, quoter="pump" if kind == "pump" else "params", initial_coins=N_COINS)
    world.state.stage[:, :N_COINS] = ROOKIE
    logp, logv, big, seats = [], [], [], []
    target = None
    for _ in range(steps):
        out = world.step(quoter_params(world, act) if kind != "pump" else None)
        if target is None:
            target = world.crowd.attackers.target[:, 0].cpu().numpy()  # the first coin seat 0 went after
        seats.append(world.wealth()[:, :2].mean(1).cpu())
        logp.append((torch.log(out.result.price.float()) - world.launch_x)[:, :N_COINS].cpu())
        logv.append(world.memes.log_value[:, :N_COINS].cpu())
        big.append((world.state.hold[:, :N_COINS].max(dim=2).values.float() / SUPPLY).cpu())
    return {
        "logp": torch.stack(logp).numpy(),
        "logv": torch.stack(logv).numpy(),
        "biggest": torch.stack(big).numpy(),
        "regime": world.memes.regime[:, :N_COINS].cpu().numpy(),
        "target": target,
        "seat_wealth": torch.stack(seats).numpy(),  # [T, W] lamports, mean of the two attacker seats
    }


def same_meme(ours: dict, pump: dict, out: Path) -> dict:
    minutes = np.arange(ours["logp"].shape[0]) * BATCH_SECONDS / 60
    err_o = np.abs(ours["logp"] - ours["logv"]).mean(0)
    err_p = np.abs(pump["logp"] - pump["logv"]).mean(0)
    fig, axes = plt.subplots(2, 3, figsize=(13, 7), sharex=True)
    chosen = {}
    for ax, (i, name) in zip(axes.flat, enumerate(REGIMES)):
        mask = ours["regime"] == i
        if not mask.any():
            ax.set_visible(False)
            continue
        # The example is the meme with the median difference in its regime, not the best one.
        diff = (err_p - err_o)[mask]
        w, c = np.argwhere(mask)[np.argsort(diff)[len(diff) // 2]]
        chosen[name] = {"ours_error": float(err_o[w, c]), "pump_error": float(err_p[w, c]), "memes": int(mask.sum()),
                        "ours_better_share": float((diff > 0).mean())}  # fmt: skip
        ax.plot(minutes, np.exp(ours["logv"][:, w, c]), color=INK2, lw=1.4, ls=(0, (4, 3)), label="True value (hidden)")
        ax.plot(minutes, np.exp(pump["logp"][:, w, c]), color=PUMP, lw=2, label="pump.fun curve")
        ax.plot(minutes, np.exp(ours["logp"][:, w, c]), color=OURS, lw=2, label="Learned market")
        ax.set_yscale("log")
        ax.yaxis.set_major_locator(matplotlib.ticker.LogLocator(base=10, subs=(1, 2, 5), numticks=8))
        ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:g}x"))
        ax.yaxis.set_minor_locator(matplotlib.ticker.NullLocator())
        ax.set_title(REGIME_TITLES[name], pad=22)
        ax.text(0.0, 1.02, f"avg. distance from true value: pump {np.expm1(err_p[w, c]):.0%}, ours {np.expm1(err_o[w, c]):.0%}",
                transform=ax.transAxes, va="bottom", ha="left", fontsize=8.5, color=INK2)  # fmt: skip
    for ax in axes[1]:
        ax.set_xlabel("minutes since launch")
    for ax in axes[:, 0]:
        ax.set_ylabel("price, multiple of launch price")
    handles, labels = axes.flat[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper right", ncol=3, bbox_to_anchor=(0.99, 0.985))
    fig.suptitle("The same memes on two markets", x=0.02, ha="left", fontsize=15, fontweight="bold")
    fig.text(0.02, 0.925, "Simulated crowd; six seated coins per world. Each panel is the median meme of its kind, with the same hidden value path in both markets.",
             fontsize=9.5, color=INK2)  # fmt: skip
    fig.tight_layout(rect=(0, 0, 1, 0.9), h_pad=2.6)
    fig.savefig(out / "same_meme.png", dpi=180)
    plt.close(fig)
    return chosen


def hoarder(ours: dict, pump: dict, out: Path) -> dict:
    minutes = np.arange(ours["biggest"].shape[0]) * BATCH_SECONDS / 60
    fig, ax = plt.subplots(figsize=(8, 4.6))
    ends = {}
    for name, run, color in (("pump.fun curve", pump, PUMP), ("Learned market", ours, OURS)):
        top = run["biggest"].max(axis=2) * 100  # largest holder of any coin, per world
        mid, lo, hi = np.median(top, 1), np.quantile(top, 0.25, 1), np.quantile(top, 0.75, 1)
        ax.fill_between(minutes, lo, hi, color=color, alpha=0.10, lw=0)
        ax.plot(minutes, mid, color=color, lw=2, label=name)
        ax.scatter([minutes[-1]], [mid[-1]], s=64, color=color, edgecolor=SURFACE, linewidth=2, zorder=3)
        ax.annotate(f"{mid[-1]:.1f}%", (minutes[-1], mid[-1]), xytext=(8, 0), textcoords="offset points",
                    va="center", color=INK, fontsize=10)  # fmt: skip
        ends[name] = float(mid[-1])
    ax.set_xlim(0, minutes[-1] * 1.08)
    ax.set_ylim(0, None)
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:g}%"))
    ax.set_xlabel("minutes")
    ax.set_ylabel("share of a coin's supply held by its largest holder")
    ax.set_title("Two wallets try to buy everything", fontsize=13)
    ax.legend(loc="center right", bbox_to_anchor=(0.9, 0.5))
    fig.text(
        0.012, 0.012, "Simulated crowd. Line: median world. Band: middle half of worlds.", fontsize=8.5, color=INK2
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out / "hoarder.png", dpi=180)
    plt.close(fig)
    return ends


SCORECARD = (
    # key, title, unit formatter, higher_is_better
    ("1_top10_share", "Supply held by the top 10 holders", lambda v: f"{v:.0%}", False),
    ("pnl_sol_per_person/retail", "Average retail trader's profit", lambda v: f"{v:+.2f} SOL", True),
    ("trapped_at_death_sol_per_world", "Money lost in dead coins", lambda v: f"{v:.0f} SOL", False),
    ("tracking_error", "Typical distance of price from true value", lambda v: f"{np.expm1(v):.0%}", False),
    ("5_gap_p999", "Largest single-batch price jumps", lambda v: f"{np.expm1(v):.0%}", False),
    ("8_amihud_per_sol", "Price move per SOL traded", lambda v: f"{v:.0f}", False),
    ("2_traders_per_coin_batch", "People trading per coin per batch", lambda v: f"{v:.2f}", True),
    ("reward_per_batch", "Training reward (people x price accuracy)", lambda v: f"{v:.3f}", True),
)


def scorecard(ours_row: dict, pump_row: dict, out: Path) -> None:
    fig, axes = plt.subplots(2, 4, figsize=(14, 5.6))
    for ax, (key, title, fmt, higher) in zip(axes.flat, SCORECARD):
        vals = [pump_row[key], ours_row[key]]
        ax.barh([1, 0], vals, height=0.42, color=[PUMP, OURS])
        ax.axvline(0, color=GRID, lw=1)
        span = max(abs(v) for v in vals) or 1.0
        for y, v in zip((1, 0), vals):
            ax.annotate(fmt(v), (max(v, 0.0), y), xytext=(6, 0), textcoords="offset points",
                        va="center", ha="left", color=INK, fontsize=10)  # fmt: skip
        ax.set_xlim(min(0.0, min(vals)), max(0.0, max(vals)) + 0.55 * span)
        ax.set_ylim(-0.6, 1.6)
        ax.set_yticks([1, 0], ["pump.fun curve", "Learned market"])
        ax.set_xticks([])
        ax.grid(False)
        ax.spines["bottom"].set_visible(False)
        ours_wins = (vals[1] > vals[0]) == higher
        ax.set_title(textwrap.fill(title, 22), fontsize=10)
        note = ("ours is better" if ours_wins else "pump is better") + (
            "\nhigher is better" if higher else "\nlower is better"
        )
        ax.text(0.0, -0.06, note, transform=ax.transAxes, fontsize=8.5, color=INK2, va="top")
    fig.suptitle(
        "Scorecard: pump.fun's curve against the learned market", x=0.02, ha="left", fontsize=15, fontweight="bold"
    )
    fig.text(0.02, 0.915, "Simulated crowd, 64 worlds x 2,000 batches, same seed for both markets. Both wins and losses are shown.",
             fontsize=9.5, color=INK2)  # fmt: skip
    fig.tight_layout(rect=(0, 0, 0.97, 0.88), h_pad=3.5, w_pad=5.0)
    fig.savefig(out / "scorecard.png", dpi=180)
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quoter", required=True)
    ap.add_argument("--standard", required=True, help="standard.json holding the learned market's row")
    ap.add_argument("--pump-standard", required=True, help="standard.json holding the pump row")
    ap.add_argument("--out", default="docs/ai-gen/results/figures")
    ap.add_argument("--worlds", type=int, default=32)
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--seed", type=int, default=40_001)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    _style()
    act = policy_fn(PPO.load(args.quoter, device="cuda"))
    row = lambda path, market: next(r for r in json.loads(Path(path).read_text()) if r["market"] == market)
    scorecard(row(args.standard, "learned"), row(args.pump_standard, "pump"), out)

    clean = sim_config(attacker_rate=0.0)
    summary = {"same_meme": same_meme(
        paired_run("ours", act, args.seed, args.worlds, args.steps, clean),
        paired_run("pump", None, args.seed, args.worlds, args.steps, clean), out)}  # fmt: skip
    hoard = sim_config(attacker_rate=1.0, attacker_script=A_HOARDER, n_attacker_seats=2)
    summary["hoarder_final_share_pct"] = hoarder(
        paired_run("ours", act, args.seed, args.worlds, 600, hoard),
        paired_run("pump", None, args.seed, args.worlds, 600, hoard), out)  # fmt: skip
    (out / "figures.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
