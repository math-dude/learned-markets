"""The backend calls the same step_batch function as the simulator."""

import torch
from learned_markets_core.curves import payload_to_window
from learned_markets_core.ledger import fee_rate_ppm
from learned_markets_core.market import BUY, SELL, Orders, step_batch
from learned_markets_core.quoter import Quote as CoreQuote

from .contracts import ClearRequest
from .policy import state_for


def clear(request: ClearRequest, tape=None):
    """Clear one batch. A `tape` (one world, one slot) is folded forward with the result."""
    state, cfg = state_for(request.market, len(request.people))
    indices = {p.participant: i for i, p in enumerate(request.people)}
    for i, person in enumerate(request.people):
        state.cash[0, i] = person.cash
        state.hold[0, 0, i] = person.tokens
        state.buy_time[0, 0, i] = person.buy_time
        state.lock_fee[0, 0, i] = person.lock_fee
        state.lock_half[0, 0, i] = person.lock_half
    quote = request.quote
    core_quote = CoreQuote(
        bid=torch.tensor([quote.bid]),
        ask=torch.tensor([quote.ask]),
        cap_share=torch.tensor([[quote.cap_share]]),
        fee0=torch.tensor([[quote.fee0]]),
        half_life=torch.tensor([[quote.half_life]]),
        slope=torch.tensor([[quote.slope]]),
    )
    orders = request.user_curves
    qty = (
        torch.stack(
            [
                payload_to_window(
                    [(point.price, point.quantity) for point in order.curve],
                    order.side == "buy",
                    request.market.tick,
                    cfg.window,
                )
                for order in orders
            ]
        )
        if orders
        else torch.zeros((0, cfg.window), dtype=torch.int64)
    )
    n = len(orders)
    batch = Orders(
        torch.zeros(n, dtype=torch.int64),
        torch.zeros(n, dtype=torch.int64),
        torch.tensor([indices[o.participant] for o in orders], dtype=torch.int64),
        torch.tensor([BUY if o.side == "buy" else SELL for o in orders], dtype=torch.int64),
        qty,
    )
    result = step_batch(state, batch, core_quote, cfg)
    if tape is not None:
        tape.update(torch.ones(1, 1, dtype=torch.bool), result, state)
    if (
        bool((state.cash < 0).any())
        or bool((state.hold < 0).any())
        or bool((state.q_cash < 0).any())
        or bool((state.q_tokens < 0).any())
    ):
        raise ValueError("clearing produced an unfunded ledger")

    fills = []
    for i, order in enumerate(orders):
        if int(result.fill[i]) == 0:
            continue
        rate = int(fee_rate_ppm(result.fee_rate[i], cfg)) if order.side == "sell" else 0
        fills.append(
            {
                "intent": order.intent,
                "participant": order.participant,
                "side": order.side,
                "quantity": str(int(result.fill[i])),
                "fee_rate_ppm": rate,
                "fee": str(int(result.fee[i])),
                "cash_delta": str(int(result.cash_delta[i])),
            }
        )
    return {
        "batch_id": str(request.market.batch_id),
        "clearing_price": str(int(result.price[0, 0])),
        "quoter_buy": str(int(result.q_buy[0, 0])),
        "quoter_sell": str(int(result.q_sell[0, 0])),
        "fills": fills,
        "after": {
            "tick": int(state.tick[0, 0]),
            "reserve_cash": str(int(state.q_cash[0, 0])),
            "reserve_tokens": str(int(state.q_tokens[0, 0])),
            "platform_cash_delta": str(int(state.platform_cash[0])),
            "people": [
                {
                    "participant": person.participant,
                    "cash": str(int(state.cash[0, i])),
                    "tokens": str(int(state.hold[0, 0, i])),
                    "buy_time": float(state.buy_time[0, 0, i]),
                    "lock_fee": float(state.lock_fee[0, 0, i]),
                    "lock_half": float(state.lock_half[0, 0, i]),
                }
                for i, person in enumerate(request.people)
            ],
        },
    }
