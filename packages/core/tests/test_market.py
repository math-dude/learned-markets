"""Ledger invariants and batch-auction boundaries under random orders and random quoters."""

from __future__ import annotations

from dataclasses import fields, replace

import pytest
import torch
from learned_markets_core import (
    BUY,
    SELL,
    SUPPLY,
    MarketConfig,
    MarketState,
    Orders,
    build_quote,
    check_invariants,
    default_lever_values,
    levers_from_values,
    lifecycle_step,
    params_from_action,
    reject_duplicates,
    step_batch,
)
from learned_markets_core.quoter import N_PARAMS, bonding_curve_quote

CFG = MarketConfig(
    n_worlds=3, n_slots=6, n_people=24, window=32,
    cut_round=10, grace=10, epoch=20, seat_min_heat=1.0, graduation_activity=30.0,
    timer_init=15.0, danger_timer=5.0, dust_lamports=1000,
)  # fmt: skip


def fresh(cfg: MarketConfig, seed: int) -> tuple[MarketState, torch.Generator]:
    g = torch.Generator().manual_seed(seed)
    state = MarketState.empty(cfg)
    state.cash = torch.randint(10**9, 5 * 10**10, (cfg.n_worlds, cfg.n_people), generator=g)
    return state, g


def random_orders(cfg: MarketConfig, g: torch.Generator, max_qty: int = 30_000_000) -> Orders:
    """One step-curve order per person: a quantity and a limit tick."""
    W, P, K = cfg.n_worlds, cfg.n_people, cfg.window
    w = torch.arange(W).repeat_interleave(P)
    p = torch.arange(P).repeat(W)
    c = torch.randint(0, cfg.n_slots, (W * P,), generator=g)
    side = torch.randint(0, 2, (W * P,), generator=g)
    size = torch.randint(0, max_qty, (W * P,), generator=g)
    limit = torch.randint(0, K, (W * P,), generator=g)
    k = torch.arange(K).expand(W * P, K)
    wants = torch.where((side == BUY).unsqueeze(1), k <= limit.unsqueeze(1), k >= limit.unsqueeze(1))
    return Orders(w, c, p, side, torch.where(wants, size.unsqueeze(1), 0))


def run(cfg: MarketConfig, seed: int, steps: int, check: bool = True, quoter: str = "random"):
    state, g = fresh(cfg, seed)
    total = state.total_cash()
    levers = levers_from_values(default_lever_values(cfg))
    levers.launch_fee = torch.full_like(levers.launch_fee, 50_000_000)
    levers.line_cap = torch.full_like(levers.line_cap, 4)
    levers.seats = torch.full_like(levers.seats, 2)
    levers.rookie_seats = torch.full_like(levers.rookie_seats, 1)
    log = []
    for _ in range(steps):
        if quoter == "random":
            action = torch.rand(cfg.n_worlds, cfg.n_slots, N_PARAMS, generator=g) * 2 - 1
            quote = build_quote(state, params_from_action(action), cfg)
        else:
            quote = bonding_curve_quote(state, cfg)
        orders = random_orders(cfg, g)
        res = step_batch(state, orders, quote, cfg)
        launch = torch.rand(cfg.n_worlds, generator=g) < 0.5
        deployer = torch.randint(0, cfg.n_people, (cfg.n_worlds,), generator=g)
        ev = lifecycle_step(state, res, levers, launch, deployer, cfg)
        if check:
            check_invariants(state, cfg, total)
        log.append((res, ev))
    return state, log


def test_invariants_hold_under_random_play():
    state, log = run(CFG, seed=1, steps=400)
    traded = sum(int(r.volume.sum()) for r, _ in log)
    ended = sum(int(e.ended.sum()) for _, e in log)
    seated = sum(int(e.seated.sum()) for _, e in log)
    assert traded > 0 and ended > 0 and seated > 0, "the rollout must exercise trading and the lifecycle"
    assert int(state.dead_cash.sum()) > 0


def test_invariants_hold_for_bonding_curve_baseline():
    cfg = replace(CFG, hard_cap_share=1.0, line_cap_share=1.0)
    _state, log = run(cfg, seed=2, steps=300, quoter="curve")
    assert sum(int(r.volume.sum()) for r, _ in log) > 0


def test_deterministic_by_seed():
    a, _ = run(CFG, seed=5, steps=120, check=False)
    b, _ = run(CFG, seed=5, steps=120, check=False)
    for f in fields(a):
        x, y = getattr(a, f.name), getattr(b, f.name)
        assert torch.equal(x, y) if isinstance(x, torch.Tensor) else x == y, f.name


def _slice_state(state: MarketState, w: int) -> MarketState:
    kw = {}
    for f in fields(state):
        v = getattr(state, f.name)
        kw[f.name] = v[w : w + 1].clone() if isinstance(v, torch.Tensor) else v
    return MarketState(**kw)


def test_one_world_equals_a_slice_of_many():
    state, g = fresh(CFG, seed=7)
    cfg1 = replace(CFG, n_worlds=1)
    # Open some coins first so there is something to trade.
    state, _ = run(CFG, seed=7, steps=60, check=False)
    g = torch.Generator().manual_seed(99)
    action = torch.rand(CFG.n_worlds, CFG.n_slots, N_PARAMS, generator=g) * 2 - 1
    orders = random_orders(CFG, g)
    for w in range(CFG.n_worlds):
        solo = _slice_state(state, w)
        m = orders.w == w
        o1 = Orders(
            torch.zeros(int(m.sum()), dtype=torch.int64), orders.c[m], orders.p[m], orders.side[m], orders.qty[m]
        )
        q1 = build_quote(solo, params_from_action(action[w : w + 1]), cfg1)
        r1 = step_batch(solo, o1, q1, cfg1)
        full = state.clone()
        rf = step_batch(full, orders, build_quote(full, params_from_action(action), CFG), CFG)
        assert torch.equal(r1.fill, rf.fill[m])
        assert torch.equal(solo.cash[0], full.cash[w])
        assert torch.equal(solo.hold[0], full.hold[w])
        assert torch.equal(solo.q_cash[0], full.q_cash[w])


def test_order_listing_order_does_not_matter():
    state, _ = run(CFG, seed=11, steps=60, check=False)
    g = torch.Generator().manual_seed(3)
    action = torch.rand(CFG.n_worlds, CFG.n_slots, N_PARAMS, generator=g) * 2 - 1
    orders = random_orders(CFG, g)
    perm = torch.randperm(orders.w.shape[0], generator=g)
    shuffled = Orders(orders.w[perm], orders.c[perm], orders.p[perm], orders.side[perm], orders.qty[perm])
    a, b = state.clone(), state.clone()
    ra = step_batch(a, orders, build_quote(a, params_from_action(action), CFG), CFG)
    rb = step_batch(b, shuffled, build_quote(b, params_from_action(action), CFG), CFG)
    assert torch.equal(ra.fill[perm], rb.fill)
    assert torch.equal(a.cash, b.cash) and torch.equal(a.hold, b.hold)


def _one_coin(cfg: MarketConfig) -> MarketState:
    state = MarketState.empty(cfg)
    state.cash += 10**11
    state.stage[:, 0] = 2
    state.q_tokens[:, 0] = SUPPLY
    state.timer[:, 0] = 1000.0
    return state


def _params(cfg: MarketConfig, **over) -> torch.Tensor:
    base = {"bid_off": 1, "bid_depth": 0.1, "bid_width": 4, "ask_off": 0, "ask_depth": 0.02, "ask_width": 4,
                "cap": 0.02, "fee0": 0.0, "half_life": 10.0, "slope": 0.0}  # fmt: skip
    base.update(over)
    return torch.tensor(list(base.values()), dtype=torch.float32).expand(cfg.n_worlds, cfg.n_slots, N_PARAMS).clone()


def _order(cfg: MarketConfig, person: int, side: int, qty: int) -> Orders:
    K = cfg.window
    curve = torch.full((1, K), qty, dtype=torch.int64)  # any price
    z = torch.zeros(1, dtype=torch.int64)
    return Orders(z, z.clone(), torch.tensor([person]), torch.tensor([side]), curve)


def test_exit_terms_are_locked_at_the_buy():
    """The quoter raising fees after someone bought must not change that position's exit fee."""
    cfg = replace(CFG, n_worlds=1, base_fee_bps=0)
    fees = {}
    for later_fee0 in (0.0, 0.2):
        state = _one_coin(cfg)
        step_batch(state, _order(cfg, 0, BUY, 1_000_000), build_quote(state, _params(cfg, fee0=0.10), cfg), cfg)
        assert int(state.hold[0, 0, 0]) > 0
        state.t += 1
        sell = _order(cfg, 0, SELL, int(state.hold[0, 0, 0]))
        res = step_batch(state, sell, build_quote(state, _params(cfg, fee0=later_fee0), cfg), cfg)
        assert int(res.fill[0]) > 0
        fees[later_fee0] = float(res.fee_rate[0])
    assert fees[0.0] == pytest.approx(fees[0.2])
    assert fees[0.0] == pytest.approx(0.10 * 2 ** (-1 / 10), rel=1e-4)


def test_selling_is_never_blocked_and_fee_is_capped():
    cfg = replace(CFG, n_worlds=1)
    state = _one_coin(cfg)
    step_batch(state, _order(cfg, 0, BUY, 5_000_000), build_quote(state, _params(cfg, fee0=0.2, slope=0.3), cfg), cfg)
    held = int(state.hold[0, 0, 0])
    state.t += 1
    # A tiny cap and maximal fees: the holder can still offer everything.
    quote = build_quote(state, _params(cfg, cap=0.001, fee0=0.2, slope=0.3), cfg)
    res = step_batch(state, _order(cfg, 0, SELL, held), quote, cfg)
    assert int(res.accepted[0].max()) == held
    assert float(res.fee_rate[0]) <= cfg.fee_ceiling + 1e-6
    assert int(res.cash_delta[0]) >= 0


def test_cap_blocks_buys_but_never_forces_a_sale():
    cfg = replace(CFG, n_worlds=1)
    state = _one_coin(cfg)
    step_batch(state, _order(cfg, 0, BUY, 15_000_000), build_quote(state, _params(cfg, ask_depth=0.05), cfg), cfg)
    held = int(state.hold[0, 0, 0])
    assert held > 2_000_000
    state.t += 1
    res = step_batch(state, _order(cfg, 0, BUY, 15_000_000), build_quote(state, _params(cfg, cap=0.001), cfg), cfg)
    assert int(res.accepted[0].max()) == 0
    assert int(state.hold[0, 0, 0]) == held


def test_second_order_for_the_same_coin_is_rejected():
    cfg = replace(CFG, n_worlds=1)
    a, b = _order(cfg, 0, BUY, 1000), _order(cfg, 0, SELL, 1000)
    both = Orders(*(torch.cat([getattr(a, f.name), getattr(b, f.name)]) for f in fields(a)))
    kept = reject_duplicates(both, cfg)
    assert int(kept.qty[0].max()) == 1000 and int(kept.qty[1].max()) == 0


def test_user_to_user_fills_pay_the_same_fee_as_quoter_fills():
    cfg = replace(CFG, n_worlds=1)
    rates = []
    for quoter_bids in (True, False):
        state = _one_coin(cfg)
        state.q_cash[0, 0] = 10**10
        state.cash[0, 0] -= 10**10  # keep total cash fixed; irrelevant to the check
        step_batch(state, _order(cfg, 0, BUY, 1_000_000), build_quote(state, _params(cfg, fee0=0.1), cfg), cfg)
        state.t += 1
        quote = build_quote(state, _params(cfg, fee0=0.1, bid_depth=0.5 if quoter_bids else 0.005), cfg)
        if not quoter_bids:
            quote.bid.zero_()
        sell = _order(cfg, 0, SELL, int(state.hold[0, 0, 0]))
        buy = _order(cfg, 1, BUY, 2_000_000)
        orders = (
            sell
            if quoter_bids
            else Orders(*(torch.cat([getattr(sell, f.name), getattr(buy, f.name)]) for f in fields(sell)))
        )
        res = step_batch(state, orders, quote, cfg)
        assert int(res.fill[0]) > 0
        rates.append(float(res.fee_rate[0]))
    assert rates[0] == pytest.approx(rates[1])
