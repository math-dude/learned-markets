"""Export the series behind the pitch video: what the trained quoter adds over the rules alone.

`demo_data` compares pump with our market. This adds the rule-based quoter as
a third market under the same caps, so a difference between "rule" and "ours"
is the trained quoter's and not the caps'.

    uv run --all-packages --all-extras python -m learned_markets_training.video_data \\
        --quoter artifacts/checkpoints/quoter-gap5/final.zip --out /data/eren/learned-markets/demo/video-data.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from learned_markets_simulation.params import BATCH_SECONDS, REGIMES
from stable_baselines3 import PPO

from .common import OUT, policy_fn, sim_config
from .demo_data import _r
from .figures import REGIME_TITLES, paired_run

MARKETS = ("pump", "rule", "ours")
BARS = {
    "tracking_error": "Distance of price from true value (log)",
    "4_transient_vol": "Noise in the price",
    "2_traders_per_coin_batch": "People trading per coin per batch",
    "pnl_sol_per_person/retail": "Retail profit per person (SOL)",
    "pnl_sol_per_person/informed": "Profit per person for traders who are right (SOL)",
}


def bars(standards: list[str]) -> dict:
    """Mean over the given standard.json files of each headline number, per market."""
    name = {"pump": "pump", "rule": "rule", "learned": "ours"}
    seen: dict[str, dict[str, list[float]]] = {k: {m: [] for m in MARKETS} for k in BARS}
    for path in standards:
        for row in json.loads(Path(path).read_text()):
            if row["market"] in name:
                for k in BARS:
                    seen[k][name[row["market"]]].append(row[k])
    return {k: {"title": BARS[k], "runs": len(v["ours"]), **{m: round(float(np.mean(v[m])), 4) for m in MARKETS}}
            for k, v in seen.items()}  # fmt: skip


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quoter", required=True)
    ap.add_argument("--out", default=str(OUT / "demo" / "video-data.json"))
    ap.add_argument("--seed", type=int, default=40_001)
    ap.add_argument("--worlds", type=int, default=32)
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--standard", nargs="*", default=[], help="standard.json files holding pump, rule and learned rows")
    args = ap.parse_args()
    act = policy_fn(PPO.load(args.quoter, device="cuda"))

    clean = sim_config(attacker_rate=0.0)
    runs = {m: paired_run(m, act if m == "ours" else None, args.seed, args.worlds, args.steps, clean) for m in MARKETS}
    value = runs["ours"]["logv"]
    assert all(np.allclose(runs[m]["logv"], value) for m in MARKETS), "markets did not trade identical memes"
    err = {m: np.abs(runs[m]["logp"] - value).mean(0) for m in MARKETS}  # [W, C] mean log distance per meme
    noise = {m: np.abs(np.diff(runs[m]["logp"] - value, axis=0)).mean(0) for m in MARKETS}

    pick = slice(None, None, 5)
    minutes = _r((np.arange(args.steps) * BATCH_SECONDS / 60)[pick], 2)
    memes = []
    for i, key in enumerate(REGIMES):
        mask = runs["ours"]["regime"] == i
        if not mask.any():
            continue
        # The example is the meme with the median rule-minus-ours difference in its kind, not the best one.
        diff = (err["rule"] - err["ours"])[mask]
        w, c = np.argwhere(mask)[np.argsort(diff)[len(diff) // 2]]
        memes.append({
            "key": key, "title": REGIME_TITLES[key], "memes": int(mask.sum()), "minutes": minutes,
            "value": _r(np.exp(value[pick, w, c]), 3),
            **{m: _r(np.exp(runs[m]["logp"][pick, w, c]), 3) for m in MARKETS},
            "off": {m: round(float(np.expm1(err[m][w, c])), 3) for m in MARKETS},
            "mean_off": {m: round(float(np.expm1(err[m][mask].mean())), 3) for m in MARKETS},
            "ours_closer_than_rule": round(float((diff > 0).mean()), 3),
            "ours_closer_than_pump": round(float(((err["pump"] - err["ours"])[mask] > 0).mean()), 3),
        })  # fmt: skip

    data = {
        "memes": memes,
        "overall": {
            "memes": int(err["ours"].size),
            "mean_log_distance": {m: round(float(err[m].mean()), 4) for m in MARKETS},
            "mean_batch_noise": {m: round(float(noise[m].mean()), 5) for m in MARKETS},
            "ours_closer_than_rule": round(float((err["rule"] > err["ours"]).mean()), 3),
            "ours_closer_than_pump": round(float((err["pump"] > err["ours"]).mean()), 3),
        },
        "bars": bars(args.standard),
        "note": "Simulated crowd; true value exists only in the simulator. Rule and ours share the same caps and fees ceiling.",
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":")))
    print(json.dumps({"overall": data["overall"], "bars": data["bars"],
                      "memes": [{k: m[k] for k in ("key", "memes", "off", "mean_off", "ours_closer_than_rule", "ours_closer_than_pump")} for m in memes]}, indent=1))  # fmt: skip


if __name__ == "__main__":
    main()
