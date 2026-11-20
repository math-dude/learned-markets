"""Clearing rules: differential test against the plain-Python reference, and properties."""

from __future__ import annotations

import torch
from hypothesis import given, settings
from hypothesis import strategies as st
from learned_markets_core import clear
from reference import reference_clear

K = 12
P = 6


def _curve(draw, is_buy: bool, scale: int) -> list[int]:
    steps = draw(st.lists(st.integers(0, scale), min_size=K, max_size=K))
    # Most ticks should not add quantity, so curves look like a few limit levels.
    mask = draw(st.lists(st.integers(0, 3), min_size=K, max_size=K))
    inc = [s if m == 0 else 0 for s, m in zip(steps, mask)]
    cum, total = [], 0
    for x in inc:
        total += x
        cum.append(total)
    return cum[::-1] if is_buy else cum


@st.composite
def books(draw):
    scale = draw(st.sampled_from([3, 50, 10**6, 10**8]))
    people = draw(st.lists(st.integers(0, P - 1), unique=True, max_size=P))
    orders = []
    for p in people:
        is_buy = draw(st.booleans())
        orders.append((p, is_buy, _curve(draw, is_buy, scale)))
    q_bid = _curve(draw, True, scale) if draw(st.booleans()) else [0] * K
    q_ask = _curve(draw, False, scale) if draw(st.booleans()) else [0] * K
    return orders, q_bid, q_ask, draw(st.integers(0, 10_000))


def _run(orders, q_bid, q_ask, rot):
    n = len(orders)
    group = torch.zeros(n, dtype=torch.int64)
    is_buy = torch.tensor([b for _, b, _ in orders], dtype=torch.bool)
    qty = torch.tensor([q for _, _, q in orders], dtype=torch.int64).reshape(n, K)
    pid = torch.tensor([p for p, _, _ in orders], dtype=torch.int64)
    return clear(group, is_buy, qty, pid, torch.tensor([q_bid]), torch.tensor([q_ask]), P, rot)


@settings(max_examples=400, deadline=None)
@given(books())
def test_matches_reference(book):
    orders, q_bid, q_ask, rot = book
    got = _run(orders, q_bid, q_ask, rot)
    want = reference_clear(orders, q_bid, q_ask, P, rot)
    assert int(got.k[0]) == want["k"]
    assert int(got.volume[0]) == want["volume"]
    assert got.fill.tolist() == want["fills"]
    assert int(got.q_buy[0]) == want["q_buy"]
    assert int(got.q_sell[0]) == want["q_sell"]


@settings(max_examples=400, deadline=None)
@given(books())
def test_clearing_properties(book):
    orders, q_bid, q_ask, rot = book
    got = _run(orders, q_bid, q_ask, rot)
    k, v = int(got.k[0]), int(got.volume[0])
    buys = sum(f for f, (_, b, _) in zip(got.fill.tolist(), orders) if b) + int(got.q_buy[0])
    sells = sum(f for f, (_, b, _) in zip(got.fill.tolist(), orders) if not b) + int(got.q_sell[0])
    # Both sides execute exactly the maximal volume.
    assert buys == v == sells
    # No fill exceeds what the curve wanted at the clearing tick: every limit is respected.
    for f, (_, _, q) in zip(got.fill.tolist(), orders):
        assert 0 <= f <= q[k]
    assert int(got.q_buy[0]) <= q_bid[k] and int(got.q_sell[0]) <= q_ask[k]
    # The chosen tick is the previous tick clamped into the maximizing range.
    assert int(got.lo[0]) <= k <= int(got.hi[0]) or v == 0
    if v > 0:
        assert k == min(max(K // 2, int(got.lo[0])), int(got.hi[0]))
    # Better-priced quantity fills before marginal quantity on the buy side.
    for f, (_, b, q) in zip(got.fill.tolist(), orders):
        infra = (q[k + 1] if k + 1 < K else 0) if b else (q[k - 1] if k >= 1 else 0)
        marginal_filled = f > infra
        if marginal_filled:
            side_infra_unfilled = any(
                f2 < ((q2[k + 1] if k + 1 < K else 0) if b2 else (q2[k - 1] if k >= 1 else 0))
                for f2, (_, b2, q2) in zip(got.fill.tolist(), orders)
                if b2 == b
            )
            assert not side_infra_unfilled


@settings(max_examples=200, deadline=None)
@given(books())
def test_quoter_has_no_priority(book):
    """Moving the quoter's bid into a user order (and back) changes nobody's fill."""
    orders, q_bid, q_ask, rot = book
    free = [p for p in range(P) if p not in {o[0] for o in orders}]
    if not free or not any(q_bid):
        return
    base = _run(orders, q_bid, q_ask, rot)
    moved = _run(orders + [(free[0], True, q_bid)], [0] * K, q_ask, rot)
    assert int(base.k[0]) == int(moved.k[0])
    assert int(base.volume[0]) == int(moved.volume[0])
    # Pro-rata shares are identical; only the rotating residue (a few units) may move.
    diffs = [abs(a - b) for a, b in zip(base.fill.tolist(), moved.fill.tolist()[:-1])]
    assert sum(diffs) <= len(orders) + 1
    assert abs(int(base.q_buy[0]) - int(moved.fill[-1])) <= len(orders) + 1


def test_batches_are_independent():
    """Clearing many groups at once equals clearing each alone."""
    g = torch.Generator().manual_seed(0)
    G, N = 5, 40
    group = torch.randint(0, G, (N,), generator=g)
    pid = torch.arange(N)
    is_buy = torch.rand(N, generator=g) < 0.5
    inc = torch.randint(0, 1000, (N, K), generator=g) * (torch.rand(N, K, generator=g) < 0.3)
    up = inc.cumsum(1)
    qty = torch.where(is_buy.unsqueeze(1), up.flip(1), up)
    q_bid = (torch.randint(0, 500, (G, K), generator=g)).cumsum(1).flip(1)
    q_ask = (torch.randint(0, 500, (G, K), generator=g)).cumsum(1)
    whole = clear(group, is_buy, qty, pid, q_bid, q_ask, N, 3)
    for i in range(G):
        m = group == i
        one = clear(torch.zeros(int(m.sum()), dtype=torch.int64), is_buy[m], qty[m], pid[m],
                    q_bid[i : i + 1], q_ask[i : i + 1], N, 3)  # fmt: skip
        assert int(one.k[0]) == int(whole.k[i])
        assert one.fill.tolist() == whole.fill[m].tolist()
        assert int(one.q_buy[0]) == int(whole.q_buy[i])
