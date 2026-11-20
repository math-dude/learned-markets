"""Slow, plain-Python clearing written from the rules, for differential tests."""

from __future__ import annotations


def _ration(entries: list[tuple[int, int, int]], volume: int, n_people: int, rot: int) -> list[int]:
    """entries: (person index, want, infra). Returns fills summing to `volume` on a long side."""
    total_want = sum(w for _, w, _ in entries)
    total_infra = sum(i for _, _, i in entries)
    if total_want <= volume:
        return [w for _, w, _ in entries]
    if total_infra >= volume:
        fills = [i * volume // max(total_infra, 1) for _, _, i in entries]
        rem = [i - f for (_, _, i), f in zip(entries, fills)]
    else:
        spare = volume - total_infra
        marginal = total_want - total_infra
        fills = [i + (w - i) * spare // marginal for _, w, i in entries]
        rem = [w - f for (_, w, _), f in zip(entries, fills)]
    residue = volume - sum(fills)
    order = sorted(range(len(entries)), key=lambda j: (entries[j][0] + rot) % (n_people + 1))
    for j in order:
        give = min(residue, rem[j])
        fills[j] += give
        residue -= give
    assert residue == 0
    return fills


def reference_clear(
    orders: list[tuple[int, bool, list[int]]],
    q_bid: list[int],
    q_ask: list[int],
    n_people: int,
    rot: int,
) -> dict:
    """orders: (person index, is_buy, cumulative qty per window tick) for one group."""
    K = len(q_bid)
    c0 = K // 2
    demand = [q_bid[k] + sum(q[k] for _, b, q in orders if b) for k in range(K)]
    supply = [q_ask[k] + sum(q[k] for _, b, q in orders if not b) for k in range(K)]
    vol = [min(d, s) for d, s in zip(demand, supply)]
    volume = max(vol)
    best = [k for k in range(K) if vol[k] == volume]
    assert best == list(range(best[0], best[-1] + 1)), "maximizing ticks are not one range"
    k = min(max(c0, best[0]), best[-1]) if volume > 0 else c0

    def at(curve: list[int], idx: int) -> int:
        return curve[idx] if 0 <= idx < K else 0

    buys = [(p, at(q, k), at(q, k + 1)) for p, b, q in orders if b] + [(n_people, at(q_bid, k), at(q_bid, k + 1))]
    sells = [(p, at(q, k), at(q, k - 1)) for p, b, q in orders if not b] + [(n_people, at(q_ask, k), at(q_ask, k - 1))]
    buy_fills = _ration(buys, volume, n_people, rot)
    sell_fills = _ration(sells, volume, n_people, rot)
    fills, bi, si = [], 0, 0
    for _, b, _ in orders:
        if b:
            fills.append(buy_fills[bi])
            bi += 1
        else:
            fills.append(sell_fills[si])
            si += 1
    return {"k": k, "volume": volume, "fills": fills, "q_buy": buy_fills[-1], "q_sell": sell_fills[-1]}
