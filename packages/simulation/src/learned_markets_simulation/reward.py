"""The shared reward: distinct people trading, weighted by how right the price is.

There is no profit term. A person counts only if their fill is above the dust
size (the market core applies that threshold), so tiny fills cannot farm it.
"""

from __future__ import annotations

import torch

from .params import SimConfig


def batch_reward(
    traders: torch.Tensor,
    closeness: torch.Tensor,
    live: torch.Tensor,
    n_people: int,
    sim: SimConfig,
) -> torch.Tensor:
    """Per-coin reward for one batch, [W, C].

    traders: distinct people with a counted fill; closeness: exp(-|log(price /
    true value)| / scale). Normalized so 1.0 means `reward_norm` of the crowd
    traded this coin exactly at its true value.
    """
    r = traders.float() * closeness / (n_people * sim.reward_norm)
    return torch.where(live, r, torch.zeros_like(r))


def gap_penalty(ret: torch.Tensor, live: torch.Tensor, sim: SimConfig) -> torch.Tensor:
    """Smoothness charge per coin for one batch, [W, C]: weight x the move beyond the free band."""
    excess = (ret.abs() - sim.gap_free).clamp(min=0.0)
    return torch.where(live, sim.gap_weight * excess, torch.zeros_like(excess))


def platform_reward(reward: torch.Tensor) -> torch.Tensor:
    """The auction network's reward, [W]: the sum over coins.

    A person sends one order per batch, so each is counted once across the platform.
    """
    return reward.sum(1)
