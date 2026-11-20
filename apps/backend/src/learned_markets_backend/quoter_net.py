"""The exported quoter: a small MLP mapping the public tape to a correction on the fixed rule."""

from __future__ import annotations

import json
from pathlib import Path

import torch
from torch import nn


class QuoterPolicy(nn.Module):
    def __init__(self, n_features: int, n_actions: int, hidden: tuple[int, ...] = (128, 128)):
        super().__init__()
        layers: list[nn.Module] = []
        last = n_features
        for h in hidden:
            layers += [nn.Linear(last, h), nn.Tanh()]
            last = h
        layers.append(nn.Linear(last, n_actions))
        self.net = nn.Sequential(*layers)

    @torch.no_grad()
    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        return self.net(obs).clamp(-1, 1)


def load_policy(path: str | Path) -> QuoterPolicy:
    """Load `quoter.pt` written by `learned_markets_training.export`, with `quoter.json` beside it."""
    path = Path(path)
    meta = json.loads(path.with_suffix(".json").read_text())
    policy = QuoterPolicy(meta["n_features"], meta["n_actions"], tuple(meta["hidden"]))
    policy.net.load_state_dict(torch.load(path, map_location="cpu"))
    return policy.eval()
