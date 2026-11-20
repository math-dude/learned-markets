"""The public tape: per-coin statistics of completed batches, and the quoter's observation.

Everything here is built from completed batches and the quoter's own balances,
so it is what the quoter may use when it commits its curve for the next batch.
It never contains the current batch's orders, anything about one person, or a
meme's true value. The simulator and the backend both keep a `Tape`, so the
trained quoter sees the same observation in training and in production.
"""

from __future__ import annotations

import math

import torch

from .market import BatchResult
from .state import LINE, REGULAR, ROOKIE, MarketConfig, MarketState
from .units import SUPPLY, prices

QUOTER_FEATURES = (
    "live", "is_line", "is_rookie", "is_regular", "age", "in_grace",
    "ret_fast", "ret_slow", "volatility", "log_price",
    "imbalance", "imbalance_fast", "imbalance_slow", "pressure", "idle",
    "traders", "traders_ema", "excess_demand", "excess_supply", "turnover",
    "quoter_tokens", "safe_bucket", "top10_share",
    "heat", "heat_rank", "timer", "activity", "to_cut", "to_epoch",
    "line_fullness", "live_coins", "launch_fee",
)  # fmt: skip
N_QUOTER_FEATURES = len(QUOTER_FEATURES)

_SERIES = ("ret_fast", "ret_slow", "vol_ema", "imb_fast", "imb_slow", "traders_ema", "imbalance",
           "excess_d", "excess_s", "turnover", "pressure", "top10", "idle")  # fmt: skip


class Tape:
    def __init__(self, cfg: MarketConfig):
        self.cfg = cfg
        W, C, dev = cfg.n_worlds, cfg.n_slots, cfg.device
        self.launch_x = math.log(float(prices()[cfg.launch_tick]))
        self.logp = torch.full((W, C), self.launch_x, device=dev)
        for name in _SERIES:
            setattr(self, name, torch.zeros(W, C, device=dev))
        self.traders_last = torch.zeros(W, C, dtype=torch.int64, device=dev)

    def update(self, live_before: torch.Tensor, res: BatchResult, state: MarketState) -> torch.Tensor:
        """Fold one cleared batch into the tape. Returns this batch's log return, [W, C]."""
        logp = torch.log(prices(state.tick.device)[state.tick].float())
        traded = live_before & (res.volume > 0)
        ret = torch.where(traded, logp - self.logp, torch.zeros_like(logp))
        self.logp = logp
        ub, us = res.user_buy.float(), res.user_sell.float()
        self.imbalance = (ub - us) / (ub + us + 1.0)
        ema = lambda old, new, a: old + a * (new - old)
        self.ret_fast = ema(self.ret_fast, ret, 0.3)
        self.ret_slow = ema(self.ret_slow, ret, 0.03)
        self.vol_ema = ema(self.vol_ema, ret.abs(), 0.05)
        self.imb_fast = ema(self.imb_fast, self.imbalance, 0.3)
        self.imb_slow = ema(self.imb_slow, self.imbalance, 0.03)
        self.traders_ema = ema(self.traders_ema, res.traders.float(), 0.1)
        ed, es, vol = res.excess_demand.float(), res.excess_supply.float(), res.volume.float()
        self.excess_d, self.excess_s, self.turnover = ed / SUPPLY, es / SUPPLY, vol / SUPPLY
        self.traders_last = res.traders
        # Unfilled demand minus unfilled supply, as a share of what was offered.
        self.pressure = (ed - es) / (ed + es + vol + 1.0)
        # Batches in a row with nothing traded: the last price is going stale.
        self.idle = torch.where(res.volume > 0, torch.zeros_like(self.idle), self.idle + 1.0)
        if state.t % 10 == 0:
            self.top10 = state.hold.topk(min(10, self.cfg.n_people), dim=2).values.sum(2).float() / SUPPLY
        return ret

    def reset(self, mask: torch.Tensor) -> None:
        """Clear the tape for slots whose coin ended or was just launched."""
        if not bool(mask.any()):
            return
        self.logp = torch.where(mask, self.launch_x, self.logp)
        for name in _SERIES:
            setattr(self, name, getattr(self, name).masked_fill(mask, 0.0))
        self.traders_last = self.traders_last.masked_fill(mask, 0)

    def observation(self, state: MarketState, lever_values: torch.Tensor) -> torch.Tensor:
        """The quoter's observation, [W, C, F] float32, scaled by construction."""
        s, cfg = state, self.cfg
        W, C = cfg.n_worlds, cfg.n_slots
        dev = s.stage.device
        live = s.stage > 0
        f = lambda x: x.float()
        age = f(s.t - s.birth)
        in_line = s.stage == LINE
        # Share of line coins colder than this one: 0 means next to be cut.
        heat_line = torch.where(in_line, s.heat, torch.full_like(s.heat, float("inf")))
        colder = (heat_line.unsqueeze(2) > heat_line.unsqueeze(1)).sum(2).float()
        n_line = in_line.sum(1, keepdim=True).float()
        heat_rank = torch.where(in_line, colder / n_line.clamp(min=1), torch.ones_like(s.heat))
        timer_cap = lever_values[:, 5:6]
        cols = [
            f(live), f(in_line), f(s.stage == ROOKIE), f(s.stage == REGULAR),
            (age / 2000).clamp(max=1.5), f(age < cfg.grace),
            (self.ret_fast * 10).clamp(-3, 3), (self.ret_slow * 30).clamp(-3, 3), (self.vol_ema * 20).clamp(max=3),
            ((self.logp - self.launch_x) / 3).clamp(-2, 2),
            self.imbalance, self.imb_fast, self.imb_slow, self.pressure, (self.idle / 20).clamp(max=2),
            torch.log1p(f(self.traders_last)) / 3, torch.log1p(self.traders_ema) / 3,
            (self.excess_d * 100).clamp(max=3), (self.excess_s * 100).clamp(max=3), (self.turnover * 100).clamp(max=3),
            f(s.q_tokens) / SUPPLY, torch.log1p(f(s.q_cash) / 1e9) / 5, (self.top10 * 5).clamp(max=3),
            torch.log1p(s.heat) / 6, heat_rank, (s.timer / timer_cap).clamp(-1, 1),
            (s.activity / cfg.graduation_activity).clamp(max=2),
            torch.full((W, C), 1 - (s.t % cfg.cut_round) / cfg.cut_round, device=dev),
            torch.full((W, C), 1 - (s.t % cfg.epoch) / cfg.epoch, device=dev),
            (n_line / lever_values[:, 1:2]).clamp(max=1.5).expand(W, C),
            (live.sum(1, keepdim=True).float() / C).expand(W, C),
            (torch.log(lever_values[:, 0:1].clamp(min=1e6) / 1e9) / 5).expand(W, C),
        ]  # fmt: skip
        obs = torch.stack(cols, dim=2)
        return torch.where(live.unsqueeze(2), obs, torch.zeros_like(obs))
