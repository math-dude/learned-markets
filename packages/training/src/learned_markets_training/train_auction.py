"""Train the auction network with PPO against a frozen quoter.

One step is an epoch. The action moves each lever (launch fee, line size, seat
count, rookie seats, timer drain, timer cap) down, not at all, or up by one
bounded step. The network never picks or kills a coin. Example:

    uv run --all-packages python -m learned_markets_training.train_auction --quoter /data/eren/learned-markets/checkpoints/quoter-v1/final.zip
"""

from __future__ import annotations

import argparse
import json

from stable_baselines3 import PPO

from .common import OUT, LogCallback, market_config, policy_fn, sim_config
from .envs import AuctionVecEnv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="auction")
    ap.add_argument("--quoter", default="", help="trained quoter to freeze; omit to use the rule-based quoter")
    ap.add_argument("--worlds", type=int, default=512)
    ap.add_argument("--timesteps", type=int, default=120_000, help="epochs summed over worlds")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    run_dir = OUT / "checkpoints" / args.name
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps(vars(args), indent=1))
    quoter = policy_fn(PPO.load(args.quoter, device="cuda")) if args.quoter else None
    env = AuctionVecEnv(market_config(args.worlds), quoter, sim_config(), seed=args.seed)
    model = PPO(
        "MlpPolicy", env, n_steps=8, batch_size=1024, n_epochs=6, learning_rate=3e-4, gamma=0.9, gae_lambda=0.9,
        ent_coef=0.01, clip_range=0.2, policy_kwargs={"net_arch": {"pi": [128, 128], "vf": [128, 128]}},
        device="cuda", seed=args.seed, verbose=0,
    )  # fmt: skip
    model.learn(total_timesteps=args.timesteps, callback=LogCallback(env, run_dir, save_every=2))
    model.save(run_dir / "final")


if __name__ == "__main__":
    main()
