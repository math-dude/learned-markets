"""Convert between the program's 16-point curve payload and a tick-window curve.

Payload (programs/learned-markets/src/payload.rs): prices strictly increasing;
at `price` the participant trades up to `quantity` in total. Quantities are
non-increasing for a buy and non-decreasing for a sell. Here prices are
micro-lamports per token and quantities are whole tokens; the payload's own
price unit is still to be pinned (see the plan's interface notes).
"""

from __future__ import annotations

import torch

from .units import N_TICKS, prices

MAX_CURVE_POINTS = 16


def payload_to_window(points: list[tuple[int, int]], is_buy: bool, centre_tick: int, window: int) -> torch.Tensor:
    """Sample a payload curve onto the window as a step function, conservatively.

    A buy at tick price p wants the quantity of the first point priced at or
    above p (nothing above its highest price). A sell offers the quantity of
    the last point priced at or below p (nothing below its lowest price).
    """
    table = prices()
    out = torch.zeros(window, dtype=torch.int64)
    for i in range(window):
        tick = centre_tick - window // 2 + i
        if tick < 0 or tick >= N_TICKS:
            continue
        p = int(table[tick])
        if is_buy:
            at_or_above = [q for price, q in points if price >= p]
            out[i] = at_or_above[0] if at_or_above else 0
        else:
            at_or_below = [q for price, q in points if price <= p]
            out[i] = at_or_below[-1] if at_or_below else 0
    return out


def window_to_payload(qty: torch.Tensor, is_buy: bool, centre_tick: int) -> list[tuple[int, int]]:
    """Encode a window curve as at most 16 points, never offering more than the curve.

    Points sit where the quantity changes. If there are more than 16 changes
    the curve is thinned by keeping every n-th change, which for either side
    only removes quantity at intermediate prices.
    """
    table = prices()
    window = qty.shape[0]
    pts: list[tuple[int, int]] = []
    seq = range(window - 1, -1, -1) if is_buy else range(window)
    last = 0
    for i in seq:
        tick = centre_tick - window // 2 + i
        if tick < 0 or tick >= N_TICKS:
            continue
        q = int(qty[i])
        if q != last:
            pts.append((int(table[tick]), q))
            last = q
    if len(pts) > MAX_CURVE_POINTS:
        stride = -(-len(pts) // MAX_CURVE_POINTS)
        pts = pts[::stride]
    return sorted(pts)
