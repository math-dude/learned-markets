"""The quoter interface: ten numbers per coin per batch, and the fixed stand-ins.

A `Quote` is what the market consumes: the quoter's bid and ask curves on the
tick window plus the trading terms it publishes for the batch. A learned
policy, the rule-based stand-in and the pump bonding-curve baseline all
produce a `Quote`, so they run through the same market code.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch

from .state import MarketConfig, MarketState
from .units import N_TICKS, PRICE_SCALE, SUPPLY, prices

PARAM_NAMES = (
    "bid_off",  # ticks between the top of the bid and the bottom of the ask (>= 1)
    "bid_depth",  # share of the safe bucket offered this batch
    "bid_width",  # ticks the bid is spread over
    "ask_off",  # ticks from the last price to the bottom of the ask; negative walks the price down
    "ask_depth",  # share of the quoter's tokens offered this batch (supply release)
    "ask_width",
    "cap",  # largest position per person, share of supply
    "fee0",  # early-exit fee rate right after buying
    "half_life",  # batches for the early-exit fee to halve
    "slope",  # extra exit fee rate per 1% of supply sold in one batch
)
N_PARAMS = len(PARAM_NAMES)
#            bid_off depth  width ask_off depth  width cap    fee0 half   slope
_LO = (1.0, 0.005, 1.0, -16.0, 1e-4, 1.0, 0.001, 0.0, 2.0, 0.0)
_HI = (16.0, 0.5, 32.0, 16.0, 5e-2, 32.0, 0.02, 0.2, 720.0, 0.3)
_LOG = (False, True, False, False, True, False, True, False, True, False)


def _bounds(device) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    lo = torch.tensor(_LO, dtype=torch.float32, device=device)
    hi = torch.tensor(_HI, dtype=torch.float32, device=device)
    log = torch.tensor(_LOG, device=device)
    return lo, hi, log


def params_from_action(action: torch.Tensor) -> torch.Tensor:
    """Map an action in [-1, 1]^10 onto the public bounds (log scale where flagged)."""
    lo, hi, log = _bounds(action.device)
    u = (action.clamp(-1, 1) + 1) / 2
    lin = lo + u * (hi - lo)
    geo = torch.exp(torch.log(lo.clamp(min=1e-12)) + u * (torch.log(hi) - torch.log(lo.clamp(min=1e-12))))
    return torch.where(log, geo, lin)


def action_from_params(params: torch.Tensor) -> torch.Tensor:
    lo, hi, log = _bounds(params.device)
    p = torch.maximum(torch.minimum(params, hi), lo)
    lin = (p - lo) / (hi - lo)
    geo = (torch.log(p.clamp(min=1e-12)) - torch.log(lo.clamp(min=1e-12))) / (
        torch.log(hi) - torch.log(lo.clamp(min=1e-12))
    )
    return torch.where(log, geo, lin) * 2 - 1


@dataclass
class Quote:
    bid: torch.Tensor  # [G, K] cumulative tokens the quoter buys at each tick
    ask: torch.Tensor  # [G, K] cumulative tokens the quoter sells at each tick
    cap_share: torch.Tensor  # [W, C]
    fee0: torch.Tensor  # [W, C]
    half_life: torch.Tensor  # [W, C]
    slope: torch.Tensor  # [W, C]


def window_prices(tick: torch.Tensor, cfg: MarketConfig) -> tuple[torch.Tensor, torch.Tensor]:
    """Prices [G, K] of each group's window and a mask of ticks that exist."""
    K = cfg.window
    gt = tick.reshape(-1, 1) - K // 2 + torch.arange(K, device=tick.device)
    valid = (gt >= 0) & (gt < N_TICKS)
    return prices(tick.device)[gt.clamp(0, N_TICKS - 1)], valid


def build_quote(state: MarketState, params: torch.Tensor, cfg: MarketConfig) -> Quote:
    """Turn parameters [W, C, 10] (real units) into curves and terms.

    The ask starts `ask_off` ticks from the last price, above or below it, and
    the bid tops out `bid_off` ticks under the ask, so the quoter cannot trade
    with itself. An ask below the last price is how an unsold launch finds its
    price. The bid is funded by construction: each tick's slice spends an equal
    share of the offered cash.
    """
    W, C, K = cfg.n_worlds, cfg.n_slots, cfg.window
    G, c0 = W * C, cfg.window // 2
    p = params.reshape(G, N_PARAMS)
    price, valid = window_prices(state.tick, cfg)
    k = torch.arange(K, device=p.device).expand(G, K)

    b_off = p[:, 0].round().long().clamp(1, 16).unsqueeze(1)
    b_w = p[:, 2].round().long().clamp(1, 32).unsqueeze(1)
    a_off = p[:, 3].round().long().clamp(-16, 16).unsqueeze(1)
    a_w = p[:, 5].round().long().clamp(1, 32).unsqueeze(1)

    q_cash = state.q_cash.reshape(G)
    q_tok = state.q_tokens.reshape(G)
    budget = (p[:, 1].double().clamp(0, 1) * q_cash.double()).long().clamp(min=0)
    budget = torch.minimum(budget, q_cash).clamp(max=9_000_000_000_000)
    per_tick = (budget // b_w.squeeze(1)).unsqueeze(1)
    lo_a = c0 + a_off
    hi_b = lo_a - b_off
    mask_b = (k >= hi_b - b_w + 1) & (k <= hi_b) & valid
    slices = torch.where(mask_b, per_tick * PRICE_SCALE // price, 0)
    bid = slices.flip(1).cumsum(1).flip(1)

    offer = (p[:, 4].double().clamp(0, 1) * q_tok.double()).long().clamp(min=0)
    offer = torch.minimum(offer, q_tok)
    per_ask = (offer // a_w.squeeze(1)).unsqueeze(1)
    mask_a = (k >= lo_a) & (k <= lo_a + a_w - 1) & valid
    ask = torch.where(mask_a, per_ask, 0).cumsum(1)

    return Quote(
        bid=bid,
        ask=ask,
        cap_share=p[:, 6].reshape(W, C),
        fee0=p[:, 7].reshape(W, C),
        half_life=p[:, 8].reshape(W, C).clamp(min=1.0),
        slope=p[:, 9].reshape(W, C),
    )


# Fixed stand-ins -----------------------------------------------------------

RULE_BASED = (2.0, 0.05, 8.0, 0.0, 0.01, 4.0, 0.02, 0.05, 60.0, 0.05)


def rule_based_params(
    state: MarketState, pressure: torch.Tensor, cfg: MarketConfig, idle: torch.Tensor | None = None
) -> torch.Tensor:
    """Fixed rule: release a set share of supply each batch and follow the unfilled side.

    `pressure` [W, C] in [-1, 1] is last batch's unfilled demand minus unfilled
    supply, as a share of what was offered. Rationed demand lifts the ask by up
    to three ticks; unsold supply lowers it. `idle` [W, C] counts batches in a
    row with nothing traded: the last price is then stale, so the ask steps one
    tick lower for every five idle batches, up to eight ticks. Terms are a constant schedule.
    """
    base = torch.tensor(RULE_BASED, dtype=torch.float32, device=pressure.device)
    p = base.expand(cfg.n_worlds, cfg.n_slots, N_PARAMS).clone()
    step_down = torch.floor(idle / 5).clamp(max=8) if idle is not None else 0.0
    p[..., 3] = (torch.round(3.0 * pressure.clamp(-1, 1)) - step_down).clamp(-16, 16)
    return p


def residual_params(
    state: MarketState,
    pressure: torch.Tensor,
    idle: torch.Tensor,
    action: torch.Tensor,
    cfg: MarketConfig,
    frozen: tuple[int, ...] | list[int] = (),
) -> torch.Tensor:
    """Parameters from a learned action expressed as a correction to the fixed rule.

    The policy's output in [-1, 1]^10 is added to the rule-based stand-in's
    action and clamped, so a zero output reproduces the stand-in exactly and
    learning starts from it. Indices in `frozen` stay on the stand-in.
    """
    standin = action_from_params(rule_based_params(state, pressure, cfg, idle))
    delta = action.reshape(standin.shape).float()
    if len(frozen):
        delta = delta.clone()
        delta[..., list(frozen)] = 0.0
    return params_from_action((standin + delta).clamp(-1, 1))


# pump.fun's opening virtual reserves: 30 SOL against 1.073 billion tokens.
PUMP_VIRTUAL_LAMPORTS = 30_000_000_000
PUMP_VIRTUAL_TOKENS = 1_073_000_000


def bonding_curve_quote(state: MarketState, cfg: MarketConfig) -> Quote:
    """The plain baseline: a constant-product bonding curve as the quoter.

    Sells along x*y=k as price rises and buys back along it as price falls. No
    early-exit fee and no learned cap; pair it with a config whose cap shares
    are 1.0 to reproduce pump's uncapped market.
    """
    W, C = cfg.n_worlds, cfg.n_slots
    G = W * C
    price, valid = window_prices(state.tick, cfg)
    kc = float(PUMP_VIRTUAL_LAMPORTS) * float(PUMP_VIRTUAL_TOKENS)
    q_tok = state.q_tokens.reshape(G)
    q_cash = state.q_cash.reshape(G)
    y_now = (PUMP_VIRTUAL_TOKENS - (SUPPLY - q_tok)).double().clamp(min=1.0).unsqueeze(1)
    y_at = torch.sqrt(kc * PRICE_SCALE / price.double())
    live = (state.stage.reshape(G) > 0).unsqueeze(1)
    ask = torch.where(valid & live, (y_now - y_at).clamp(min=0).floor().long(), 0)
    ask = torch.minimum(ask, q_tok.unsqueeze(1))
    bid = torch.where(valid & live, (y_at - y_now).clamp(min=0).floor().long(), 0)
    bid = torch.minimum(bid, q_cash.clamp(max=9_000_000_000_000).unsqueeze(1) * PRICE_SCALE // price)
    zero = torch.zeros(W, C, dtype=torch.float32, device=price.device)
    return Quote(bid=bid, ask=ask, cap_share=zero + 1.0, fee0=zero, half_life=zero + 1.0, slope=zero)


def pump_launch_tick() -> int:
    p0 = PUMP_VIRTUAL_LAMPORTS * PRICE_SCALE / PUMP_VIRTUAL_TOKENS
    return int(math.log(p0 / 1000) / math.log(1.01))
