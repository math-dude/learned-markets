"""Stable-Baselines3 adapters over the batched world.

`QuoterVecEnv`: one env index per (world, coin slot). Every slot shares the
quoter policy, so each coin's life is an episode and the rest of the line is
real competition, not a stand-in. An episode ends when the coin is cut, dies
or is bumped; there is no reward after that, so no bootstrap.

`AuctionVecEnv`: one env index per world. One step is an epoch with the quoter
frozen; the action moves each of the six levers down, not at all, or up.
"""

from __future__ import annotations

from collections.abc import Callable

import gymnasium as gym
import numpy as np
import torch
from learned_markets_core import MarketConfig, residual_params
from learned_markets_core.lifecycle import default_lever_values, step_lever_values
from learned_markets_core.quoter import N_PARAMS
from learned_markets_simulation.params import SimConfig
from learned_markets_simulation.reward import platform_reward
from learned_markets_simulation.world import World
from stable_baselines3.common.vec_env import VecEnv

from .features import N_AUCTION_FEATURES, N_QUOTER_FEATURES, AuctionStats, auction_features, quoter_features

REWARD_SCALE = 10.0
_NO_INFO: dict = {}


class _TensorVecEnv(VecEnv):
    """Shared plumbing: SB3 wants numpy in and out, the world lives on the GPU."""

    def step_async(self, actions: np.ndarray) -> None:
        self._actions = torch.as_tensor(actions, device=self.world.dev)

    def close(self) -> None:
        pass

    def get_attr(self, attr_name, indices=None):
        return [getattr(self, attr_name)] * self.num_envs

    def set_attr(self, attr_name, value, indices=None) -> None:
        setattr(self, attr_name, value)

    def env_method(self, method_name, *args, indices=None, **kwargs):
        return [getattr(self, method_name)(*args, **kwargs)] * self.num_envs

    def env_is_wrapped(self, wrapper_class, indices=None):
        return [False] * self.num_envs


class QuoterVecEnv(_TensorVecEnv):
    def __init__(
        self,
        cfg: MarketConfig,
        sim: SimConfig | None = None,
        seed: int = 0,
        frozen: tuple[int, ...] = (),
    ):
        """The action is a correction to the rule-based stand-in (see `residual_params`).

        `frozen` lists action indices held at the stand-in, for ablations.
        """
        self.world = World(cfg, sim, seed=seed, quoter="params")
        self.cfg = cfg
        self.frozen = list(frozen)
        obs_space = gym.spaces.Box(-5.0, 5.0, (N_QUOTER_FEATURES,), np.float32)
        act_space = gym.spaces.Box(-1.0, 1.0, (N_PARAMS,), np.float32)
        super().__init__(cfg.n_groups, obs_space, act_space)
        self.reward_sum, self.reward_steps = 0.0, 0
        self.closeness_sum, self.traders_sum = 0.0, 0.0

    def _obs(self) -> np.ndarray:
        return quoter_features(self.world).reshape(self.num_envs, -1).cpu().numpy()

    def reset(self) -> np.ndarray:
        return self._obs()

    def step_wait(self):
        w = self.world
        out = w.step(residual_params(w.state, w.tape.pressure, w.tape.idle, self._actions, self.cfg, self.frozen))
        done = out.events.ended | out.events.launched
        live = w.state.stage > 0
        self.reward_sum += float(out.people_reward.sum(1).mean())
        self.closeness_sum += float((out.closeness * live).sum() / live.sum().clamp(min=1))
        self.traders_sum += float(out.result.traders.sum(1).float().mean())
        self.reward_steps += 1
        return (
            self._obs(),
            (out.reward * REWARD_SCALE).reshape(-1).cpu().numpy(),
            done.reshape(-1).cpu().numpy(),
            [_NO_INFO] * self.num_envs,
        )

    def pop_stats(self) -> dict:
        n = max(self.reward_steps, 1)
        stats = {
            "platform_reward": self.reward_sum / n,
            "closeness": self.closeness_sum / n,
            "traders_per_batch": self.traders_sum / n,
        }
        self.reward_sum = self.closeness_sum = self.traders_sum = 0.0
        self.reward_steps = 0
        return stats


class AuctionVecEnv(_TensorVecEnv):
    def __init__(
        self,
        cfg: MarketConfig,
        quoter: Callable[[torch.Tensor], torch.Tensor] | None,
        sim: SimConfig | None = None,
        seed: int = 0,
    ):
        """`quoter` maps observations [N, F] to actions [N, 10]; None runs the rule-based quoter."""
        self.world = World(cfg, sim, seed=seed, quoter="params" if quoter else "rule")
        self.cfg, self.quoter = cfg, quoter
        self.stats = AuctionStats(self.world)
        self.values = default_lever_values(cfg)
        self.epochs = 0
        obs_space = gym.spaces.Box(-5.0, 5.0, (N_AUCTION_FEATURES,), np.float32)
        act_space = gym.spaces.MultiDiscrete([3] * 6)
        super().__init__(cfg.n_worlds, obs_space, act_space)
        self.reward_sum, self.reward_steps = 0.0, 0

    def _quoter_params(self) -> torch.Tensor | None:
        if self.quoter is None:
            return None
        w = self.world
        obs = quoter_features(w).reshape(self.cfg.n_groups, -1)
        return residual_params(w.state, w.tape.pressure, w.tape.idle, self.quoter(obs), self.cfg)

    def _obs(self) -> np.ndarray:
        return auction_features(self.world, self.stats).cpu().numpy()

    def reset(self) -> np.ndarray:
        return self._obs()

    def step_wait(self):
        move = self._actions.long() - 1
        self.values = step_lever_values(self.values, move)
        self.stats.reset()
        total = torch.zeros(self.cfg.n_worlds, device=self.world.dev)
        for _ in range(self.cfg.epoch):
            out = self.world.step(self._quoter_params(), self.values)
            self.stats.add(out)
            total += platform_reward(out.reward)
        reward = total / self.cfg.epoch
        self.epochs += 1
        # The world never resets, so there is no terminal state; rollouts bootstrap at their end.
        done = np.zeros(self.num_envs, dtype=bool)
        self.reward_sum += float(reward.mean())
        self.reward_steps += 1
        return self._obs(), (reward * REWARD_SCALE).cpu().numpy(), done, [_NO_INFO] * self.num_envs

    def pop_stats(self) -> dict:
        n = max(self.reward_steps, 1)
        stats = {"platform_reward": self.reward_sum / n, "levers": self.values.mean(0).tolist()}
        self.reward_sum, self.reward_steps = 0.0, 0
        return stats
