"""One batch of the market: intake, clearing, settlement.

`step_batch` is the function the simulator, the trainer and the backend all
call. The quote passed in must have been computed before this batch's orders
existed; nothing inside the step feeds back into it.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch

from .clearing import Clearing, clear
from .ledger import Settlement, settle
from .quoter import Quote, window_prices
from .state import ROOKIE, MarketConfig, MarketState
from .units import BPS, PRICE_SCALE

BUY, SELL = 0, 1


@dataclass
class Orders:
    """Curve orders for one batch.

    One order per person per coin, and `qty` [N, K] is the cumulative quantity
    at each window tick: non-increasing for a buy, non-decreasing for a sell.
    An order lives for this batch only; unfilled quantity expires.
    """

    w: torch.Tensor  # [N] world
    c: torch.Tensor  # [N] coin slot
    p: torch.Tensor  # [N] person
    side: torch.Tensor  # [N] BUY or SELL
    qty: torch.Tensor  # [N, K] tokens


@dataclass
class BatchResult:
    # Per coin, [W, C].
    tick: torch.Tensor
    price: torch.Tensor  # micro-lamports per token, int64
    volume: torch.Tensor
    traders: torch.Tensor  # distinct people with a fill above the dust size
    user_buy: torch.Tensor  # tokens bought by users
    user_sell: torch.Tensor
    q_buy: torch.Tensor
    q_sell: torch.Tensor
    fees: torch.Tensor
    excess_demand: torch.Tensor  # unfilled tokens at the clearing tick
    excess_supply: torch.Tensor
    at_edge: torch.Tensor  # cleared at the edge of the window
    # Per order, [N].
    fill: torch.Tensor
    cash_delta: torch.Tensor
    fee: torch.Tensor
    fee_rate: torch.Tensor
    counted: torch.Tensor
    accepted: torch.Tensor  # the order's curve after intake clipping, [N, K]
    clearing: Clearing
    settlement: Settlement


def sanitize(orders: Orders) -> Orders:
    """Force curves into canonical monotone form (for untrusted input)."""
    q = orders.qty.clamp(min=0)
    buy = (orders.side == BUY).unsqueeze(1)
    down = q.flip(1).cummax(1).values.flip(1)  # non-increasing
    up = q.cummax(1).values  # non-decreasing
    return Orders(orders.w, orders.c, orders.p, orders.side, torch.where(buy, down, up))


def reject_duplicates(orders: Orders, cfg: MarketConfig) -> Orders:
    """Keep the first order per person per coin; zero the rest.

    A person therefore cannot be on both sides of one coin in one batch.
    """
    key = (orders.w * cfg.n_slots + orders.c) * cfg.n_people + orders.p
    order = torch.argsort(key, stable=True)
    ks = key[order]
    dup_sorted = torch.zeros_like(ks, dtype=torch.bool)
    dup_sorted[1:] = ks[1:] == ks[:-1]
    dup = torch.zeros_like(dup_sorted)
    dup[order] = dup_sorted
    return Orders(orders.w, orders.c, orders.p, orders.side, torch.where(dup.unsqueeze(1), 0, orders.qty))


def _budgets(state: MarketState, orders: Orders, price: torch.Tensor, cfg: MarketConfig, exclusive: bool):
    """Cash each buy order may spend. A person's orders reserve cash in list order."""
    pw = orders.w * cfg.n_people + orders.p
    cash = state.cash.reshape(-1)[pw]
    if exclusive:
        return cash
    is_buy = orders.side == BUY
    worst = (orders.qty.double() * price.double() / PRICE_SCALE).max(dim=1).values
    worst = torch.where(is_buy, worst * (1 + cfg.base_fee_bps / BPS) + 4, torch.zeros_like(worst))
    order = torch.argsort(pw, stable=True)
    ws, ps = worst[order], pw[order]
    before = torch.cumsum(ws, 0) - ws
    start = torch.full((cfg.n_worlds * cfg.n_people,), float("inf"), dtype=torch.float64, device=ws.device)
    start = start.scatter_reduce(0, ps, before, reduce="amin")
    spent_before = torch.zeros_like(ws)
    spent_before[order] = before - start[ps]
    return (cash.double() - spent_before).clamp(min=0).floor().long()


def step_batch(
    state: MarketState,
    orders: Orders,
    quote: Quote,
    cfg: MarketConfig,
    exclusive: bool = True,
) -> BatchResult:
    """Clear and settle one batch for every coin, mutating `state`.

    `exclusive=True` asserts each person sends at most one order this batch
    (the simulator's case); otherwise a person's orders reserve cash in order.
    Lifecycle (launch, cut, seating, death) is a separate step run afterwards.
    """
    W, C, P, K = cfg.n_worlds, cfg.n_slots, cfg.n_people, cfg.window
    G = W * C
    group = orders.w * C + orders.c
    is_buy = orders.side == BUY
    pw = orders.w * P + orders.p
    hp = group * P + orders.p
    price_gk, valid = window_prices(state.tick, cfg)
    price_nk = price_gk[group]

    # Intake: funded, within the cap, only on live coins and existing ticks.
    live = (state.stage.reshape(G) > 0)[group]
    hold = state.hold.reshape(-1)[hp]
    cap = state.cap_tokens(quote.cap_share, cfg).reshape(G)[group]
    room = (cap - hold).clamp(min=0)
    budget = _budgets(state, orders, price_nk, cfg, exclusive).clamp(max=9_000_000_000_000)
    net = (budget * BPS // (BPS + cfg.base_fee_bps) - 2).clamp(min=0)
    affordable = net.unsqueeze(1) * PRICE_SCALE // price_nk
    qty = orders.qty.clamp(min=0)
    buy_q = torch.minimum(torch.minimum(qty, affordable), room.unsqueeze(1))
    sell_q = torch.minimum(qty, hold.unsqueeze(1))
    qty = torch.where(is_buy.unsqueeze(1), buy_q, sell_q)
    qty = torch.where(live.unsqueeze(1) & valid[group], qty, 0)

    bid = torch.where(valid, quote.bid, 0)
    ask = torch.minimum(torch.where(valid, quote.ask, 0), state.q_tokens.reshape(G, 1))

    cl = clear(group, is_buy, qty, orders.p, bid, ask, P, rot=state.t * 7919)
    price = price_gk.gather(1, cl.k.unsqueeze(1)).squeeze(1)

    seated = state.stage.reshape(G) >= ROOKIE
    danger = seated & (state.timer.reshape(G) < cfg.danger_timer)
    st = settle(
        state, cfg, group, pw, hp, is_buy, cl.fill, price, cl.q_buy, cl.q_sell,
        quote.fee0.reshape(G), quote.half_life.reshape(G), quote.slope.reshape(G), danger,
    )  # fmt: skip

    traded = cl.volume > 0
    new_tick = torch.where(traded, state.tick.reshape(G) - K // 2 + cl.k, state.tick.reshape(G))
    state.tick = new_tick.reshape(W, C)

    counted = st.notional >= cfg.dust_lamports
    zeros = torch.zeros(G, dtype=torch.int64, device=price.device)
    traders = zeros.index_add(0, group, counted.long())
    user_buy = zeros.index_add(0, group, torch.where(is_buy, cl.fill, 0))
    user_sell = zeros.index_add(0, group, torch.where(is_buy, 0, cl.fill))
    v = lambda x: x.reshape(W, C)
    return BatchResult(
        tick=state.tick,
        price=v(price),
        volume=v(cl.volume),
        traders=v(traders),
        user_buy=v(user_buy),
        user_sell=v(user_sell),
        q_buy=v(cl.q_buy),
        q_sell=v(cl.q_sell),
        fees=v(st.fees),
        excess_demand=v(cl.demand - cl.volume),
        excess_supply=v(cl.supply - cl.volume),
        at_edge=v(traded & ((cl.k == 0) | (cl.k == K - 1))),
        fill=cl.fill,
        cash_delta=st.cash_delta,
        fee=st.fee,
        fee_rate=st.fee_rate,
        counted=counted,
        accepted=qty,
        clearing=cl,
        settlement=st,
    )
