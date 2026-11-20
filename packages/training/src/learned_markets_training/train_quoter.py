"""Train the quoting network with PPO.

Every coin slot in every world shares the policy. Levers stay on their fixed
stand-ins. Example:

    uv run --all-packages python -m learned_markets_training.train_quoter --name quoter-v1 --timesteps 40000000
"""

from __future__ import annotations

import argparse
import json

from learned_markets_core.quoter import PARAM_NAMES
from stable_baselines3 import PPO

from .common import OUT, POLICY_KWARGS, LogCallback, market_config, policy_fn, quick_compare, sim_config
from .envs import QuoterVecEnv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="quoter")
    ap.add_argument("--worlds", type=int, default=256)
    ap.add_argument("--timesteps", type=int, default=40_000_000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--n-steps", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--gamma", type=float, default=0.995)
    ap.add_argument("--ent", type=float, default=0.0)
    ap.add_argument("--freeze", default="", help="comma-separated action names held at the rule-based stand-in")
    ap.add_argument("--resume", default="")
    ap.add_argument("--eval-steps", type=int, default=600)
    ap.add_argument("--save-every", type=int, default=100, help="rollouts between checkpoints")
    args = ap.parse_args()

    run_dir = OUT / "checkpoints" / args.name
    run_dir.mkdir(parents=True, exist_ok=True)
    frozen = tuple(PARAM_NAMES.index(n) for n in args.freeze.split(",") if n)
    sim = sim_config()
    env = QuoterVecEnv(market_config(args.worlds), sim, seed=args.seed, frozen=frozen)
    (run_dir / "config.json").write_text(json.dumps({**vars(args), "frozen_idx": frozen}, indent=1))

    if args.resume:
        model = PPO.load(args.resume, env=env, device="cuda")
    else:
        model = PPO(
            "MlpPolicy", env, n_steps=args.n_steps, batch_size=16384, n_epochs=4, learning_rate=args.lr,
            gamma=args.gamma, gae_lambda=0.95, ent_coef=args.ent, clip_range=0.2, max_grad_norm=0.5,
            policy_kwargs=POLICY_KWARGS, device="cuda", seed=args.seed, verbose=0,
        )  # fmt: skip
    model.learn(total_timesteps=args.timesteps, callback=LogCallback(env, run_dir, save_every=args.save_every), reset_num_timesteps=not args.resume)
    model.save(run_dir / "final")

    # Held-out seed, same crowd settings: learned against the two fixed markets.
    rows = [quick_compare(policy_fn(model), "learned", 10_001, 64, args.eval_steps, sim)]
    rows += [quick_compare(None, kind, 10_001, 64, args.eval_steps, sim) for kind in ("rule", "curve")]
    for row in rows:
        print(json.dumps(row), flush=True)
    (run_dir / "quick_compare.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
