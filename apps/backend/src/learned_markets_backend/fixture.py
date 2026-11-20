"""Write the settlement parity fixture: a short episode with every balance after each batch.

    uv run --all-packages python -m learned_markets_backend.fixture /tmp/episode.json

The program replays it on Surfpool and must reach the same balances
(docs/ai-gen/design/settlement-interface.md).
"""

from __future__ import annotations

import json
import random
import sys

from learned_markets_core import MarketConfig
from learned_markets_core.units import BPS, PPM, PRICE_SCALE, prices

from .auctioneer import Auctioneer

PEOPLE = 6


def build(seed: int = 7, batches: int = 14) -> dict:
    rng = random.Random(seed)
    cfg = MarketConfig(n_worlds=1, n_slots=4, n_people=PEOPLE, device="cpu")
    a = Auctioneer(cfg)
    initial = [rng.randrange(2, 20) * 10**9 for _ in range(PEOPLE)]
    for person, lamports in enumerate(initial):
        a.credit(person, lamports)
    launch_fee = int(a.lever_values[0, 0])
    a.begin_batch()
    a.request_launch(0)
    a.clear()
    table = prices()
    out_batches = []
    for _ in range(batches):
        a.begin_batch()
        tick = int(a.state.tick[0, 0])
        curves = {}
        for person in range(PEOPLE):
            if rng.random() < 0.25:
                continue
            held = int(a.state.hold[0, 0, person])
            sell = held > 0 and rng.random() < 0.45
            # Two price levels around the last price, as a canonical payload curve.
            if sell:
                lo, hi = sorted(rng.sample(range(tick - 6, tick + 4), 2))
                q1 = rng.randrange(1, held + 1)
                points = [(int(table[lo]), q1), (int(table[hi]), held)]
            else:
                lo, hi = sorted(rng.sample(range(tick - 3, tick + 12), 2))
                big = rng.randrange(200_000, 6_000_000)
                points = [(int(table[lo]), big), (int(table[hi]), big // rng.randrange(2, 5))]
            curves[person] = points
            a.submit(person, 0, "sell" if sell else "buy", points)
        result = a.clear()
        s = a.state
        for rec in result["records"]:
            for fill in rec["fills"]:
                fill["curve"] = [list(p) for p in curves[fill["person"]]]
            rec["after"] = {
                "cash": s.cash[0].tolist(),
                "tokens": s.hold[0, rec["slot"]].tolist(),
                "reserve_cash": int(s.q_cash[0, rec["slot"]]),
                "reserve_tokens": int(s.q_tokens[0, rec["slot"]]),
                "platform_cash": int(s.platform_cash[0]),
            }
            out_batches.append(rec)
    return {
        "constants": {
            "price_scale": PRICE_SCALE,
            "base_fee_bps": cfg.base_fee_bps,
            "bps": BPS,
            "ppm": PPM,
            "fee_to_bucket_ppm": cfg.fee_to_bucket_ppm,
            "fee_ceiling_ppm": int(cfg.fee_ceiling * PPM),
            "launch_fee_to_bucket_ppm": cfg.launch_fee_to_bucket_ppm,
            "supply": 1_000_000_000,
        },
        "people": PEOPLE,
        "initial_cash": initial,
        "launch": {"deployer": 0, "launch_fee": launch_fee, "slot": 0},
        "batches": out_batches,
    }


if __name__ == "__main__":
    path = sys.argv[1]
    data = build()
    with open(path, "w") as fh:
        json.dump(data, fh, indent=1)
    fills = sum(len(b["fills"]) for b in data["batches"])
    print(f"{path}: {len(data['batches'])} batches, {fills} fills")
