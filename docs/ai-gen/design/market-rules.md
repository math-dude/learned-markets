# Market rules

Cleaned from the team doc "Learned Markets: RL & System Design" (2026-11-19). Sections that described the earlier AMM-plus-signed-quotes design were removed; see `docs/ai-gen/decisions.md` → Rejected.

## Thesis (team views, not established findings)

1. **Demand is real, the structure is broken.** Memecoins get huge retail attention, but their violent, toxic structure limits adoption.
2. **Prices don't track the meme.** A memecoin's price doesn't directly track the attention its meme gets.
3. **Violence comes from behaviour, not the meme.** Bad actors, bad deployers and herding drive the swings; this needs policing to an extent.
4. **A non-toxic memecoin market is a learning problem**, not something fixed rules can fully specify.
5. **Fun and financially viable.** A fun exchange that also makes money for the exchange.
6. **More creative than first-in-first-out.** A FIFO order book is one design choice among many.

## Design principles

1. **Damp the speed of price moves, not the level.** Price still reaches wherever sustained flow pushes it, just more slowly. No defended level for attackers to target.
2. **Stay a market, not a referee.** Informed traders and early buyers must still make money. The system never pins a price.
3. **Guardrails beat the model.** Loss budgets, inventory caps and a kill switch are enforced on-chain and can't be learned around.
4. **Everything on the record.** Fills on-chain; clearing inputs and outputs in a public, hash-committed log.
5. **One math, one schema.** Simulator and program share identical clearing math and a single event schema, so real trading replays exactly through the simulator.

## Market structure (leaning)

**Dual flow batch auction where every order is a curve.**

- Each order is a supply or demand function over price for the next batch. The auctioneer sums the curves and selects one price that maximizes executed volume.
- A discrete limit order is a step function. The launch curve is a smooth curve order. An outside maker's ladder is piecewise linear. **The learned maker posts its own curve each batch; that curve is its RL action.**
- User and maker curves clear together in one batch. Both contribute to the clearing price and can receive fills in the same clearing pass.

**Constraints that keep it buildable and safe**

1. **A few fixed curve families only:** step, piecewise linear, constant-product segment, bonding curve. Arbitrary functions make clearing harder to compute and verify, and break Python/Rust math parity. v0: piecewise linear only.
2. **A per-batch size cap on every curve order.** Without it a dumper slides a whole curve in one batch.

**Clearing price.** If several prices maximize executed volume, use the one closest to the previous clearing price. The opening batch needs an explicit reference price. The rule for choosing that reference and the tie-break for equally close prices are open.

**Clearing details to make concrete (v0).** The proposed search uses bisection on net demand. At the selected price, the proposed fill rule allocates tied orders pro rata.

**Batch interval (open):** slot-aligned (~400 ms to 1 s) for now. Batches are short-lived. (Jito BAM alignment was considered and dropped.)

**Where clearing runs (leaning):** off-chain auctioneer, on-chain settlement, public verification.

## Fees and holds (proposed)

One fee formula covers the sell tax and the hold.

```
fee = f_base + f_speed(sell rate) + f_hold(time since buy)
```

- **Speed term (sell tax):** grows with how fast a person sells relative to their holdings and the batch's depth.
- **Hold term (soft hold):** an exit fee decaying to zero over the hold period. Selling is always possible, just costlier early (like IPO penalty bids).

**Preferred design.** The market publishes a curve that maps order inputs to an output size and trading terms.

```
(identity, size_in, price action) → (size_out, soft-hold duration, initial early-exit fee, other constraints)
```

Traders in the same batch can receive different terms. The market's action is to choose the mapping or its parameters. A fixed mapping can support the same interface before learning is ready. Traders see the terms before committing, including how the terms depend on fill size when the batch can partially fill an order. The applicable schedule is fixed at fill, subject to the danger-zone release below.

The quoter sets this policy before the batch. The auctioneer applies the applicable terms to every fill, including trades between users. Each batch has one gross clearing price, and per-trader charges determine what each trader pays or receives net. After the hackathon, test the alternative of applying personalized terms only through the quoter’s own spread.

**Submission fallback.** If there isn't time to implement the preferred curve, publish one soft-hold duration and early-exit fee schedule for everyone in each batch. Use a fixed rule to set those terms.

**Rules at every stage**

- **Danger-zone release:** when a coin's timer enters the danger zone, the hold term drops to zero.
- **Decay, never a cliff,** so one batch's buyers don't all unlock and dump together.
- **Revenue doesn't feed the setter's reward,** or it learns to overcharge.
- **Sim traders react** to fees and holds (demand elasticity), or any learned setter maxes them out.

| Stage | Setter | Granularity |
| --- | --- | --- |
| v0 (fixed rule) | Fixed published mapping | Per-order terms if ready, shared batch schedule for the submission fallback |
| v1 | Stage manager per epoch (published, bounded); optionally maker within a narrow per-batch band | Shared parameters, with per-order terms when the preferred mapping is available |
| v2 (goal) | Learned mapping or learned parameters | Schedule set at fill using identity, size and price action |

Open: "wealth tax" = sell tax (assumed here) or a holding tax on large positions?

## Stress handling (leaning)

Same mechanism, tighter parameters (smaller per-batch caps, longer batches), public trigger rules. No separate circuit-breaker mode.

## Economics and safety

The maker stays solvent only if

```
noise profit + fee share ≥ informed losses + adversarial losses
```

**Levers**

- **Fee share to the reserve:** frenzied periods fund it most, exactly when needed.
- **Speed, not level:** the maker slows moves; it never defends a price (avoids the Olympus/Terra failure mode).
- **Hard on-chain caps:** epoch loss budget, inventory limits, max share of volume, kill switch.
- **Small randomization:** a deterministic response can be learned and exploited; slight noise makes probing expensive.

**People must be able to make money**

- Informed traders profit by design: the `InfoShock` test must show them still earning, with small price-discovery lag.
- The system taxes speed-of-selling and concentration, not direction. Buying early into a token that goes up is fine.
- Cap the maker's share of volume (X% per batch, Y% per epoch; open).
- Reserve profit is a constraint (break even or slightly positive), not the goal. Publish the reserve's PnL.
- Report trader PnL by type: informed, momentum and retail should do comparably or better than on a plain curve; only attackers do worse.

## Public record

- **Fills:** the program emits a structured event on every fill (use `emit_cpi!`, not plain logs, which can be truncated).
- **Clearing log:** every batch's input curves, clearing price and fills go to an append-only public log, with the maker's model version.
- **Commitment:** at each epoch boundary, a Merkle root of the epoch's log is committed on-chain.
- **Delayed detail:** coarse data live; full maker features and scores published after the epoch closes, too late to game.
- The record uses the simulator's event schema, so it doubles as training and evaluation data.

## Risks

- **RL doesn't converge in time.** Ship the rule-based maker end to end first; learning is an upgrade.
- **Adversarial training cycles without improving.** Keep PSRO to 2–3 iterations; evaluate against the whole population.
- **Sim-to-chain mismatch.** Golden-vector parity tests in CI; any math change touches spec, Rust, Python and vectors together.
- **Anchor 1.2 builds sBPFv3 by default.** Deploy hello-world to devnet on day 1; fall back to `--arch v0` if rejected.
- **Regulatory.** Fee-sharing or house-launched tokens can look like securities; get advice before real money.

## Prior art (DFBA)

Jump's [dual flow batch auction proposal](https://jumpcrypto.com/writing/dual-flow-batch-auction) (Aug 2025), [Ambient on Fogo](https://www.fogo.io/blog/dual-flow-batch-auctions-on-fogo), [Superluminal's Prism](https://dourolabs.notion.site/What-is-Superluminal-33f3e0276d93830e8a5901f4130a1afc), Archer Exchange ([Colosseum](https://docs.colosseum.com/copilot/examples/mev-batch-auctions)). Flow trading: [Budish et al., NBER w31098](https://www.nber.org/papers/w31098). AMM curves in batch exchanges: [Ramseyer, Goel, Mazières](https://ar5iv.labs.arxiv.org/html/2210.04929). Our novelty is the learned maker with a market-quality mandate plus the board, not the auction itself.
