"""Units and the price tick table.

Quantity is whole tokens, cash is lamports, price is micro-lamports per token.
Prices live on a geometric tick table. The ranges are chosen so that
``quantity * price`` fits in int64 for any per-person fill (at most the hard
holding ceiling of 2% of supply).
"""

from __future__ import annotations

import torch

SUPPLY = 1_000_000_000
PRICE_SCALE = 1_000_000
TICK_RATIO = 1.01
N_TICKS = 2000
MIN_PRICE = 1_000  # micro-lamports per token at tick 0
BPS = 10_000
PPM = 1_000_000


def _build_prices() -> torch.Tensor:
    ticks = torch.arange(N_TICKS, dtype=torch.float64)
    prices = torch.round(MIN_PRICE * TICK_RATIO**ticks).to(torch.int64)
    assert bool((prices[1:] > prices[:-1]).all())
    return prices


_PRICES = _build_prices()
_CACHE: dict[str, torch.Tensor] = {}


def prices(device: torch.device | str = "cpu") -> torch.Tensor:
    """Tick table as int64 on `device`: prices()[tick] is micro-lamports per token."""
    key = str(device)
    if key not in _CACHE:
        _CACHE[key] = _PRICES.to(device)
    return _CACHE[key]


def tick_of_price(price_micro: float) -> int:
    """Nearest tick at or below a price."""
    idx = int(torch.searchsorted(_PRICES, torch.tensor(int(price_micro)), right=True)) - 1
    return max(0, min(N_TICKS - 1, idx))


def notional_up(qty: torch.Tensor, price: torch.Tensor) -> torch.Tensor:
    """Lamports a buyer pays for `qty` tokens: rounded up."""
    return (qty * price + (PRICE_SCALE - 1)) // PRICE_SCALE


def notional_down(qty: torch.Tensor, price: torch.Tensor) -> torch.Tensor:
    """Lamports a seller receives for `qty` tokens: rounded down."""
    return (qty * price) // PRICE_SCALE
