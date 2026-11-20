"""Market state, levers and configuration.

Every tensor is batch-first: W worlds, C coin slots, P people. The backend uses
W=1; training uses many worlds on a GPU. All numbers in `MarketConfig` are
simulation placeholders (see "Open" in docs/ai-gen/decisions.md).
"""

from __future__ import annotations

from dataclasses import dataclass, fields

import torch

from .units import SUPPLY

# Coin stages.
EMPTY, LINE, ROOKIE, REGULAR = 0, 1, 2, 3


@dataclass(frozen=True)
class MarketConfig:
    n_worlds: int = 1
    n_slots: int = 32
    n_people: int = 512
    window: int = 128  # ticks in the clearing window, centred on the last clearing tick
    device: str = "cpu"

    launch_tick: int = 1029  # about 28 lamports per token, pump's opening price
    base_fee_bps: int = 100  # fixed fee on every executed trade, each side
    fee_ceiling: float = 0.25  # hard maximum total exit fee rate
    hard_cap_share: float = 0.02  # no one may hold more of a coin than this
    line_cap_share: float = 0.005  # per-person cap while a coin is in the line
    fee_to_bucket_ppm: int = 500_000  # share of trading fees to the coin's safe bucket
    launch_fee_to_bucket_ppm: int = 500_000
    dust_lamports: int = 5_000_000  # a fill below this does not count a person as trading

    # Lifecycle.
    cut_round: int = 60  # batches between cuts of the coldest line coin
    cut_n: int = 1
    grace: int = 120  # batches before a line coin can be cut
    epoch: int = 180  # batches between seating, graduation and death checks
    heat_decay: float = 0.98
    seat_min_heat: float = 20.0
    graduation_activity: float = 600.0  # cumulative distinct-person trades as a rookie
    timer_init: float = 600.0
    timer_k: float = 1.0
    danger_timer: float = 120.0  # early-exit fees drop to zero below this

    @property
    def n_groups(self) -> int:
        return self.n_worlds * self.n_slots


@dataclass
class Levers:
    """Room-level settings owned by the auction network. Each is shaped [W]."""

    launch_fee: torch.Tensor  # lamports, int64
    line_cap: torch.Tensor  # coins allowed in the line, int64
    seats: torch.Tensor  # total seats, int64
    rookie_seats: torch.Tensor  # seats reserved for rookies, int64
    drain_mult: torch.Tensor  # float32
    timer_cap: torch.Tensor  # float32


@dataclass
class MarketState:
    cash: torch.Tensor  # [W, P] lamports
    hold: torch.Tensor  # [W, C, P] tokens
    buy_time: torch.Tensor  # [W, C, P] volume-weighted batch index of buys
    lock_fee: torch.Tensor  # [W, C, P] early-exit fee rate locked at buy
    lock_half: torch.Tensor  # [W, C, P] hold half-life in batches locked at buy
    q_tokens: torch.Tensor  # [W, C] quoter's tokens: unissued plus bought back
    q_cash: torch.Tensor  # [W, C] the coin's safe bucket
    tick: torch.Tensor  # [W, C] last clearing tick
    stage: torch.Tensor  # [W, C]
    birth: torch.Tensor  # [W, C] batch index at launch
    coin_id: torch.Tensor  # [W, C] unique per world
    heat: torch.Tensor  # [W, C]
    timer: torch.Tensor  # [W, C]
    activity: torch.Tensor  # [W, C] cumulative distinct-person trades since seating
    platform_cash: torch.Tensor  # [W]
    dead_cash: torch.Tensor  # [W] reserves of cut or dead coins, recorded only
    next_coin_id: torch.Tensor  # [W]
    t: int = 0

    @classmethod
    def empty(cls, cfg: MarketConfig) -> MarketState:
        W, C, P, d = cfg.n_worlds, cfg.n_slots, cfg.n_people, cfg.device
        zi = lambda *s: torch.zeros(*s, dtype=torch.int64, device=d)
        zf = lambda *s: torch.zeros(*s, dtype=torch.float32, device=d)
        return cls(
            cash=zi(W, P),
            hold=zi(W, C, P),
            buy_time=zf(W, C, P),
            lock_fee=zf(W, C, P),
            lock_half=torch.ones(W, C, P, dtype=torch.float32, device=d),
            q_tokens=zi(W, C),
            q_cash=zi(W, C),
            tick=torch.full((W, C), cfg.launch_tick, dtype=torch.int64, device=d),
            stage=zi(W, C),
            birth=zi(W, C),
            coin_id=zi(W, C),
            heat=zf(W, C),
            timer=zf(W, C),
            activity=zf(W, C),
            platform_cash=zi(W),
            dead_cash=zi(W),
            next_coin_id=torch.ones(W, dtype=torch.int64, device=d),
        )

    def clone(self) -> MarketState:
        kw = {}
        for f in fields(self):
            v = getattr(self, f.name)
            kw[f.name] = v.clone() if isinstance(v, torch.Tensor) else v
        return MarketState(**kw)

    def total_cash(self) -> torch.Tensor:
        """Lamports in existence per world. Constant unless cash is injected."""
        return self.cash.sum(1) + self.q_cash.sum(1) + self.platform_cash + self.dead_cash

    def cap_tokens(self, cap_share: torch.Tensor, cfg: MarketConfig) -> torch.Tensor:
        """Largest position per person, [W, C] tokens, given the quoter's cap share."""
        share = cap_share.clamp(max=cfg.hard_cap_share)
        share = torch.where(self.stage == LINE, share.clamp(max=cfg.line_cap_share), share)
        return (share.double() * SUPPLY).long()
