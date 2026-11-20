"""The only functions that move cash or tokens, and the invariant checks.

Settlement rounds against the trader: buyers pay rounded up, sellers receive
rounded down. The quoter's cash is the sum of its counterparties' cash, so
cash is conserved exactly and rounding dust stays in the coin's safe bucket.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch

from .state import EMPTY, MarketConfig, MarketState
from .units import BPS, PPM, SUPPLY, notional_down, notional_up


@dataclass
class Settlement:
    cash_delta: torch.Tensor  # [N] lamports, negative for buyers
    fee: torch.Tensor  # [N] lamports of fee paid
    notional: torch.Tensor  # [N] lamports at the clearing price
    fee_rate: torch.Tensor  # [N] exit fee rate applied to sells (0 for buys)
    fees: torch.Tensor  # [G] total fees
    net_user_buy_cash: torch.Tensor  # [G] buyers' notional minus sellers' notional


def exit_fee_rate(
    state: MarketState,
    hp: torch.Tensor,
    group: torch.Tensor,
    sell_qty: torch.Tensor,
    slope: torch.Tensor,
    danger: torch.Tensor,
    cfg: MarketConfig,
) -> torch.Tensor:
    """Exit fee rate for selling `sell_qty` from position `hp` this batch.

    base + locked early-exit fee decayed since the volume-weighted buy time
    + slope per 1% of supply sold, capped at the fee ceiling. The early-exit
    part was fixed when the position was bought; it is waived in the danger zone.
    """
    age = (state.t - state.buy_time.reshape(-1)[hp]).clamp(min=0)
    hold_term = state.lock_fee.reshape(-1)[hp] * torch.pow(2.0, -age / state.lock_half.reshape(-1)[hp])
    hold_term = torch.where(danger[group], torch.zeros_like(hold_term), hold_term)
    size_term = slope[group] * (sell_qty.float() / SUPPLY) * 100.0
    rate = cfg.base_fee_bps / BPS + hold_term + size_term
    return rate.clamp(0.0, cfg.fee_ceiling)



def fee_rate_ppm(rate: torch.Tensor, cfg: MarketConfig) -> torch.Tensor:
    """Floor learned rates to ppm, preserving the exact configured base fee.

    A float32 0.01 is slightly below 1%, so conversion alone yields 9,999 ppm.
    The base fee is an integer lower bound in both the core and the program.
    """
    return (rate.double() * PPM).long().clamp(
        min=cfg.base_fee_bps * (PPM // BPS), max=int(cfg.fee_ceiling * PPM)
    )


def settle(
    state: MarketState,
    cfg: MarketConfig,
    group: torch.Tensor,
    pw: torch.Tensor,
    hp: torch.Tensor,
    is_buy: torch.Tensor,
    fill: torch.Tensor,
    price: torch.Tensor,
    q_buy: torch.Tensor,
    q_sell: torch.Tensor,
    fee0: torch.Tensor,
    half_life: torch.Tensor,
    slope: torch.Tensor,
    danger: torch.Tensor,
) -> Settlement:
    """Apply one batch's fills. Indices: group [N], pw = world*P + person, hp = group*P + person.

    price [G] is the clearing price; fee0 / half_life / slope / danger are [G].
    """
    G = cfg.n_groups
    dev = fill.device
    p = price[group]
    pay = notional_up(fill, p)
    recv = notional_down(fill, p)
    fee_buy = (pay * cfg.base_fee_bps + (BPS - 1)) // BPS
    rate = exit_fee_rate(state, hp, group, fill, slope, danger, cfg)
    rate_ppm = fee_rate_ppm(rate, cfg)
    fee_sell = torch.minimum((recv * rate_ppm + (PPM - 1)) // PPM, recv)
    fee = torch.where(is_buy, fee_buy, fee_sell)
    fee = torch.where(fill > 0, fee, 0)
    cash_delta = torch.where(is_buy, -(pay + fee), recv - fee)
    cash_delta = torch.where(fill > 0, cash_delta, 0)

    # Lock the exit schedule for buys, volume-weighted with the existing position.
    held = state.hold.reshape(-1)[hp].float()
    got = torch.where(is_buy, fill, 0).float()
    tot = (held + got).clamp(min=1.0)
    bought = got > 0
    idx = hp[bought]
    w_old, w_new = (held / tot)[bought], (got / tot)[bought]
    g_b = group[bought]
    state.buy_time.reshape(-1)[idx] = w_old * state.buy_time.reshape(-1)[idx] + w_new * float(state.t)
    state.lock_fee.reshape(-1)[idx] = w_old * state.lock_fee.reshape(-1)[idx] + w_new * fee0[g_b]
    state.lock_half.reshape(-1)[idx] = w_old * state.lock_half.reshape(-1)[idx] + w_new * half_life[g_b]

    state.cash.reshape(-1).index_add_(0, pw, cash_delta)
    state.hold.reshape(-1).index_add_(0, hp, torch.where(is_buy, fill, -fill))

    zeros = torch.zeros(G, dtype=torch.int64, device=dev)
    paid = zeros.index_add(0, group, torch.where(is_buy & (fill > 0), pay, 0))
    received = zeros.index_add(0, group, torch.where(~is_buy & (fill > 0), recv, 0))
    fees = zeros.index_add(0, group, fee)
    to_bucket = fees * cfg.fee_to_bucket_ppm // PPM
    net = paid - received
    W, C = cfg.n_worlds, cfg.n_slots
    state.q_cash += (net + to_bucket).reshape(W, C)
    state.platform_cash += (fees - to_bucket).reshape(W, C).sum(1)
    state.q_tokens += (q_buy - q_sell).reshape(W, C)

    return Settlement(
        cash_delta=cash_delta,
        fee=fee,
        notional=torch.where(is_buy, pay, recv) * (fill > 0),
        fee_rate=torch.where(is_buy, torch.zeros_like(rate), rate),
        fees=fees,
        net_user_buy_cash=net,
    )


def open_coin(
    state: MarketState,
    cfg: MarketConfig,
    do: torch.Tensor,
    slot: torch.Tensor,
    deployer: torch.Tensor,
    fee: torch.Tensor,
    stage: int,
) -> None:
    """Launch a coin in `slot` for worlds where `do` is set; the deployer pays `fee`.

    The quoter starts with the whole supply. A share of the launch fee seeds
    the coin's safe bucket and the rest goes to the platform.
    """
    w = torch.nonzero(do).squeeze(1)
    if w.numel() == 0:
        return
    s, d, f = slot[w], deployer[w], fee[w]
    to_bucket = f * cfg.launch_fee_to_bucket_ppm // PPM
    state.cash[w, d] -= f
    state.q_cash[w, s] = to_bucket
    state.platform_cash[w] += f - to_bucket
    state.q_tokens[w, s] = SUPPLY
    state.hold[w, s] = 0
    state.tick[w, s] = cfg.launch_tick
    state.stage[w, s] = stage
    state.birth[w, s] = state.t + 1
    state.heat[w, s] = 0.0
    state.timer[w, s] = cfg.timer_init
    state.activity[w, s] = 0.0
    state.coin_id[w, s] = state.next_coin_id[w]
    state.next_coin_id[w] += 1


def void_coin(state: MarketState, ended: torch.Tensor) -> None:
    """Delist coins where `ended` [W, C] is set.

    Holders' tokens are voided and the reserve is recorded as dead money; its
    destination is undecided (docs/ai-gen/decisions.md).
    """
    if not bool(ended.any()):
        return
    state.dead_cash += torch.where(ended, state.q_cash, 0).sum(1)
    state.q_cash.masked_fill_(ended, 0)
    state.q_tokens.masked_fill_(ended, 0)
    state.hold.masked_fill_(ended.unsqueeze(2), 0)
    state.stage.masked_fill_(ended, EMPTY)
    state.heat.masked_fill_(ended, 0.0)
    state.timer.masked_fill_(ended, 0.0)
    state.activity.masked_fill_(ended, 0.0)


def check_invariants(state: MarketState, cfg: MarketConfig, total_cash: torch.Tensor) -> None:
    """Raise AssertionError if the ledger is inconsistent."""
    assert bool((state.cash >= 0).all()), f"negative cash: {int(state.cash.min())}"
    assert bool((state.hold >= 0).all()), f"negative holding: {int(state.hold.min())}"
    assert bool((state.q_cash >= 0).all()), f"negative safe bucket: {int(state.q_cash.min())}"
    assert bool((state.q_tokens >= 0).all()), f"negative quoter tokens: {int(state.q_tokens.min())}"
    assert bool((state.platform_cash >= 0).all()), "negative platform cash"
    drift = state.total_cash() - total_cash
    assert bool((drift == 0).all()), f"cash not conserved: drift {drift.tolist()[:4]}"
    live = state.stage > 0
    issued = state.hold.sum(2) + state.q_tokens
    assert bool((issued[live] == SUPPLY).all()), "tokens not conserved on a live coin"
    assert bool((issued[~live] == 0).all()), "tokens left on an empty slot"
    ceiling = int(cfg.hard_cap_share * SUPPLY)
    assert bool((state.hold <= ceiling).all()), f"holding above the hard ceiling: {int(state.hold.max())}"
