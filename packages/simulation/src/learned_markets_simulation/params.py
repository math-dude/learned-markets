"""Simulation parameters and the calibration hook.

Everything here is an assumption about memes and people, not a market rule.
Values we could measure come from the pump.fun calibration files when present;
values we cannot measure (how people react to exit fees and caps) are sampled
from wide ranges per world so no single assumption carries a result.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path

CALIBRATION_DIR = Path(os.environ.get("LM_CALIBRATION", "/data/eren/learned-markets/calibration"))
BATCH_SECONDS = 10.0

REGIMES = ("up_drift", "down_drift", "swings", "quiet", "info_jump", "near_dead")
# Per regime: probability, base log value (mean, sd) relative to the launch price,
# attention at launch, attention still to arrive at launch, later bursts per batch,
# burst size (mean, sd), decay time and rise time in batches, diffusion per batch.
#                 prob  b_mu  b_sd  a_init a_pend rate     amp   amp_sd tau    rise  sigma
REGIME_TABLE = (
    (0.15, -0.3, 0.4, 0.2, 1.0, 1 / 300, 0.6, 0.3, 600.0, 60.0, 0.010),  # up drift
    (0.20, -1.0, 0.4, 1.2, 0.0, 0.0, 0.0, 0.0, 150.0, 30.0, 0.010),  # down drift
    (0.15, -0.5, 0.4, 0.3, 0.8, 1 / 120, 0.8, 0.4, 72.0, 20.0, 0.020),  # violent swings
    (0.20, -0.6, 0.3, 0.2, 0.3, 1 / 1000, 0.2, 0.1, 300.0, 60.0, 0.005),  # quiet noise
    (0.10, -0.6, 0.3, 0.2, 0.3, 1 / 600, 1.5, 0.4, 2000.0, 1.0, 0.008),  # information jump
    (0.20, -1.5, 0.4, 0.1, 0.1, 0.0, 0.0, 0.0, 100.0, 30.0, 0.005),  # near dead
)

NOISE, RETAIL, INFORMED = 0, 1, 2

# Attacker scripts. Seats are the first people of each world.
A_NONE, A_SNIPER, A_PUMPER, A_CASCADE, A_HOARDER, A_WASH, A_PICKER = range(7)
ATTACKERS = ("none", "sniper", "pump_and_dump", "cascade_seller", "hoarder", "wash_pair", "stale_quote_picker")


@dataclass(frozen=True)
class SimConfig:
    # Crowd composition and behaviour.
    share_noise: float = 0.25
    share_informed: float = 0.10  # the rest is retail
    cash_median_lamports: float = 2e9
    cash_sigma: float = 1.0
    act_rate: tuple[float, float] = (0.03, 0.25)  # chance a person acts in a batch, per person
    risk_share: tuple[float, float] = (0.05, 0.4)  # share of wealth a person will put in one coin
    width: tuple[float, float] = (0.15, 0.6)  # log-price range over which a person scales in
    signal_sd: tuple[float, float, float] = (1.0, 0.7, 0.1)  # noise, retail, informed
    signal_rho: float = 0.995  # persistence of a person's error about a coin
    retail_lag: float = 30.0  # batches for retail to absorb a move in true value
    momentum: tuple[float, float, float] = (0.0, 3.0, 0.0)  # weight on recent return, by type
    horizon: tuple[float, float] = (20.0, 600.0)  # batches a person expects to hold
    liquidity_sell: float = 0.02  # chance an acting holder sells part regardless of price
    hold_boost: float = 3.0  # extra attention to coins a person holds
    visibility: tuple[float, float, float, float] = (0.0, 1.0, 3.0, 4.0)  # empty, line, rookie, regular
    heat_power: float = 0.7
    # Unmeasured sensitivities, sampled per world (log-uniform).
    fee_elasticity: tuple[float, float] = (2.0, 30.0)  # participation drops as exp(-e * burden)
    cap_annoyance: tuple[float, float] = (0.0, 0.02)  # burden added when a cap blocks most of a buy (uniform)
    reflexivity: tuple[float, float] = (0.0, 0.3)  # attention gained per unit of log return
    deployer_fee_scale: tuple[float, float] = (5e7, 1e9)  # launches fall as exp(-fee / scale)
    # Memes.
    launch_rate: float = 1 / 25  # launch attempts per batch per world before the fee
    tau_sigma: float = 1.0  # spread of decay times across memes (log-normal)
    half_life_scale: float = 1.0  # multiplies every decay time; set from calibration
    attention_max: float = 2.5  # attention saturates here (about 12x the base value)
    walk_reversion: float = 1000.0  # batches over which the residual random walk reverts
    # Money arriving from outside.
    income_rate: float = 0.002  # share of a person's shortfall against their starting wealth refilled per batch
    # Attackers: chance a world has each seat active, and the seat's script.
    n_attacker_seats: int = 6
    attacker_rate: float = 0.25
    attacker_script: int = -1  # -1 samples a script per seat; otherwise forces one
    # Reward.
    closeness_scale: float = 0.25
    reward_norm: float = 0.05  # reward 1.0 means 5% of the crowd traded at the true value


def load_calibration(cfg: SimConfig | None = None) -> tuple[SimConfig, dict]:
    """Fold measured values into the config. Returns the config and what was used."""
    cfg = cfg or SimConfig()
    used: dict = {}
    path = CALIBRATION_DIR / "attention" / "attention_params.json"
    if path.exists():
        try:
            buyers = json.loads(path.read_text()).get("buyers", {})
            q = buyers.get("half_life_mass_min", {})
            median = q.get("q50") or q.get("median")
            if median:
                # The regime table was written for a 12-minute median half-life.
                cfg = replace(cfg, half_life_scale=float(median) / 12.0)
                used["half_life_mass_min_q50"] = float(median)
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            pass
    return cfg, used
