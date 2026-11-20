"""Hidden true value of each meme, and meme arrivals.

Log value = a base level + attention + a small random walk. Attention arrives
in bursts that rise quickly and decay. A regime is a draw of burst size, burst
rate, decay time and noise; it is hidden from every agent. A real pump is the
true value jumping; a manipulation is price leaving the true value.
"""

from __future__ import annotations

import math

import torch

from .params import REGIME_TABLE, SimConfig


class Memes:
    def __init__(self, n_worlds: int, n_slots: int, sim: SimConfig, device: str, gen: torch.Generator):
        self.W, self.C, self.sim, self.dev, self.gen = n_worlds, n_slots, sim, device, gen
        z = lambda: torch.zeros(n_worlds, n_slots, device=device)
        self.regime = torch.zeros(n_worlds, n_slots, dtype=torch.int64, device=device)
        self.base, self.att, self.pending, self.walk = z(), z(), z(), z()
        self.tau, self.rise = z() + 100.0, z() + 30.0
        self.table = torch.tensor(REGIME_TABLE, device=device)
        lo, hi = sim.reflexivity
        self.reflex = lo + (hi - lo) * self._rand(n_worlds, 1)
        lo, hi = sim.deployer_fee_scale
        self.fee_scale = torch.exp(math.log(lo) + (math.log(hi) - math.log(lo)) * self._rand(n_worlds))
        # Retail's lagged view of value.
        self.slow = z()

    def _rand(self, *shape):
        return torch.rand(*shape, device=self.dev, generator=self.gen)

    def _randn(self, *shape):
        return torch.randn(*shape, device=self.dev, generator=self.gen)

    @property
    def log_value(self) -> torch.Tensor:
        """Log of fair price relative to the launch price, [W, C]."""
        return self.base + self.att + self.walk

    def reset(self, launched: torch.Tensor) -> None:
        """Draw a regime and its parameters for newly launched slots."""
        if not bool(launched.any()):
            return
        # Draws are full-shape so the random stream does not depend on how many launched.
        W, C = self.W, self.C
        pick = torch.multinomial(self.table[:, 0], W * C, replacement=True, generator=self.gen).reshape(W, C)
        row = self.table[pick]
        z = [self._randn(W, C) for _ in range(4)]
        put = lambda old, new: torch.where(launched, new, old)
        self.regime = put(self.regime, pick)
        self.base = put(self.base, row[..., 1] + row[..., 2] * z[0])
        self.att = put(self.att, row[..., 3] * torch.exp(0.3 * z[1]))
        self.pending = put(self.pending, row[..., 4] * torch.exp(0.5 * z[2]))
        self.walk = put(self.walk, torch.zeros_like(self.walk))
        spread = torch.exp(self.sim.tau_sigma * z[3])
        self.tau = put(self.tau, (row[..., 8] * spread * self.sim.half_life_scale).clamp(min=5.0))
        self.rise = put(self.rise, row[..., 9])
        self.slow = put(self.slow, self.base + self.att)

    def step(self, live: torch.Tensor, ret: torch.Tensor) -> None:
        """Advance one batch. `ret` is this batch's log return of the price, [W, C]."""
        row = self.table[self.regime]
        burst = (self._rand(self.W, self.C) < row[..., 5]) & live
        size = (row[..., 6] + row[..., 7] * self._randn(self.W, self.C)).clamp(min=0.0)
        self.pending = self.pending + torch.where(burst, size, torch.zeros_like(size))
        # A rise time of one batch means the news lands at once.
        release = self.pending * (1 - torch.exp(-1 / self.rise.clamp(min=0.2)))
        self.pending = self.pending - release
        self.att = self.att * torch.exp(-1 / self.tau) + release + self.reflex * ret.clamp(-0.2, 0.2)
        # Attention saturates: the crowd is finite, so a meme's value cannot grow without bound.
        self.att = self.att.clamp(min=0.0, max=self.sim.attention_max)
        # The residual drifts but reverts, so it stays a small part of value over a long life.
        self.walk = self.walk * (1 - 1 / self.sim.walk_reversion) + row[..., 10] * self._randn(self.W, self.C)
        lag = self.sim.retail_lag
        self.slow = self.slow + (self.log_value - self.slow) / lag

    def launch_requests(self, launch_fee: torch.Tensor) -> torch.Tensor:
        """Which worlds see a launch attempt this batch. Deployers launch less as the fee rises."""
        p = self.sim.launch_rate * torch.exp(-launch_fee.float() / self.fee_scale)
        return self._rand(self.W) < p
