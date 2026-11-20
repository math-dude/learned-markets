# RL formulation

Proposed 2026-11-19. Nothing here is decided unless marked. Mechanism details live in `board-and-timers.md` and `market-rules.md`.

## Overview

Two learned agents on two clocks. Neither decides which coins live or die: public timer rules do. The team calls them the **quoting network** (the maker) and the **auction network** (the stage manager); the names are interchangeable.

| | Quoting network (maker) | Auction network (stage manager) |
| --- | --- | --- |
| Acts | Every batch | Every epoch (e.g. hourly) |
| Controls | Its own curve order in the batch auction | Seat count S, rookie seats P, drain multiplier, timer cap, launch fee (v1: fee/hold parameters) |
| Goal | Damp short-lived price shocks; healthy charts; break even | Healthy board; fresh memes get a shot |
| Never | Defends a price level; refuses honest flow | Picks or kills individual coins |

## Environment

One event-driven simulator (priority queue of timestamped events) covers both agents.

| Event | From | Effect |
| --- | --- | --- |
| `OrderArrival` | Background flow, taker agents | A user curve joins the next batch |
| `BatchClear` | Clock | **Maker acts**; clear; fills; timers update |
| `InfoShock` | Scenario | True value jumps; only informed traders see it |
| `Launch` / `Merge` | Users | New coin enters the line, or merges into an existing one |
| `EpochBoundary` | Clock | **Stage manager acts**; seating, graduation, deaths; loss budget resets; log hash committed |
| `Death` | Timer rule | Coin delisted; reserve redistributed |

- Events are stamped with a Solana slot so sim time maps onto chain time.
- Clearing math in Python mirrors the Rust program exactly (integer, round against the trader); golden vectors checked by both test suites.
- One event schema shared by the simulator, the program's events and the public log; real devnet sessions replay with no conversion.
- Background flow: Hawkes arrivals (own implementation, Ogata thinning) calibrated to real pump.fun / PumpSwap trades.
- Every sim agent has a person ID, so per-person caps and breadth work.

**Regimes** (sampled per episode, hidden from agents, metrics reported per regime): up drift, down drift, violent swings, quiet noise, information jumps, coordinated pumps, near-dead coins; platform volume low / medium / high / bursty.

## Maker agent

Posts one curve order per coin per batch, before seeing that batch's orders (no last look).

**Observation** (normalized float32)

- Market state: returns over several windows, realized volatility, signed flow imbalance of past batches, flow EMA, size distribution of user curves.
- Coin state: timer, breadth, holder concentration, age, rookie or regular.
- Reserve state: inventory (base and quote), PnL this epoch, remaining loss budget, time in epoch.
- No per-wallet sender features: clearing is mechanical and identity handles multi-wallet abuse.

**Action** (continuous, squashed into guardrail bounds)

- Mid offset from the last clearing price.
- Depth on each side, asymmetric.
- Per-batch size cap on its curve.

Capped share of volume (X% per batch, Y% per epoch). Prefer shallow depth over withdrawing.

**Reward** (NOT DECIDED)

Markout-based: reward absorbing moves that later reverse; charge for absorbing moves that hold (those were informed). Plus chart health, dampened PnL, hard breach penalty.

```
r_t = w_mk·markout_h − w_vol·σ_transient − w_gap·max|r_batch| + w_pnl·tanh(ΔPnL / c) − w_inv·I² − P_breach
```

- markout_h: signed price change over horizon h after each maker fill, from the maker's side.
- Dampened PnL: raw incremental PnL destabilizes market-making agents (Spooner et al., 2018).
- Discount by elapsed time, not step count.

## Stage manager agent

Shapes the room once per epoch. Precedents: YouTube SlateQ, MNL-bandit, Meituan Cross DQN, airline seat RL (see `docs/ai-gen/research/precedents.md`).

**Observation:** per seated coin (timer, breadth, fee flow, holder concentration, age, chart health); line (waiting coins, heat); platform (volume, distinct active people, deaths and graduations last epoch); its own current settings.

**Action** (each bounded, published, at most one step per epoch): S, P, drain multiplier 0.8–1.2, timer cap, launch-fee target; v1 adds fee/hold parameters. Default for every lever is the fixed rule; learning replaces it. Small and discrete: a bandit or tiny PPO may suffice.

**Reward** (NOT DECIDED), decomposed per coin like SlateQ:

```
R_e = Σ_i∈board ( w_p·people_i + w_h·health_i ) + w_r·rookie_survival_e − w_t·trapped_e − w_s·|Δsettings|
```

- trapped_e: holders' value lost in deaths this epoch. Last term keeps the board stable.

**Episode:** a season of several sim days.

## Healthy chart: definition (proposed)

Moves come from many people and stick; nobody can crash the chart alone. Volatility as such is not penalized.

| # | Component | Measure (per coin, per window) | Healthy | Catches |
| --- | --- | --- | --- | --- |
| 1 | Concentration | Top-10 *person* share of supply, or HHI by person | Low | Insider supply, bundling, rug risk |
| 2 | Breadth | Distinct people trading; buyer-count growth | High | Fake volume, cabals |
| 3 | Moves stick | Variance ratio VR(q) = Var(q-batch return) / (q·Var(1-batch return)) | ≈ 1 | <1: reverting pumps/dumps; >1: herding cascades |
| 4 | Transient volatility | Volatility of the part of each move that reverses within h batches | Low | Pump-and-dumps, cascades |
| 5 | Gaps | Largest single-batch absolute log return | Small | Snipes, rugs, one-shot dumps |
| 6 | Collapse | Max drawdown from running peak; flag if >90% in a short window | Rare | Rugs, coordinated dumps |
| 7 | Recovery | Batches to recover half a drawdown | Fast | Cascades vs absorbed shocks |
| 8 | Price impact | Kyle's λ or Amihud illiquidity | Low, stable | Thin, easily pushed markets |

Score: each component normalized to [0, 1] against `no_op` in the same regime; `H = Σ w_j·h_j`, equal weights to start. Maker reward uses 3–5 and 8; stage manager and evaluation use all eight.

Why: concentration and early ownership are the strongest risk signals in MemeTrans (41,470 pump.fun launches, 122 features, 84% labelled high-risk). Variance ratio, Kyle's λ and Amihud are standard market-quality measures. Transient volatility = price impact that reverses (effective minus realized spread), which is what the markout reward targets. Benchmarks: pump.fun 68.7% die on launch day, 4.55% trade past 90 days.

## Training

One agent at a time against frozen everything-else, maker first. SB3 PPO is the only RL package; a short PSRO-style outer loop of our own picks frozen opponents.

1. **No RL:** simulator, rule-based maker, fixed board settings, scripted attackers, regimes, baselines. Demo safety net.
2. **Maker PPO:** one or two coins, board frozen. Core result: learned maker beats baselines.
3. **Stage manager:** maker frozen; across platform-volume regimes.
4. **PSRO-lite (stretch):** PPO attacker vs frozen maker joins the pool; maker retrained against the pool.

Not joint training: two learners on different clocks adapting at once is hard to debug in two nights.

**Taker flow:** Hawkes background (noise, momentum, retail); informed traders (see `InfoShock` first); scripted attackers, one per behaviour: opening-batch sniper, pump-and-dump, KOL dump, cascade seller, wash trader, fake momentum, stale-quote picker, dump-into-maker after run-up, threshold gamer, timer gamer. Takers must respond to fees and holds.

**Baselines**

| Agent | Baselines |
| --- | --- |
| Maker | `no_op` (plain curve), `fee_only` (asymmetric volatility fee), `rule_based` (fixed lean against flow) |
| Stage manager | Fixed settings; seats scale with platform volume; Whittle-index-style heuristic |

**Metrics:** health score and components; price-discovery lag after `InfoShock` (close to `no_op`); reserve PnL ≥ 0, no budget breaches; attacker profit per strategy; trader PnL by type; coin lifespans vs pump.fun.

**Demo:** counterfactual replay of a real pump-and-dump vs `no_op`; live attack buttons on devnet plus a "real news" button the maker lets through; scoreboard; PSRO payoff table (stretch).

**Settings:** PPO `MlpPolicy`, `SubprocVecEnv`, `VecNormalize`; fallback SAC. PettingZoo AEC env with a frozen-opponent wrapper exposing one seat as a Gymnasium env.

## Packages

Pin Python 3.12.

| Package | Version | Role |
| --- | --- | --- |
| Gymnasium | ≥1.2, <2.0 | Single-agent env API |
| PettingZoo | ≥1.25 | Multi-agent env API (AEC) |
| Stable-Baselines3 | ≥2.9.2 | PPO / SAC (requires torch ≥2.8; single-agent only) |
| NumPy, Numba | NumPy 2.x | Fast simulator loops |
| SciPy | latest | PSRO meta-solver |
| ONNX, onnxruntime | latest | Export policy for the auctioneer |
| Polars, PyArrow | latest | Trade data (Parquet) |

Avoid this week: RLlib, JAX stacks, the OpenSpiel package, SuperSuit, ABIDES (borrow its agent archetypes, not code). Later: BenchMARL or AgileRL.

## Roadmap

**v0: one coin, maker only (code first)**
- Batch clearing with piecewise-linear curves; maker PPO (offset, depth per side, cap); fixed fee rule; scripted takers (background, informed, sniper, pump-and-dump, cascade seller) that react to fees; health score; three baselines.

**v1: the board**
- Line, board, rookie seats, timers, graduation, death, redistribution, second chance; stage manager; fee/hold parameters learnable per epoch (and optionally a narrow per-batch band for the maker), same for everyone in a batch; remaining attackers incl. timer gamers; PSRO-lite.

**v2: per person and beyond**
- Per-person holds and exit fees, learned from history (reputation costly to earn, decays); per-person sell tax; holding ("wealth") tax if wanted; shared reserve across coins with per-coin caps; maker quoting in the line; automatic duplicate detection; house trend agent seeding launches; full PSRO or simultaneous multi-agent training.

**Future ideas (out of hackathon scope)**
- Competing learned markets: people submit their own makers to compete under shared rules (a simulated league first).

## Open

- [ ] Chart-health weights; markout horizon h; maker reward weights
- [ ] Maker share-of-volume caps
- [ ] Maker quotes in the line or only on the board?
- [ ] One maker policy across coins or per coin; shared vs isolated reserves
- [ ] Where timers, board state and the stage manager run
- [ ] Who decides two memes are the same
- [ ] Maker's starting inventory (no creator allocation). Candidates:
    - Launch fee funds the maker's SOL, and it buys in the opening batch like anyone else (starts bid-only until it fills).
    - A small, published per-coin mint to the maker reserve (a maker allocation, not a creator one).
    - The maker accumulates inventory by quoting in the line before seating.

Sources: [MemeTrans](https://arxiv.org/abs/2602.13480), [Spooner et al.](https://arxiv.org/pdf/1804.04216), [RL in finance review](https://arxiv.org/pdf/2411.12746), [Polymarket-v1 market quality](https://arxiv.org/pdf/2606.04217), [CoinGecko survival study](https://cryptobriefing.com/pump-fun-token-survival-rate-study/), [SB3 v2.9.2](https://github.com/DLR-RM/stable-baselines3/releases/tag/v2.9.2), [BenchMARL](https://arxiv.org/html/2312.01472v3).
