"""Export an episode from Eren's shared core for Rust and Python replay."""

from __future__ import annotations

import json
from pathlib import Path

import torch
from learned_markets_core.curves import payload_to_window
from learned_markets_core.ledger import check_invariants, fee_rate_ppm, open_coin
from learned_markets_core.market import BUY, SELL, Orders, step_batch
from learned_markets_core.quoter import build_quote, rule_based_params
from learned_markets_core.state import ROOKIE, MarketConfig, MarketState
from learned_markets_core.units import PRICE_SCALE, prices


def episode():
    cfg = MarketConfig(n_worlds=1, n_slots=1, n_people=6, window=16)
    state = MarketState.empty(cfg)
    initial = [1_000_000_000] * 6
    state.cash[0] = torch.tensor(initial)
    total = state.total_cash().clone()
    launch_fee = 100_000_000
    open_coin(
        state,
        cfg,
        torch.tensor([True]),
        torch.tensor([0]),
        torch.tensor([0]),
        torch.tensor([launch_fee]),
        ROOKIE,
    )
    batches = []
    for batch_id in range(1, 7):
        state.t = batch_id
        quote = build_quote(
            state, rule_based_params(state, torch.zeros((1, 1)), cfg), cfg
        )
        people = [1, 2, 3]
        side = [BUY, BUY, BUY] if batch_id % 2 else [SELL, SELL, BUY]
        sizes = [700_001, 500_003, 400_007]
        curves = []
        for person, order_side, size in zip(people, side, sizes):
            price = int(
                prices()[int(state.tick[0, 0]) + (7 if order_side == BUY else -8)]
            )
            curves.append([(price, size)])
        qty = torch.stack(
            [
                payload_to_window(points, s == BUY, int(state.tick[0, 0]), cfg.window)
                for points, s in zip(curves, side)
            ]
        )
        orders = Orders(
            torch.zeros(3, dtype=torch.int64),
            torch.zeros(3, dtype=torch.int64),
            torch.tensor(people),
            torch.tensor(side),
            qty,
        )
        result = step_batch(state, orders, quote, cfg)
        check_invariants(state, cfg, total)
        fills = []
        for i, person in enumerate(people):
            if int(result.fill[i]) == 0:
                continue
            fills.append(
                {
                    "person": person,
                    "side": "buy" if side[i] == BUY else "sell",
                    "curve": curves[i],
                    "quantity": int(result.fill[i]),
                    "fee_rate_ppm": int(fee_rate_ppm(result.fee_rate[i], cfg))
                    if side[i] == SELL
                    else 0,
                    "pay_or_recv": int(result.settlement.notional[i]),
                    "fee": int(result.fee[i]),
                }
            )
        batches.append(
            {
                "batch_id": batch_id,
                "clearing_price": int(result.price[0, 0]),
                "quoter_buy": int(result.q_buy[0, 0]),
                "quoter_sell": int(result.q_sell[0, 0]),
                "fills": fills,
                "after": {
                    "cash": state.cash[0].tolist(),
                    "tokens": state.hold[0, 0].tolist(),
                    "reserve_cash": int(state.q_cash[0, 0]),
                    "reserve_tokens": int(state.q_tokens[0, 0]),
                    "platform_cash": int(state.platform_cash[0]),
                },
            }
        )
    return {
        "constants": {
            "price_scale": PRICE_SCALE,
            "base_fee_bps": cfg.base_fee_bps,
            "fee_to_bucket_ppm": cfg.fee_to_bucket_ppm,
        },
        "people": cfg.n_people,
        "initial_cash": initial,
        "launch": {"deployer": 0, "launch_fee": launch_fee},
        "batches": batches,
    }


if __name__ == "__main__":
    destination = (
        Path(__file__).resolve().parents[1] / "fixtures/settlement-episode.json"
    )
    destination.write_text(json.dumps(episode(), indent=2) + "\n")
    print(destination)
