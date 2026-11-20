"""Shared training helpers: output locations, policy loading, quick comparisons."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import torch
from learned_markets_core import MarketConfig, residual_params
from learned_markets_simulation.params import SimConfig, load_calibration
from learned_markets_simulation.world import World
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback

from .features import quoter_features

OUT = Path(os.environ.get("LM_OUT", "/data/eren/learned-markets"))
POLICY_KWARGS = {"net_arch": {"pi": [128, 128], "vf": [128, 128]}, "log_std_init": -1.6}


def sim_config(**over) -> SimConfig:
    sim, _ = load_calibration()
    return replace(sim, **over) if over else sim


def market_config(n_worlds: int, device: str = "cuda", baseline: bool = False) -> MarketConfig:
    cfg = MarketConfig(n_worlds=n_worlds, device=device)
    # pump has no holding caps; the baseline runs with them switched off.
    return replace(cfg, hard_cap_share=1.0, line_cap_share=1.0) if baseline else cfg


def policy_fn(model: PPO, deterministic: bool = True) -> Callable[[torch.Tensor], torch.Tensor]:
    """Observations [N, F] on the model's device -> actions [N, A] in [-1, 1]."""
    policy = model.policy
    policy.set_training_mode(False)

    def act(obs: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            return policy._predict(obs, deterministic=deterministic).clamp(-1, 1)

    return act


def quoter_params(world: World, act: Callable | None) -> torch.Tensor | None:
    if act is None:
        return None
    obs = quoter_features(world).reshape(world.cfg.n_groups, -1)
    return residual_params(world.state, world.tape.pressure, world.tape.idle, act(obs), world.cfg)


def quick_compare(act: Callable | None, kind: str, seed: int, n_worlds: int, steps: int, sim: SimConfig) -> dict:
    """Mean platform reward, closeness and traders for one market on one seed."""
    cfg = market_config(n_worlds, baseline=(kind == "curve"))
    world = World(cfg, sim, seed=seed, quoter={"learned": "params"}.get(kind, kind))
    reward = closeness = traders = 0.0
    for _ in range(steps):
        out = world.step(quoter_params(world, act) if kind == "learned" else None)
        live = world.state.stage > 0
        reward += float(out.reward.sum(1).mean())
        closeness += float((out.closeness * live).sum() / live.sum().clamp(min=1))
        traders += float(out.result.traders.sum(1).float().mean())
    return {"market": kind, "platform_reward": reward / steps, "closeness": closeness / steps,
            "traders_per_batch": traders / steps}  # fmt: skip


class LogCallback(BaseCallback):
    """Print and append one JSON line per rollout; save a checkpoint every few rollouts."""

    def __init__(self, env, run_dir: Path, save_every: int = 10):
        super().__init__()
        self.env, self.run_dir, self.save_every = env, run_dir, save_every
        self.rollouts, self.t0 = 0, time.time()

    def _on_step(self) -> bool:
        return True

    def _on_rollout_end(self) -> None:
        self.rollouts += 1
        row = {
            "rollout": self.rollouts,
            "timesteps": self.num_timesteps,
            "minutes": round((time.time() - self.t0) / 60, 2),
        }
        row.update(self.env.pop_stats())
        row["log_std"] = (
            float(self.model.policy.log_std.detach().mean()) if hasattr(self.model.policy, "log_std") else None
        )
        line = json.dumps(row)
        print(line, flush=True)
        with open(self.run_dir / "log.jsonl", "a") as fh:
            fh.write(line + "\n")
        if self.rollouts % self.save_every == 0:
            self.model.save(self.run_dir / "latest")
