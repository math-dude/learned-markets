"""Uniform-price batch clearing for curve orders on a tick window.

An order is a cumulative quantity at each of K ticks: a buy is non-increasing
in price, a sell is non-decreasing. The quoter's bid and ask are ordinary
orders here, so users and the quoter have equal priority by construction.

Rules (docs/ai-gen/decisions.md, sealed batch auction):
* one clearing tick per group, the one that maximizes executed volume;
* the maximizing ticks form one unbroken range, and the previous tick clamped
  into that range is chosen;
* on the long side, quantity still wanted one tick worse fills first and the
  marginal quantity fills pro rata, rounded down;
* the short side fills in full. The few units lost to rounding go to long-side
  orders that still want more, starting from an index that rotates each batch.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch


@dataclass
class Clearing:
    k: torch.Tensor  # [G] clearing index in the window
    volume: torch.Tensor  # [G] tokens executed
    fill: torch.Tensor  # [N] tokens filled per user order
    q_buy: torch.Tensor  # [G] tokens the quoter bought
    q_sell: torch.Tensor  # [G] tokens the quoter sold
    demand: torch.Tensor  # [G] total demand at the clearing tick
    supply: torch.Tensor  # [G] total supply at the clearing tick
    lo: torch.Tensor  # [G] first volume-maximizing index
    hi: torch.Tensor  # [G] last volume-maximizing index


def clear(
    group: torch.Tensor,
    is_buy: torch.Tensor,
    qty: torch.Tensor,
    pid: torch.Tensor,
    q_bid: torch.Tensor,
    q_ask: torch.Tensor,
    n_people: int,
    rot: int,
) -> Clearing:
    """Clear every group at once.

    group [N] int64, is_buy [N] bool, qty [N, K] int64, pid [N] int64 (person
    index, used only for the residue rotation), q_bid / q_ask [G, K] int64.
    The previous clearing tick sits at window index K // 2.
    """
    G, K = q_bid.shape
    N = group.shape[0]
    dev = q_bid.device
    c0 = K // 2
    buy_col = is_buy.unsqueeze(1)

    demand = q_bid.clone().index_add_(0, group, torch.where(buy_col, qty, 0))
    supply = q_ask.clone().index_add_(0, group, torch.where(buy_col, 0, qty))
    vol = torch.minimum(demand, supply)
    V = vol.max(dim=1).values
    is_max = vol == V.unsqueeze(1)
    ar = torch.arange(K, device=dev).expand(G, K)
    lo = torch.where(is_max, ar, K).min(dim=1).values
    hi = torch.where(is_max, ar, -1).max(dim=1).values
    k = torch.clamp(torch.full_like(lo, c0), min=lo, max=hi)
    k = torch.where(V > 0, k, torch.full_like(k, c0))

    def at(curve: torch.Tensor, idx: torch.Tensor) -> torch.Tensor:
        ok = (idx >= 0) & (idx < K)
        return curve.gather(1, idx.clamp(0, K - 1).unsqueeze(1)).squeeze(1) * ok

    # Wanted at the clearing tick, and still wanted one tick worse ("infra").
    kn = k[group]
    want_u = at(qty, kn)
    infra_u = at(qty, torch.where(is_buy, kn + 1, kn - 1))
    garange = torch.arange(G, device=dev)
    want = torch.cat([want_u, at(q_bid, k), at(q_ask, k)])
    infra = torch.cat([infra_u, at(q_bid, k + 1), at(q_ask, k - 1)])
    # Side-groups: 2 * group for buys, 2 * group + 1 for sells.
    g2 = torch.cat([group * 2 + (~is_buy).long(), garange * 2, garange * 2 + 1])
    pidx = torch.cat([pid, torch.full((2 * G,), n_people, dtype=torch.int64, device=dev)])

    zeros = torch.zeros(2 * G, dtype=torch.int64, device=dev)
    tot_want = zeros.index_add(0, g2, want)[g2]
    tot_infra = zeros.index_add(0, g2, infra)[g2]
    v = V.repeat_interleave(2)[g2]

    short = tot_want <= v
    infra_only = tot_infra >= v
    pro_infra = infra * v // tot_infra.clamp(min=1)
    pro_marg = infra + (want - infra) * (v - tot_infra) // (tot_want - tot_infra).clamp(min=1)
    fill = torch.where(short, want, torch.where(infra_only, pro_infra, pro_marg))
    rem = torch.where(short, 0, torch.where(infra_only, infra - fill, want - fill))

    # Rounding residue: hand it to long-side orders in a rotating order.
    residue = V.repeat_interleave(2) - zeros.index_add(0, g2, fill)
    order = torch.argsort(g2 * (n_people + 1) + (pidx + rot) % (n_people + 1))
    rem_s, g_s = rem[order], g2[order]
    before = torch.cumsum(rem_s, 0) - rem_s
    start = torch.full((2 * G,), torch.iinfo(torch.int64).max, dtype=torch.int64, device=dev)
    start = start.scatter_reduce(0, g_s, before, reduce="amin")
    extra = torch.minimum((residue[g_s] - (before - start[g_s])).clamp(min=0), rem_s)
    fill = fill.index_add(0, order, extra)

    return Clearing(
        k=k,
        volume=V,
        fill=fill[:N],
        q_buy=fill[N : N + G],
        q_sell=fill[N + G :],
        demand=at(demand, k),
        supply=at(supply, k),
        lo=lo,
        hi=hi,
    )
