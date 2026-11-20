"""The backend runs the same market core as the simulator and its records add up."""

from __future__ import annotations

import torch
from learned_markets_backend.auctioneer import Auctioneer
from learned_markets_backend.fixture import build
from learned_markets_backend.quoter_net import QuoterPolicy
from learned_markets_core import BUY, MarketConfig, Orders, build_quote, rule_based_params, step_batch
from learned_markets_core.curves import payload_to_window
from learned_markets_core.tape import N_QUOTER_FEATURES
from learned_markets_core.units import prices

CFG = MarketConfig(n_worlds=1, n_slots=4, n_people=8, device="cpu")


def _launched(policy=None) -> Auctioneer:
    a = Auctioneer(CFG, policy)
    for person in range(CFG.n_people):
        a.credit(person, 10 * 10**9)
    a.begin_batch()
    a.request_launch(0)
    a.clear()
    assert a.snapshot()["coins"][0]["stage"] == "line"
    return a


def test_backend_fills_equal_the_core_called_directly():
    a = _launched()
    table = prices()
    tick = int(a.state.tick[0, 0])
    points = {
        1: [(int(table[tick + 3]), 2_000_000)],
        2: [(int(table[tick + 1]), 900_000), (int(table[tick + 8]), 400_000)],
    }
    twin = a.state.clone()
    a.begin_batch()
    for person, pts in points.items():
        a.submit(person, 0, "buy", pts)
    got = a.clear()["records"][0]

    qty = torch.stack([payload_to_window(pts, True, tick, CFG.window) for pts in points.values()])
    orders = Orders(torch.zeros(2, dtype=torch.int64), torch.zeros(2, dtype=torch.int64), torch.tensor(list(points)),
                    torch.full((2,), BUY), qty)  # fmt: skip
    zero = torch.zeros(1, CFG.n_slots)
    res = step_batch(
        twin, orders, build_quote(twin, rule_based_params(twin, zero, CFG, zero), CFG), CFG, exclusive=False
    )
    assert [f["quantity"] for f in got["fills"]] == res.fill.tolist()
    assert got["clearing_price"] == int(res.price[0, 0])
    assert torch.equal(a.state.cash, twin.cash)


def test_records_recompute_to_the_ledger():
    """Replaying the fixture with the documented arithmetic reproduces every balance."""
    data = build(seed=3, batches=20)
    k = data["constants"]
    cash = list(data["initial_cash"])
    fee = data["launch"]["launch_fee"]
    cash[data["launch"]["deployer"]] -= fee
    reserve_cash = fee * k["launch_fee_to_bucket_ppm"] // k["ppm"]
    platform = fee - reserve_cash
    reserve_tokens, tokens = k["supply"], [0] * data["people"]
    assert len(data["batches"]) > 5
    for b in data["batches"]:
        p, paid, received, fees, bought, sold = b["clearing_price"], 0, 0, 0, 0, 0
        for f in b["fills"]:
            q = f["quantity"]
            if f["side"] == "buy":
                pay = -(-q * p // k["price_scale"])
                fe = -(-pay * k["base_fee_bps"] // k["bps"])
                cash[f["person"]] -= pay + fe
                tokens[f["person"]] += q
                paid, bought = paid + pay, bought + q
            else:
                recv = q * p // k["price_scale"]
                fe = min(-(-recv * f["fee_rate_ppm"] // k["ppm"]), recv)
                assert k["base_fee_bps"] * 100 <= f["fee_rate_ppm"] <= k["fee_ceiling_ppm"]
                cash[f["person"]] += recv - fe
                tokens[f["person"]] -= q
                received, sold = received + recv, sold + q
            assert fe == f["fee"]
            fees += fe
        assert bought + b["quoter_buy"] == sold + b["quoter_sell"]
        to_bucket = fees * k["fee_to_bucket_ppm"] // k["ppm"]
        reserve_cash += paid - received + to_bucket
        platform += fees - to_bucket
        reserve_tokens += b["quoter_buy"] - b["quoter_sell"]
        after = b["after"]
        assert cash == after["cash"] and tokens == after["tokens"]
        assert reserve_cash == after["reserve_cash"] and reserve_tokens == after["reserve_tokens"]
        assert platform == after["platform_cash"]


def test_a_learned_policy_drives_the_backend():
    torch.manual_seed(0)
    a = _launched(QuoterPolicy(N_QUOTER_FEATURES, 10))
    terms = a.begin_batch()
    assert len(terms["quoter_commitment"]) == 64 and terms["coins"]
    a.submit(3, 0, "buy", [(terms["coins"][0]["last_price"] * 2, 1_000_000)])
    out = a.clear()
    assert out["records"] and out["records"][0]["fills"][0]["quantity"] > 0
