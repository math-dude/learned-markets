"""Export a trained quoter for the backend: plain MLP weights plus a small JSON description.

uv run --all-packages python -m learned_markets_training.export /data/eren/learned-markets/checkpoints/quoter-v1/final.zip
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import torch
from learned_markets_core.quoter import PARAM_NAMES
from learned_markets_core.tape import QUOTER_FEATURES
from stable_baselines3 import PPO
from torch import nn


def export(checkpoint: str, out: str | None = None) -> Path:
    model = PPO.load(checkpoint, device="cpu")
    policy = model.policy
    layers = [m for m in policy.mlp_extractor.policy_net] + [policy.action_net]
    net = nn.Sequential(*layers)
    hidden = [m.out_features for m in policy.mlp_extractor.policy_net if isinstance(m, nn.Linear)]
    path = Path(out) if out else Path(checkpoint).with_name("quoter.pt")
    torch.save(net.state_dict(), path)
    path.with_suffix(".json").write_text(json.dumps({
        "n_features": len(QUOTER_FEATURES), "n_actions": len(PARAM_NAMES), "hidden": hidden,
        "features": QUOTER_FEATURES, "actions": PARAM_NAMES,
        "action_meaning": "correction in [-1, 1] added to the rule-based quoter's action (core.residual_params)",
        "source": str(checkpoint),
    }, indent=1))  # fmt: skip
    return path


if __name__ == "__main__":
    print(export(*sys.argv[1:3]))
