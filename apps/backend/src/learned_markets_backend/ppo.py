"""Run a training-owned observation encoder and action decoder with a trusted local checkpoint."""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from .contracts import Observation
from .policy import Policy, Quote


def load_policy(
    checkpoint: str | Path,
    encode_observation: Callable[[Observation], Any],
    decode_action: Callable[[Observation, Any], Quote],
) -> Policy:
    from stable_baselines3 import PPO

    model = PPO.load(checkpoint, device="cpu")

    def policy(obs: Observation) -> Quote:
        encoded = encode_observation(obs)
        if not model.observation_space.contains(encoded):
            raise ValueError(
                "encoded observation does not fit the checkpoint observation space"
            )
        action, _ = model.predict(encoded, deterministic=True)
        return decode_action(obs, action)

    return policy
