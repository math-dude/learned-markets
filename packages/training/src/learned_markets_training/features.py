"""Observations for the two networks.

Features are scaled by construction (logs, shares, clipped ratios) so no
running normalization is needed and the exported policy is self-contained.
Neither network ever sees a meme's true value, its regime, the current
batch's orders, or anything about an individual person.
"""

from __future__ import annotations

import torch
from learned_markets_core import LINE, REGULAR, ROOKIE
from learned_markets_core.lifecycle import LEVER_HI, LEVER_LO
from learned_markets_core.tape import N_QUOTER_FEATURES, QUOTER_FEATURES  # noqa: F401
from learned_markets_simulation.world import World

AUCTION_FEATURES = (
    "line_fullness", "seat_fullness", "rookie_fullness", "regular_fullness", "live_coins",
    "traders", "reward", "launches", "refused", "cuts", "deaths", "seatings", "graduations",
    "heat_mean", "heat_max", "heat_line_min", "timer_mean", "timer_min",
    "fee", "line_cap", "seats", "rookie_seats", "drain", "timer_cap",
)  # fmt: skip
N_AUCTION_FEATURES = len(AUCTION_FEATURES)


def quoter_features(world: World) -> torch.Tensor:
    """[W, C, F] float32. The observation itself lives in the market core (`Tape.observation`)."""
    return world.tape.observation(world.state, world.lever_values)


class AuctionStats:
    """Accumulates one epoch of platform activity for the auction network's observation."""

    def __init__(self, world: World):
        self.world = world
        self.reset()

    def reset(self) -> None:
        W, dev = self.world.cfg.n_worlds, self.world.dev
        z = lambda: torch.zeros(W, device=dev)
        self.traders, self.reward, self.launches, self.refused = z(), z(), z(), z()
        self.cuts, self.deaths, self.seatings, self.graduations = z(), z(), z(), z()
        self.n = 0

    def add(self, out) -> None:
        ev = out.events
        self.traders += out.result.traders.sum(1).float()
        self.reward += out.reward.sum(1)
        self.launches += ev.launched.sum(1).float()
        self.refused += ev.launch_refused.float()
        self.cuts += (ev.reason == 1).sum(1).float()
        self.deaths += (ev.reason >= 2).sum(1).float()
        self.seatings += ev.seated.sum(1).float()
        self.graduations += ev.graduated.sum(1).float()
        self.n += 1


def auction_features(world: World, stats: AuctionStats) -> torch.Tensor:
    """[W, F] float32: platform aggregates over the last epoch and the current lever settings."""
    s, cfg = world.state, world.cfg
    lv = world.lever_values
    n = max(stats.n, 1)
    line, rook, reg = (s.stage == LINE), (s.stage == ROOKIE), (s.stage == REGULAR)
    seated = rook | reg
    cnt = lambda m: m.sum(1).float()
    live = s.stage > 0
    inf = float("inf")
    heat_live = torch.where(live, s.heat, torch.zeros_like(s.heat))
    lo = torch.tensor(LEVER_LO, device=world.dev)
    hi = torch.tensor(LEVER_HI, device=world.dev)
    log_levers = torch.tensor([True, False, False, False, False, True], device=world.dev)
    lin = (lv - lo) / (hi - lo)
    geo = (torch.log(lv) - torch.log(lo)) / (torch.log(hi) - torch.log(lo))
    lever_obs = torch.where(log_levers, geo, lin)
    timer_seated = torch.where(seated, s.timer, torch.full_like(s.timer, inf))
    cols = [
        cnt(line) / lv[:, 1],
        cnt(seated) / lv[:, 2],
        cnt(rook) / lv[:, 3].clamp(min=1),
        cnt(reg) / (lv[:, 2] - lv[:, 3]).clamp(min=1),
        cnt(live) / cfg.n_slots,
        stats.traders / n / (cfg.n_people * 0.05),
        stats.reward / n,
        stats.launches / n * 20,
        stats.refused / n * 20,
        stats.cuts / n * 20,
        stats.deaths / n * 20,
        stats.seatings / n * 20,
        stats.graduations / n * 20,
        torch.log1p(heat_live.sum(1) / cnt(live).clamp(min=1)) / 6,
        torch.log1p(heat_live.max(1).values) / 6,
        torch.log1p(torch.where(line, s.heat, torch.full_like(s.heat, inf)).min(1).values.nan_to_num(posinf=0.0)) / 6,
        (torch.where(seated, s.timer, torch.zeros_like(s.timer)).sum(1) / cnt(seated).clamp(min=1) / lv[:, 5]).clamp(-1, 1),
        (timer_seated.min(1).values.nan_to_num(posinf=0.0) / lv[:, 5]).clamp(-1, 1),
    ]  # fmt: skip
    return torch.cat([torch.stack(cols, dim=1), lever_obs], dim=1).clamp(-5, 5)
