"""The environment: memes, a crowd and the market core, stepped one batch at a time.

One `World` holds many independent worlds, each with a line and seats of coins
competing for the same finite crowd. Every coin slot can be driven by the same
learned quoter, the rule-based stand-in or the pump bonding-curve baseline.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from learned_markets_core import (
    LINE,
    BatchResult,
    LifecycleEvents,
    MarketConfig,
    MarketState,
    Orders,
    Quote,
    bonding_curve_quote,
    build_quote,
    check_invariants,
    levers_from_values,
    lifecycle_step,
    rule_based_params,
    standin_lever_values,
    step_batch,
)
from learned_markets_core.ledger import open_coin
from learned_markets_core.tape import Tape
from learned_markets_core.units import prices

from .crowd import Crowd
from .memes import Memes
from .params import SimConfig
from .reward import batch_reward


@dataclass
class StepOut:
    reward: torch.Tensor  # [W, C] per-coin reward for this batch
    closeness: torch.Tensor  # [W, C] exp(-|log(price / true value)| / scale)
    result: BatchResult
    events: LifecycleEvents
    orders: object


class World:
    def __init__(
        self,
        cfg: MarketConfig,
        sim: SimConfig | None = None,
        seed: int = 0,
        quoter: str = "params",
        initial_coins: int = 6,
        check: bool = False,
    ):
        """`quoter` is "params" (the caller supplies parameters), "rule", "curve" or "pump".

        "curve" puts pump's bonding curve inside the batch auction. "pump" is the
        passive baseline as it exists today: the same curve, but orders execute
        one after another and scripted bots go first.
        """
        self.cfg, self.sim, self.quoter, self.check = cfg, sim or SimConfig(), quoter, check
        W, C, dev = cfg.n_worlds, cfg.n_slots, cfg.device
        self.dev = dev
        gen = lambda s: torch.Generator(device=dev).manual_seed(s)
        self.meme_gen, self.crowd_gen = gen(seed * 2 + 1), gen(seed * 2 + 2)
        self.state = MarketState.empty(cfg)
        self.memes = Memes(W, C, self.sim, dev, self.meme_gen)
        self.crowd = Crowd(cfg, self.sim, self.crowd_gen)
        self.state.cash = self.crowd.initial_cash()
        self.tape = Tape(cfg)
        self.launch_x = self.tape.launch_x
        self.lever_values = standin_lever_values(self.state, cfg)

        # Seed the line so the first batch has something to trade.
        zero = torch.zeros(W, dtype=torch.int64, device=dev)
        every = torch.ones(W, dtype=torch.bool, device=dev)
        seeded = torch.zeros(W, C, dtype=torch.bool, device=dev)
        for slot in range(initial_coins):
            open_coin(self.state, cfg, every, zero + slot, zero, zero, LINE)
            seeded[:, slot] = True
        self.memes.reset(seeded)
        self.total_cash = self.state.total_cash()

    # -- public state every agent may see ------------------------------------------------

    def quote(self, params: torch.Tensor | None) -> Quote:
        if self.quoter in ("curve", "pump"):
            return bonding_curve_quote(self.state, self.cfg)
        if self.quoter == "rule" or params is None:
            params = rule_based_params(self.state, self.tape.pressure, self.cfg, self.tape.idle)
        return build_quote(self.state, params, self.cfg)

    def true_log_price(self) -> torch.Tensor:
        """Hidden. Log of the fair price in micro-lamports per token."""
        return self.memes.log_value + self.launch_x

    # -- one batch -----------------------------------------------------------------------

    def step(self, params: torch.Tensor | None = None, lever_values: torch.Tensor | None = None) -> StepOut:
        cfg, sim, s = self.cfg, self.sim, self.state
        live = s.stage > 0
        # The quote is fixed from the previous batch's state, before any order exists.
        quote = self.quote(params)
        orders = self.crowd.orders(s, quote, self.memes, self.tape.ret_fast)
        res = self._sequential(orders) if self.quoter == "pump" else step_batch(s, orders, quote, cfg)
        self.crowd.after(orders, res)

        ret = self.tape.update(live, res, s)
        closeness = torch.exp(-(self.tape.logp - self.true_log_price()).abs() / sim.closeness_scale)
        reward = batch_reward(res.traders, closeness, live, cfg.n_people, sim)

        self.memes.step(live, ret)
        self.lever_values = standin_lever_values(s, cfg) if lever_values is None else lever_values
        levers = levers_from_values(self.lever_values)
        launch = self.memes.launch_requests(levers.launch_fee)
        deployer = torch.randint(0, cfg.n_people, (cfg.n_worlds,), device=self.dev, generator=self.crowd_gen)
        ev = lifecycle_step(s, res, levers, launch, deployer, cfg)
        self.tape.reset(ev.launched | ev.ended)
        self.memes.reset(ev.launched)
        self.crowd.reset_slots(ev.launched)
        self.total_cash = self.total_cash + self.crowd.topup(s, self.wealth())
        if self.check:
            check_invariants(s, cfg, self.total_cash)
        return StepOut(reward=reward, closeness=closeness, result=res, events=ev, orders=orders)

    def _sequential(self, orders, rounds: int = 8) -> BatchResult:
        """Baseline only: execute orders in random order against the curve, not as one batch.

        Orders are spread over `rounds` passes; each pass re-reads the curve, so
        earlier orders get better prices. Scripted attackers always go in the
        first pass, which is the speed advantage bots have on pump.
        """
        cfg, s = self.cfg, self.state
        N = orders.p.shape[0]
        turn = torch.randint(1, rounds, (N,), device=self.dev, generator=self.crowd_gen)
        A = self.sim.n_attacker_seats
        seat = orders.p < A
        scripted = seat & self.crowd.attackers.scripted[orders.w, orders.p.clamp(max=A - 1)]
        turn = torch.where(scripted, 0, turn)
        merged = None
        for r in range(rounds):
            part = Orders(
                orders.w, orders.c, orders.p, orders.side, torch.where((turn == r).unsqueeze(1), orders.qty, 0)
            )
            res = step_batch(s, part, bonding_curve_quote(s, cfg), cfg)
            if merged is None:
                merged = res
                continue
            for name in (
                "volume",
                "traders",
                "user_buy",
                "user_sell",
                "q_buy",
                "q_sell",
                "fees",
                "fill",
                "cash_delta",
                "fee",
            ):
                setattr(merged, name, getattr(merged, name) + getattr(res, name))
            merged.settlement.notional = merged.settlement.notional + res.settlement.notional
            merged.fee_rate = torch.maximum(merged.fee_rate, res.fee_rate)
            merged.counted = merged.counted | res.counted
            merged.accepted = torch.maximum(merged.accepted, res.accepted)
            merged.at_edge = merged.at_edge | res.at_edge
            merged.excess_demand, merged.excess_supply = res.excess_demand, res.excess_supply
            merged.price = torch.where(res.volume > 0, res.price, merged.price)
        merged.tick = s.tick
        return merged

    def wealth(self) -> torch.Tensor:
        """Each person's cash plus holdings at the last clearing price, [W, P] lamports."""
        px = prices(self.dev)[self.state.tick].double() / 1_000_000
        return self.state.cash.double() + (self.state.hold.double() * px.unsqueeze(2)).sum(1)
