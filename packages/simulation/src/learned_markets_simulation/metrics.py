"""Chart health and who-pays-whom, computed from a recorded run.

These grade a market; they are not the training reward. The eight chart-health
components follow docs/ai-gen/design/rl-formulation.md ("Healthy chart"), and
the rest follow the handoff's checks: tracking error to true value, attacker
profit, trader profit by type, reserve P&L and money trapped at death.
"""

from __future__ import annotations

import math

import torch
from learned_markets_core import SELL
from learned_markets_core.units import PRICE_SCALE

from .params import A_NONE, INFORMED, NOISE, REGIMES, RETAIL
from .world import StepOut, World

SOL = 1e9


class Recorder:
    """Keeps per-batch, per-coin series for one run."""

    def __init__(self, world: World):
        self.world = world
        self.rows: dict[str, list[torch.Tensor]] = {k: [] for k in (
            "logp", "logv", "live", "regime", "coin_id", "age", "traders", "lamports", "top10", "reward", "edge",
        )}  # fmt: skip
        self.wealth0 = world.wealth()
        self.topup0 = world.crowd.cum_topup.clone()
        self.cash_in = torch.zeros_like(self.wealth0)
        self.trapped = torch.zeros(world.cfg.n_worlds, dtype=torch.float64, device=world.dev)
        self.reserve0 = self._reserve()
        self._cash_before = world.total_cash.clone()
        self.fees = 0.0
        self.launches = 0
        self.attacker_exit_fee = 0.0
        self.attacker_exit_notional = 0.0
        self.ended = 0

    def _reserve(self) -> torch.Tensor:
        s = self.world.state
        return (s.q_cash.sum(1) + s.dead_cash + s.platform_cash).double()

    def add(self, out: StepOut) -> None:
        w, s = self.world, self.world.state
        # The state has already moved to the next batch; `out` describes the batch just cleared.
        live = (s.stage > 0) & ~out.events.launched
        px = out.result.price.double() / PRICE_SCALE
        r = self.rows
        r["logp"].append(torch.log(out.result.price.float()))
        r["logv"].append(w.true_log_price())
        r["live"].append(live)
        r["regime"].append(w.memes.regime.clone())
        r["coin_id"].append(s.coin_id.clone())
        r["age"].append((s.t - s.birth).float())
        r["traders"].append(out.result.traders.float())
        r["lamports"].append((out.result.volume.double() * px).float())
        r["top10"].append(w.tape.top10.clone())
        r["reward"].append(out.reward)
        r["edge"].append(out.result.at_edge)
        self.trapped += out.events.trapped.double()
        self.fees += float(out.result.fees.sum())
        # Exit fees charged to scripted attackers: did the market charge the dump?
        o, res = out.orders, out.result
        A = w.sim.n_attacker_seats
        seat = o.p < A
        scripted = seat & w.crowd.attackers.scripted[o.w, o.p.clamp(max=A - 1)]
        sold = scripted & (o.side == SELL) & (res.fill > 0)
        self.attacker_exit_fee += float(res.fee[sold].sum())
        self.attacker_exit_notional += float(res.settlement.notional[sold].sum()) if res.settlement is not None else 0.0
        self.launches += int(out.events.launched.sum())
        self.ended += int(out.events.ended.sum())

    def stack(self) -> dict[str, torch.Tensor]:
        return {k: torch.stack(v) for k, v in self.rows.items()}  # each [T, W, C]


def _var(x: torch.Tensor, m: torch.Tensor) -> float:
    n = m.sum().clamp(min=2)
    mean = (x * m).sum() / n
    return float((((x - mean) ** 2) * m).sum() / (n - 1))


def chart_health(rec: Recorder, q: int = 10, h: int = 10, warm: int = 20) -> dict:
    """The eight chart-health components plus tracking error, pooled over all coins."""
    d = rec.stack()
    logp, live, cid = d["logp"], d["live"], d["coin_id"]
    same = torch.zeros_like(live)
    same[1:] = live[1:] & live[:-1] & (cid[1:] == cid[:-1])
    ret = torch.zeros_like(logp)
    ret[1:] = torch.where(same[1:], logp[1:] - logp[:-1], torch.zeros_like(logp[1:]))
    seasoned = live & (d["age"] >= warm)

    # 3. Moves stick: variance ratio of q-batch to 1-batch returns (1 = random walk).
    csum = ret.cumsum(0)
    run = torch.zeros_like(live)
    run[q:] = live[q:] & live[:-q] & (cid[q:] == cid[:-q])
    rq = torch.zeros_like(ret)
    rq[q:] = csum[q:] - csum[:-q]
    var1 = _var(ret, same.float())
    vr = _var(rq, run.float()) / max(q * var1, 1e-12)

    # 4. Transient volatility: the part of each move undone within h batches.
    fut = torch.zeros_like(ret)
    fut[:-h] = csum[h:] - csum[:-h]
    ok = torch.zeros_like(live)
    ok[:-h] = same[:-h] & live[h:] & (cid[h:] == cid[:-h])
    undone = torch.where(torch.sign(fut) != torch.sign(ret), torch.minimum(ret.abs(), fut.abs()), torch.zeros_like(ret))
    transient = math.sqrt(max(_var(undone, ok.float()), 0.0))

    # 5. Gaps: the largest single-batch moves.
    moves = ret.abs()[same]
    gap999 = (
        float(torch.quantile(moves[torch.randperm(moves.numel(), device=moves.device)[:2_000_000]], 0.999))
        if moves.numel()
        else 0.0
    )
    gap_max = float(moves.max()) if moves.numel() else 0.0

    # 6 and 7. Collapse and recovery, from running peaks inside a 120-batch window.
    win = 120
    pad = torch.full((win - 1, *logp.shape[1:]), -float("inf"), device=logp.device)
    lp = torch.where(live, logp, torch.full_like(logp, -float("inf")))
    peak = torch.cat([pad, lp]).unfold(0, win, 1).max(dim=-1).values
    dd = torch.where(live, lp - peak, torch.zeros_like(lp))
    collapse = float(((dd < math.log(0.1)) & seasoned).sum() / seasoned.sum().clamp(min=1))
    deep = (dd < math.log(0.7)) & seasoned
    later = torch.zeros_like(dd)
    look = 60
    later[:-look] = dd[look:]
    okr = torch.zeros_like(live)
    okr[:-look] = deep[:-look] & live[look:] & (cid[look:] == cid[:-look])
    recovered = float((okr & (later > dd / 2)).sum() / okr.sum().clamp(min=1))

    # 8. Price impact (Amihud): absolute return per SOL traded.
    traded = same & (d["lamports"] > 0)
    amihud = float((ret.abs()[traded] / (d["lamports"][traded] / SOL)).mean()) if bool(traded.any()) else float("nan")

    err = (logp - d["logv"]).abs()
    out = {
        "reward_per_batch": float(d["reward"].sum(2).mean()),
        "tracking_error": float(err[seasoned].mean()),
        "1_top10_share": float(d["top10"][seasoned].mean()),
        "2_traders_per_coin_batch": float(d["traders"][seasoned].mean()),
        "3_variance_ratio": vr,
        "4_transient_vol": transient,
        "5_gap_p999": gap999,
        "5_gap_max": gap_max,
        "6_collapse_share": collapse,
        "7_half_recovered_60": recovered,
        "8_amihud_per_sol": amihud,
        "volatility_1batch": math.sqrt(max(var1, 0.0)),
        "window_edge_hits": int(d["edge"].sum()),
        "coin_batches": int(live.sum()),
    }
    for i, name in enumerate(REGIMES):
        m = seasoned & (d["regime"] == i)
        out[f"tracking_error/{name}"] = float(err[m].mean()) if bool(m.any()) else float("nan")
    return out


def money(rec: Recorder) -> dict:
    """Who gained and who lost, in SOL per world over the run."""
    w = rec.world
    crowd = w.crowd
    W = w.cfg.n_worlds
    injected = (w.total_cash - rec._cash_before).double()  # top-ups from outside
    gain = w.wealth() - rec.wealth0 - (crowd.cum_topup - rec.topup0).double()  # trading result, net of outside money
    A = w.sim.n_attacker_seats
    script = crowd.attackers.script
    is_attacker = torch.zeros_like(gain, dtype=torch.bool)
    is_attacker[:, :A] = script != A_NONE
    out = {}
    for name, kind in (("noise", NOISE), ("retail", RETAIL), ("informed", INFORMED)):
        m = (crowd.kind == kind) & ~is_attacker
        out[f"pnl_sol_per_person/{name}"] = float(gain[m].mean() / SOL)
    scripted = is_attacker.clone()
    out["attacker_profit_sol_per_seat"] = float(gain[scripted].mean() / SOL) if bool(scripted.any()) else 0.0
    out["attacker_seats"] = int(scripted.sum())
    out["attacker_exit_fee_rate"] = rec.attacker_exit_fee / max(rec.attacker_exit_notional, 1.0)
    out["injected_sol_per_world"] = float(injected.mean() / SOL)
    out["reserve_pnl_sol_per_world"] = float((rec._reserve() - rec.reserve0).mean() / SOL)
    out["trapped_at_death_sol_per_world"] = float(rec.trapped.mean() / SOL)
    out["fees_sol_per_world"] = rec.fees / W / SOL
    out["launches_per_world"] = rec.launches / W
    out["ended_per_world"] = rec.ended / W
    return out
