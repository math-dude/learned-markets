"""Fill records shaped for on-chain settlement.

One record per coin per batch, carrying exactly what the program needs to
recompute every cash movement (docs/ai-gen/design/settlement-interface.md):
the clearing price, the quoter's token legs, and per fill the quantity and
the exit fee rate in parts per million.
"""

from __future__ import annotations

from .market import BUY, BatchResult, Orders
from .state import MarketConfig


def batch_records(orders: Orders, res: BatchResult, cfg: MarketConfig, batch_id: int, world: int = 0) -> list[dict]:
    """Settlement records for one world's batch. Coins with no fills are omitted."""
    C = cfg.n_slots
    by_slot: dict[int, dict] = {}
    rows = ((orders.w == world) & (res.fill > 0)).nonzero().squeeze(1).tolist()
    st = res.settlement
    for i in rows:
        slot = int(orders.c[i])
        rec = by_slot.setdefault(slot, {
            "batch_id": batch_id,
            "slot": slot,
            "clearing_price": int(res.price[world, slot]),
            "quoter_buy": int(res.q_buy[world, slot]),
            "quoter_sell": int(res.q_sell[world, slot]),
            "fills": [],
        })  # fmt: skip
        is_buy = int(orders.side[i]) == BUY
        rec["fills"].append({
            "person": int(orders.p[i]),
            "side": "buy" if is_buy else "sell",
            "quantity": int(res.fill[i]),
            "fee_rate_ppm": int(st.fee_rate_ppm[i]),
            "pay_or_recv": int(st.notional[i]),
            "fee": int(res.fee[i]),
        })  # fmt: skip
    assert all(0 <= s < C for s in by_slot)
    return [by_slot[s] for s in sorted(by_slot)]
