"""The whole environment under each quoter: ledger invariants, sealed orders, determinism."""

from __future__ import annotations

from dataclasses import replace

import pytest
import torch
from learned_markets_core import MarketConfig
from learned_markets_core.quoter import N_PARAMS
from learned_markets_simulation.params import ATTACKERS, SimConfig
from learned_markets_simulation.world import World

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
CFG = MarketConfig(n_worlds=6, n_slots=10, n_people=96, window=64, device=DEVICE,
                   cut_round=20, grace=30, epoch=40, graduation_activity=60.0, timer_init=40.0)  # fmt: skip
# Every attacker seat active so each script runs somewhere.
SIM = SimConfig(attacker_rate=1.0, launch_rate=0.2)


def _cfg(kind: str) -> MarketConfig:
    return replace(CFG, hard_cap_share=1.0, line_cap_share=1.0) if kind in ("curve", "pump") else CFG


@pytest.mark.parametrize("kind", ["rule", "curve", "pump", "params"])
def test_invariants_hold_for_every_market(kind):
    world = World(_cfg(kind), SIM, seed=4, quoter=kind, check=True)
    g = torch.Generator(device=DEVICE).manual_seed(0)
    volume = ended = 0
    for _ in range(300):
        params = None
        if kind == "params":
            # A random quoter is the fuzzer: any action must leave the ledger consistent.
            from learned_markets_core import params_from_action

            a = torch.rand(CFG.n_worlds, CFG.n_slots, N_PARAMS, device=DEVICE, generator=g) * 2 - 1
            params = params_from_action(a)
        out = world.step(params)
        volume += int(out.result.volume.sum())
        ended += int(out.events.ended.sum())
    assert volume > 0 and ended > 0


@pytest.mark.parametrize("script", range(1, len(ATTACKERS)))
def test_each_attacker_script_runs_within_the_rules(script):
    sim = replace(SIM, attacker_script=script, n_attacker_seats=2)
    world = World(CFG, sim, seed=script, quoter="rule", check=True)
    acted = 0
    for _ in range(250):
        out = world.step()
        seats = out.orders.p < 2
        acted += int((out.result.fill[seats] > 0).sum())
    assert acted > 0, f"{ATTACKERS[script]} never traded"


def test_orders_do_not_depend_on_the_quoters_curve():
    """Sealed batch: people see published terms, never the quoter's bid or ask."""
    a = World(CFG, SIM, seed=9, quoter="rule")
    b = World(CFG, SIM, seed=9, quoter="rule")
    for _ in range(30):
        a.step()
        b.step()
    qa, qb = a.quote(None), b.quote(None)
    qb.bid.zero_()
    qb.ask.zero_()
    oa = a.crowd.orders(a.state, qa, a.memes, a.tape.ret_fast)
    ob = b.crowd.orders(b.state, qb, b.memes, b.tape.ret_fast)
    assert torch.equal(oa.qty, ob.qty) and torch.equal(oa.c, ob.c) and torch.equal(oa.side, ob.side)


def test_same_seed_same_world():
    a = World(CFG, SIM, seed=2, quoter="rule")
    b = World(CFG, SIM, seed=2, quoter="rule")
    for _ in range(80):
        a.step()
        b.step()
    assert torch.equal(a.state.cash, b.state.cash) and torch.equal(a.state.hold, b.state.hold)
    assert torch.equal(a.state.tick, b.state.tick)
