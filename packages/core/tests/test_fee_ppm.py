"""The program's integer fee floor applies after float32 policy inference."""

import torch

from learned_markets_core.ledger import fee_rate_ppm
from learned_markets_core.state import MarketConfig


def test_base_only_exit_survives_integer_wire_conversion():
    cfg = MarketConfig()
    rates = torch.tensor([0.01, 0.0, 0.25, 0.4], dtype=torch.float32)
    assert int((rates[0].double() * 1_000_000).long()) == 9999
    assert fee_rate_ppm(rates, cfg).tolist() == [10000, 10000, 250000, 250000]
