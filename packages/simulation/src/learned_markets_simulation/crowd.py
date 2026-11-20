"""The simulated crowd: a finite set of people with limited attention.

Each batch an awake person looks at one coin and sends one curve order. A
person holds a noisy private view of the coin's true value and wants a
position that grows as the price falls below that view. Fees shape the curve:
the exit fee a holder would pay now makes them slower to sell, and the fee
expected at their holding horizon makes them slower to buy.

People see completed batches and the published terms only: never the quoter's
curve or anyone else's order.
"""

from __future__ import annotations

import math

import torch
from learned_markets_core import BUY, SELL, MarketConfig, MarketState, Orders, Quote
from learned_markets_core.ledger import exit_fee_rate
from learned_markets_core.quoter import window_prices
from learned_markets_core.units import BPS, PRICE_SCALE, prices

from .attackers import Attackers
from .memes import Memes
from .params import A_PICKER, INFORMED, NOISE, RETAIL, SimConfig


class Crowd:
    def __init__(self, cfg: MarketConfig, sim: SimConfig, gen: torch.Generator):
        self.cfg, self.sim, self.gen = cfg, sim, gen
        W, C, P, dev = cfg.n_worlds, cfg.n_slots, cfg.n_people, cfg.device
        self.dev = dev
        u = lambda *s: torch.rand(*s, device=dev, generator=gen)
        span = lambda r, x: r[0] + (r[1] - r[0]) * x
        logspan = lambda r, x: torch.exp(math.log(r[0]) + (math.log(r[1]) - math.log(r[0])) * x)

        draw = u(W, P)
        self.kind = torch.full((W, P), RETAIL, dtype=torch.int64, device=dev)
        self.kind[draw < sim.share_noise] = NOISE
        self.kind[draw > 1 - sim.share_informed] = INFORMED
        self.act = logspan(sim.act_rate, u(W, P))
        self.risk = span(sim.risk_share, u(W, P))
        self.width = span(sim.width, u(W, P))
        self.horizon = logspan(sim.horizon, u(W, P))
        self.sd = torch.tensor(sim.signal_sd, device=dev)[self.kind]
        self.beta = torch.tensor(sim.momentum, device=dev)[self.kind] * u(W, P)
        self.elasticity = logspan(sim.fee_elasticity, u(W, 1))
        self.burden = torch.zeros(W, P, device=dev)
        self.cap_annoyance = span(sim.cap_annoyance, u(W, 1))
        self.eps = torch.randn(W, C, P, device=dev, generator=gen) * self.sd.unsqueeze(1)
        self.vis = torch.tensor(sim.visibility, device=dev)

        self.attackers = Attackers(W, sim, dev, gen)
        A = sim.n_attacker_seats
        picker = self.attackers.script == A_PICKER
        # The stale-quote picker is a perfectly informed, always-awake person with a tight curve.
        self.kind[:, :A] = torch.where(picker, INFORMED, self.kind[:, :A])
        self.sd[:, :A] = torch.where(picker, 0.0, self.sd[:, :A])
        self.act[:, :A] = torch.where(picker, 1.0, self.act[:, :A])
        self.risk[:, :A] = torch.where(picker, 0.9, self.risk[:, :A])
        self.width[:, :A] = torch.where(picker, 0.05, self.width[:, :A])
        self.eps[:, :, :A] = torch.where(picker.unsqueeze(1), 0.0, self.eps[:, :, :A])

        self.launch_x = math.log(float(prices()[cfg.launch_tick]))
        self.w_idx = torch.arange(W, device=dev).repeat_interleave(P)
        self.p_idx = torch.arange(P, device=dev).repeat(W)

    def initial_cash(self) -> torch.Tensor:
        W, P = self.cfg.n_worlds, self.cfg.n_people
        z = torch.randn(W, P, device=self.dev, generator=self.gen)
        cash = (self.sim.cash_median_lamports * torch.exp(self.sim.cash_sigma * z)).clamp(1e8, 2e11).long()
        A = self.sim.n_attacker_seats
        cash[:, :A] = torch.where(self.attackers.script > 0, 50_000_000_000, cash[:, :A])
        self.endowment = cash.clone()
        self.cum_topup = torch.zeros_like(cash)
        return cash

    def reset_slots(self, launched: torch.Tensor) -> None:
        """Fresh private errors about newly launched coins."""
        if not bool(launched.any()):
            return
        W, C, P = self.eps.shape
        fresh = torch.randn(W, C, P, device=self.dev, generator=self.gen) * self.sd.unsqueeze(1)
        self.eps = torch.where(launched.unsqueeze(2), fresh, self.eps)

    def orders(self, state: MarketState, quote: Quote, memes: Memes, ret_ema: torch.Tensor) -> Orders:
        """One order per awake person. Uses published terms from `quote`, never its curves.

        Only people who act this batch get a row, so the returned orders have a
        varying length. Random draws are still made for everyone, which keeps
        the random stream independent of who is awake.
        """
        cfg, sim = self.cfg, self.sim
        W, C, P, K = cfg.n_worlds, cfg.n_slots, cfg.n_people, cfg.window
        dev, gen = self.dev, self.gen
        N, c0 = W * P, K // 2
        base = cfg.base_fee_bps / BPS

        # Private errors drift slowly.
        rho = sim.signal_rho
        self.eps = rho * self.eps + math.sqrt(1 - rho * rho) * self.sd.unsqueeze(1) * torch.randn(
            W, C, P, device=dev, generator=gen
        )

        # Attention: one coin per awake person, drawn by visibility, heat and own holdings.
        live = state.stage > 0
        pop = self.vis[state.stage] * (1 + state.heat) ** sim.heat_power
        weight = pop.unsqueeze(1) * (1 + sim.hold_boost * (state.hold.transpose(1, 2) > 0))
        gumbel = -torch.log(-torch.log(torch.rand(W, P, C, device=dev, generator=gen).clamp(1e-9, 1 - 1e-9)))
        coin = (torch.log(weight + 1e-12) + gumbel).argmax(2)
        participation = torch.exp(-self.elasticity * self.burden)
        awake = torch.rand(W, P, device=dev, generator=gen) < self.act * participation
        awake &= live.gather(1, coin)

        # Scripted attacker seats always get a row; the script decides whether they act.
        A = sim.n_attacker_seats
        at = self.attackers
        keep = awake.clone()
        keep[:, :A] |= at.scripted
        idx = keep.reshape(N).nonzero().squeeze(1)
        sel = lambda x: x.reshape(N)[idx]
        awake_rows = sel(awake)
        w, p, c = self.w_idx[idx], self.p_idx[idx], sel(coin)
        g = w * C + c
        hp = g * P + p
        price_gk, _ = window_prices(state.tick, cfg)
        x = torch.log(price_gk.float())[g]  # [N, K] log price at each window tick
        launch_x = self.launch_x
        x0 = x[:, c0]

        kind = sel(self.kind)
        value = torch.where(kind == INFORMED, memes.log_value.reshape(-1)[g], memes.slow.reshape(-1)[g]) + launch_x
        view = value + self.eps.reshape(-1)[hp]
        # Noise traders have no view of value: they anchor on the last price.
        view = torch.where(kind == NOISE, x0 + self.eps.reshape(-1)[hp] * 0.3, view)
        view = view + sel(self.beta) * ret_ema.reshape(-1)[g]

        hold = state.hold.reshape(-1)[hp]
        cash = sel(state.cash)
        px0 = price_gk[g, c0].float()
        wealth = cash.float() + hold.float() * px0 / PRICE_SCALE
        budget = sel(self.risk) * wealth  # lamports this person will put in this coin
        width = sel(self.width).unsqueeze(1)

        zeros = torch.zeros(cfg.n_groups, dtype=torch.bool, device=dev)
        exit_now = exit_fee_rate(state, hp, g, hold // 2, quote.slope.reshape(-1), zeros, cfg)
        horizon = sel(self.horizon)
        expected_exit = (
            base
            + quote.fee0.reshape(-1)[g] * torch.pow(2.0, -horizon / quote.half_life.reshape(-1)[g])
            + quote.slope.reshape(-1)[g] * 0.2
        ).clamp(max=cfg.fee_ceiling)

        tokens_per_lamport = PRICE_SCALE / price_gk[g].float()  # [N, K]
        want = lambda edge: budget.unsqueeze(1) * tokens_per_lamport * (edge / width).clamp(0, 1)
        target_buy = want(view.unsqueeze(1) - x - (base + expected_exit).unsqueeze(1))
        target_sell = want(view.unsqueeze(1) - x + exit_now.unsqueeze(1))
        holdf = hold.float().unsqueeze(1)
        buy_q = (target_buy - holdf).clamp(min=0)
        sell_q = (holdf - target_sell).clamp(min=0).minimum(holdf)

        is_buy = (buy_q[:, c0] > 0) | (hold == 0)
        # Some holders take profit or need cash regardless of their view.
        liq = (torch.rand(N, device=dev, generator=gen)[idx] < sim.liquidity_sell) & (hold > 0)
        frac = torch.rand(N, device=dev, generator=gen)[idx]
        k = torch.arange(K, device=dev)
        liq_q = torch.where(k.unsqueeze(0) >= c0 - 2, (holdf * frac.unsqueeze(1)), torch.zeros_like(holdf))
        sell_q = torch.where(liq.unsqueeze(1), torch.maximum(sell_q, liq_q), sell_q)
        is_buy &= ~liq

        qty = torch.where(is_buy.unsqueeze(1), buy_q, sell_q)
        qty = torch.where(awake_rows.unsqueeze(1), qty, torch.zeros_like(qty)).long()
        side = torch.where(is_buy, BUY, SELL)

        # Scripted attackers replace their seats' orders.
        a_coin, a_buy, a_qty = at.orders(
            state.stage, state.coin_id, state.birth, state.heat, state.hold[:, :, :A], state.t
        )
        rows = (torch.arange(W, device=dev).unsqueeze(1) * P + torch.arange(A, device=dev)).reshape(-1)
        scripted = at.scripted.reshape(-1)
        pos = torch.full((N,), -1, dtype=torch.int64, device=dev)
        pos[idx] = torch.arange(idx.shape[0], device=dev)
        rows_s = pos[rows[scripted]]
        c[rows_s] = a_coin.reshape(-1)[scripted]
        side[rows_s] = torch.where(a_buy.reshape(-1)[scripted], BUY, SELL)
        qty[rows_s] = a_qty.reshape(-1)[scripted].unsqueeze(1).expand(-1, K)

        return Orders(w, c, p, side, qty)

    def after(self, orders: Orders, result) -> None:
        """Update each person's fee and cap burden, which lowers their participation."""
        cfg = self.cfg
        P, K = cfg.n_people, cfg.window
        base = cfg.base_fee_bps / BPS
        sold = (orders.side == SELL) & (result.fill > 0)
        fee_pain = torch.where(sold, (result.fee_rate - base).clamp(min=0), torch.zeros_like(result.fee_rate))
        asked = orders.qty[:, K // 2]
        got = result.accepted[:, K // 2]
        blocked = (orders.side == BUY) & (asked > 0) & (got * 2 < asked)
        pain = fee_pain + self.cap_annoyance.expand(-1, P)[orders.w, orders.p] * blocked.float()
        self.burden = self.burden * 0.99
        self.burden.reshape(-1).index_add_(0, orders.w * P + orders.p, pain)

    def topup(self, state: MarketState, wealth: torch.Tensor) -> torch.Tensor:
        """New money arrives from outside. Returns lamports added, [W].

        A person whose wealth has fallen below what they started with is refilled
        toward it at `income_rate` per batch. Without this the crowd's money drains
        into reserves and dead coins and the world shrinks over a long run.
        """
        short = (self.endowment.double() - wealth).clamp(min=0)
        amount = (short * self.sim.income_rate).long()
        state.cash += amount
        self.cum_topup += amount
        return amount.sum(1)
