"""The off-chain auctioneer: the same market core the simulator trains on, run for one market.

Each batch:
1. `begin_batch` commits the quoter's curve from completed batches only and
   publishes the terms (cap, exit fee schedule) plus a hash of the curve.
2. People submit curve orders (the program's 16-point payload).
3. `clear` runs `core.step_batch`, then the lifecycle, and returns the fills as
   settlement records plus the revealed quoter curve.
"""

from __future__ import annotations

import hashlib

import torch
from learned_markets_core import (
    BUY,
    SELL,
    MarketConfig,
    MarketState,
    Orders,
    Tape,
    build_quote,
    default_lever_values,
    levers_from_values,
    lifecycle_step,
    reject_duplicates,
    residual_params,
    rule_based_params,
    sanitize,
    step_batch,
)
from learned_markets_core.curves import payload_to_window
from learned_markets_core.ledger import check_invariants
from learned_markets_core.records import batch_records
from learned_markets_core.units import prices


class Auctioneer:
    def __init__(self, cfg: MarketConfig | None = None, policy=None):
        """`policy` maps the tape observation [N, F] to actions [N, 10]; None runs the rule-based quoter."""
        self.cfg = cfg or MarketConfig(n_worlds=1, device="cpu")
        assert self.cfg.n_worlds == 1
        self.state = MarketState.empty(self.cfg)
        self.tape = Tape(self.cfg)
        self.policy = policy
        self.lever_values = default_lever_values(self.cfg)
        self.total_cash = self.state.total_cash()
        self.pending: list[tuple[int, int, int, list[tuple[int, int]]]] = []
        self.launch_by: int | None = None
        self.quote = None
        self.commitment = ""

    # -- accounts ------------------------------------------------------------------------

    def credit(self, person: int, lamports: int) -> None:
        """Record a deposit. Stands in for custody until that is decided."""
        self.state.cash[0, person] += lamports
        self.total_cash = self.total_cash + lamports

    def request_launch(self, deployer: int) -> None:
        """Ask for a new coin at the end of this batch (at most one per batch)."""
        self.launch_by = deployer

    # -- one batch -----------------------------------------------------------------------

    def begin_batch(self) -> dict:
        """Commit the quoter's curve for the coming batch and publish the terms."""
        s, cfg = self.state, self.cfg
        if self.policy is None:
            params = rule_based_params(s, self.tape.pressure, cfg, self.tape.idle)
        else:
            obs = self.tape.observation(s, self.lever_values).reshape(cfg.n_groups, -1)
            params = residual_params(s, self.tape.pressure, self.tape.idle, self.policy(obs), cfg)
        self.quote = build_quote(s, params, cfg)
        blob = self.quote.bid.numpy().tobytes() + self.quote.ask.numpy().tobytes()
        self.commitment = hashlib.sha256(blob).hexdigest()
        self.pending = []
        cap = s.cap_tokens(self.quote.cap_share, cfg)
        table = prices()
        return {
            "batch_id": s.t,
            "quoter_commitment": self.commitment,
            "coins": [
                {
                    "slot": c,
                    "coin_id": int(s.coin_id[0, c]),
                    "stage": int(s.stage[0, c]),
                    "last_price": int(table[s.tick[0, c]]),
                    "cap_tokens": int(cap[0, c]),
                    "early_exit_fee": float(self.quote.fee0[0, c]),
                    "hold_half_life_batches": float(self.quote.half_life[0, c]),
                    "size_fee_per_pct_supply": float(self.quote.slope[0, c]),
                }
                for c in range(cfg.n_slots)
                if int(s.stage[0, c]) > 0
            ],
        }

    def submit(self, person: int, slot: int, side: str, points: list[tuple[int, int]]) -> None:
        """Queue a curve order: `points` are (price in micro-lamports per token, cumulative tokens)."""
        if self.quote is None:
            raise RuntimeError("begin_batch must run before orders are accepted")
        self.pending.append((person, slot, BUY if side == "buy" else SELL, points))

    def clear(self) -> dict:
        """Clear and settle the batch, run the lifecycle, and return settlement records."""
        s, cfg = self.state, self.cfg
        K = cfg.window
        n = len(self.pending)
        qty = torch.zeros(n, K, dtype=torch.int64)
        for i, (_, slot, side, points) in enumerate(self.pending):
            qty[i] = payload_to_window(points, side == BUY, int(s.tick[0, slot]), K)
        col = lambda j: torch.tensor([o[j] for o in self.pending], dtype=torch.int64)
        orders = Orders(torch.zeros(n, dtype=torch.int64), col(1), col(0), col(2), qty)
        orders = reject_duplicates(sanitize(orders), cfg)
        live = s.stage > 0
        batch_id = s.t
        res = step_batch(s, orders, self.quote, cfg, exclusive=False)
        records = batch_records(orders, res, cfg, batch_id)
        self.tape.update(live, res, s)
        launch = torch.tensor([self.launch_by is not None])
        deployer = torch.tensor([self.launch_by or 0])
        ev = lifecycle_step(s, res, levers_from_values(self.lever_values), launch, deployer, cfg)
        self.tape.reset(ev.launched | ev.ended)
        self.launch_by = None
        revealed = {"bid": self.quote.bid, "ask": self.quote.ask}
        self.quote = None
        check_invariants(s, cfg, self.total_cash)
        return {
            "batch_id": batch_id,
            "quoter_commitment": self.commitment,
            "records": records,
            "launched_slots": ev.launched[0].nonzero().squeeze(1).tolist(),
            "ended_slots": ev.ended[0].nonzero().squeeze(1).tolist(),
            "revealed_quote": {k: v[v.sum(1) > 0].tolist() for k, v in revealed.items()},
        }

    def snapshot(self) -> dict:
        """Public market state for the interface."""
        s, cfg = self.state, self.cfg
        table = prices()
        return {
            "batch_id": s.t,
            "platform_cash": int(s.platform_cash[0]),
            "coins": [
                {
                    "slot": c,
                    "coin_id": int(s.coin_id[0, c]),
                    "stage": ("empty", "line", "rookie", "regular")[int(s.stage[0, c])],
                    "price": int(table[s.tick[0, c]]),
                    "heat": float(s.heat[0, c]),
                    "timer": float(s.timer[0, c]),
                    "reserve_cash": int(s.q_cash[0, c]),
                    "reserve_tokens": int(s.q_tokens[0, c]),
                }
                for c in range(cfg.n_slots)
                if int(s.stage[0, c]) > 0
            ],
        }

    def balances(self, person: int) -> dict:
        s = self.state
        held = {int(c): int(s.hold[0, c, person]) for c in s.hold[0, :, person].nonzero().squeeze(1)}
        return {"cash": int(s.cash[0, person]), "tokens_by_slot": held}
