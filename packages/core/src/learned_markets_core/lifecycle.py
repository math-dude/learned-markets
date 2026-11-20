"""A coin's life: launch into the line, cuts, seating, graduation, timers, death.

Runs after settlement, never between intake and clearing. The auction network
owns the levers; `standin_levers` is the fixed rule behind the same interface.
It never picks or kills a coin: public rules do.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch

from .ledger import open_coin, void_coin
from .market import BatchResult
from .state import LINE, REGULAR, ROOKIE, Levers, MarketConfig, MarketState
from .units import PRICE_SCALE, prices

LEVER_NAMES = ("launch_fee", "line_cap", "seats", "rookie_seats", "drain_mult", "timer_cap")
#                launch_fee (lamports)  line  seats rookie drain timer_cap
LEVER_LO = (10_000_000.0, 4.0, 2.0, 1.0, 0.8, 300.0)
LEVER_HI = (2_000_000_000.0, 20.0, 12.0, 8.0, 1.2, 3600.0)
LEVER_DEFAULT = (100_000_000.0, 12.0, 8.0, 4.0, 1.0, 1800.0)
# One step per epoch: multiplicative for the fee and timer cap, additive otherwise.
LEVER_STEP = (1.25, 1.0, 1.0, 1.0, 0.05, 1.25)
LEVER_MULT = (True, False, False, False, False, True)

END_NONE, END_CUT, END_DEATH, END_BUMPED = 0, 1, 2, 3


def levers_from_values(values: torch.Tensor, clamp: bool = True) -> Levers:
    """Build levers from a float tensor [W, 6] in real units, clamped to the public bounds.

    `clamp=False` is for baselines outside what the auction network may choose,
    such as an open door with no launch fee and no line cap.
    """
    lo = torch.tensor(LEVER_LO, device=values.device)
    hi = torch.tensor(LEVER_HI, device=values.device)
    v = torch.maximum(torch.minimum(values, hi), lo) if clamp else values
    seats = v[:, 2].round().long()
    return Levers(
        launch_fee=v[:, 0].long(),
        line_cap=v[:, 1].round().long(),
        seats=seats,
        rookie_seats=torch.minimum(v[:, 3].round().long(), seats),
        drain_mult=v[:, 4].float(),
        timer_cap=v[:, 5].float(),
    )


def default_lever_values(cfg: MarketConfig) -> torch.Tensor:
    return torch.tensor(LEVER_DEFAULT, device=cfg.device).expand(cfg.n_worlds, 6).clone()


def step_lever_values(values: torch.Tensor, move: torch.Tensor) -> torch.Tensor:
    """Apply one bounded step per lever. `move` [W, 6] is -1, 0 or +1."""
    step = torch.tensor(LEVER_STEP, device=values.device)
    mult = torch.tensor(LEVER_MULT, device=values.device)
    m = move.to(values.dtype)
    out = torch.where(mult, values * step**m, values + step * m)
    lo = torch.tensor(LEVER_LO, device=values.device)
    hi = torch.tensor(LEVER_HI, device=values.device)
    return torch.maximum(torch.minimum(out, hi), lo)


def standin_lever_values(state: MarketState, cfg: MarketConfig) -> torch.Tensor:
    """Fixed rule: constant levers, with the launch fee following how full the line is."""
    v = default_lever_values(cfg)
    fullness = (state.stage == LINE).sum(1).float() / v[:, 1]
    v[:, 0] = v[:, 0] * (0.5 + 1.5 * fullness.clamp(0, 1))
    return v


@dataclass
class LifecycleEvents:
    ended: torch.Tensor  # [W, C] bool: the coin in this slot ended this batch
    reason: torch.Tensor  # [W, C] END_*
    launched: torch.Tensor  # [W, C] bool: a new coin opened in this slot
    seated: torch.Tensor  # [W, C] bool: moved from the line to a rookie seat
    graduated: torch.Tensor  # [W, C] bool
    trapped: torch.Tensor  # [W] lamports of holder value voided this batch
    launch_refused: torch.Tensor  # [W] bool: a launch was requested and not opened


def _rank(key: torch.Tensor) -> torch.Tensor:
    """Rank along dim 1, 0 = smallest."""
    return key.argsort(1).argsort(1)


def lifecycle_step(
    state: MarketState,
    result: BatchResult,
    levers: Levers,
    launch_req: torch.Tensor,
    deployer: torch.Tensor,
    cfg: MarketConfig,
) -> LifecycleEvents:
    """Advance heat, timers and stages, end coins, open launches, then tick the clock.

    launch_req [W] bool and deployer [W] person index: at most one launch per
    world per batch. A launch needs room in the line, a free slot and a
    deployer who can pay the fee.
    """
    W, C = cfg.n_worlds, cfg.n_slots
    dev = state.stage.device
    stage = state.stage
    n = result.traders.float()
    state.heat = state.heat * cfg.heat_decay + n
    seated = stage >= ROOKIE
    state.activity = state.activity + torch.where(seated, n, torch.zeros_like(n))
    board_avg = (n * seated).sum(1) / seated.sum(1).clamp(min=1)
    drift = cfg.timer_k * (n - (board_avg * levers.drain_mult).unsqueeze(1))
    timer = torch.minimum(state.timer + drift, levers.timer_cap.unsqueeze(1))
    state.timer = torch.where(seated, timer, state.timer)

    ended = torch.zeros(W, C, dtype=torch.bool, device=dev)
    reason = torch.zeros(W, C, dtype=torch.int64, device=dev)
    seated_now = torch.zeros_like(ended)
    graduated = torch.zeros_like(ended)
    t1 = state.t + 1
    inf = float("inf")

    if t1 % cfg.cut_round == 0:
        eligible = (stage == LINE) & ((state.t - state.birth) >= cfg.grace)
        cold = _rank(torch.where(eligible, state.heat, torch.full_like(state.heat, inf)))
        cut = eligible & (cold < cfg.cut_n)
        ended |= cut
        reason = torch.where(cut, END_CUT, reason)

    if t1 % cfg.epoch == 0:
        dead = seated & (state.timer <= 0)
        ended |= dead
        reason = torch.where(dead, END_DEATH, reason)

        # Graduation is earned by activity; a full regular section bumps its lowest timers.
        grad = (stage == ROOKIE) & (state.activity >= cfg.graduation_activity) & ~ended
        regular = (stage == REGULAR) & ~ended
        reg_cap = (levers.seats - levers.rookie_seats).clamp(min=0)
        overflow = (regular.sum(1) + grad.sum(1) - reg_cap).clamp(min=0)
        low = _rank(torch.where(regular, state.timer, torch.full_like(state.timer, inf)))
        bumped = regular & (low < overflow.unsqueeze(1))
        ended |= bumped
        reason = torch.where(bumped, END_BUMPED, reason)
        graduated = grad
        state.stage = torch.where(grad, REGULAR, state.stage)

        # The hottest line coins take open rookie seats.
        rookies = ((state.stage == ROOKIE) & ~ended).sum(1)
        occupied = ((state.stage >= ROOKIE) & ~ended).sum(1)
        open_seats = torch.minimum(levers.rookie_seats - rookies, levers.seats - occupied).clamp(min=0)
        cand = (state.stage == LINE) & ~ended & (state.heat >= cfg.seat_min_heat)
        hot = _rank(torch.where(cand, -state.heat, torch.full_like(state.heat, inf)))
        seated_now = cand & (hot < open_seats.unsqueeze(1))
        state.stage = torch.where(seated_now, ROOKIE, state.stage)
        state.timer = torch.where(seated_now, cfg.timer_init, state.timer)
        state.activity = torch.where(seated_now, 0.0, state.activity)

    # Value voided with ended coins, at the last clearing price.
    px = prices(dev)[state.tick].double() / PRICE_SCALE
    held = state.hold.sum(2).double() * px
    trapped = torch.where(ended, held, torch.zeros_like(held)).sum(1).long()
    void_coin(state, ended)

    line_n = (state.stage == LINE).sum(1)
    empty = state.stage == 0
    slot = empty.float().argmax(1)
    wi = torch.arange(W, device=dev)
    can_pay = state.cash[wi, deployer] >= levers.launch_fee
    do = launch_req & (line_n < levers.line_cap) & empty.any(1) & can_pay
    open_coin(state, cfg, do, slot, deployer, levers.launch_fee, LINE)
    launched = torch.zeros_like(ended)
    launched[wi[do], slot[do]] = True

    state.t = t1
    return LifecycleEvents(
        ended=ended,
        reason=reason,
        launched=launched,
        seated=seated_now,
        graduated=graduated,
        trapped=trapped,
        launch_refused=launch_req & ~do,
    )
