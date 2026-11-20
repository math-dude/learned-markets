import importlib.util
import tempfile
import unittest
from pathlib import Path

from learned_markets_backend.contracts import Observation
from learned_markets_backend.policy import rule_quote
from learned_markets_backend.ppo import load_policy
from test_quoter import observation


@unittest.skipUnless(
    importlib.util.find_spec("stable_baselines3"), "requires the optional ppo extra"
)
class PolicyTests(unittest.TestCase):
    def test_saved_checkpoint_with_training_owned_spaces(self):
        import numpy as np
        from gymnasium import Env, spaces
        from stable_baselines3 import PPO

        class PolicySpaces(Env):
            observation_space = spaces.Box(-1, 1, (2,), dtype=np.float32)
            action_space = spaces.Box(-1, 1, (1,), dtype=np.float32)

        def encode(obs):
            return np.array(
                [obs.market.reserve_tokens / 1_000_000_000, 0], dtype=np.float32
            )

        def decode(obs, action):
            quote = rule_quote(obs)
            return quote.model_copy(update={"fee0": (float(action[0]) + 1) * 0.1})

        model = PPO(
            "MlpPolicy", PolicySpaces(), seed=41, device="cpu", n_steps=2, batch_size=2
        )
        obs = Observation.model_validate(observation())
        expected = decode(obs, model.predict(encode(obs), deterministic=True)[0])
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "policy.zip"
            model.save(file)
            self.assertEqual(expected, load_policy(file, encode, decode)(obs))
            with self.assertRaisesRegex(ValueError, "observation space"):
                load_policy(file, lambda _: np.zeros(9), decode)(obs)
