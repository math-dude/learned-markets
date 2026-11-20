# Environment build

Build session on November 20, following the [environment design handoff](2026-11-20-environment-design-handoff.md). It produced the market core, the simulator, the training and evaluation code, and the backend auctioneer. The [decision log](../decisions.md) lists the implementation choices; this note gives the reasons and what was found.

## What exists now

| Package | Contents |
| --- | --- |
| `packages/core` | Tick grid, ledger, curve orders, uniform-price clearing, trading terms, quoter interface and stand-ins, lifecycle, public tape, settlement records. Torch only |
| `packages/simulation` | Memes and regimes, crowd, six scripted attackers, the world loop, reward, chart-health metrics, pump.fun calibration scripts |
| `packages/training` | SB3 adapters, quoter and auction-network training, four-market evaluation, export |
| `apps/backend` | Auctioneer for one market on the same core, HTTP API, swappable clock, parity fixture generator |

The backend never imports the simulator. The quoter's observation lives in the core (`Tape`), so the trained network sees the same inputs in training and in production.

## Why the choices were made

- **Tick grid.** Clearing becomes two sums and an argmax in integers, exact and batched across thousands of coins. Sampling a 16-point payload curve onto ticks is deterministic.
- **Integer units.** Whole tokens, lamports and micro-lamports per token keep every product inside 64 bits for any fill up to the 2% holding ceiling. The quoter's cash is always the sum of its counterparties' cash, so cash is conserved exactly.
- **Exit terms locked at the buy.** The first draft priced the exit fee from the quoter's current parameters, which would let it raise fees on people who had already bought. That is honeypot-shaped, so the schedule is now fixed when the position is bought.
- **Ask may sit below the last price.** With the ask held at or above the last price, a launch nobody wanted could never find a lower price. The quoter now places its ask up to 16 ticks either side, with its bid always below the ask.
- **Action as a correction to the rule.** Starting from the stand-in gives PPO a working market on step one, and a zero output is exactly the fallback.
- **One environment.** With every coin on the shared policy, the "background line" is real competition for a finite crowd, and each coin's life is training data. The auction network needs no cheaper approximation of the quoter, because the frozen quoter is one batched forward pass.

## Batch-auction rules and their tests

Each rule from the sealed-batch section of the decision log has a test in `packages/core/tests`, `packages/simulation/tests` or `apps/backend/tests`:

- Clearing matches a plain-Python reference on random books; both sides execute exactly the maximal volume; no fill exceeds its curve; better-priced quantity fills first.
- The quoter has no priority: moving its bid into a user order changes no fill beyond the rotating residue.
- Cash and tokens are conserved, nothing goes negative and no holding exceeds the ceiling, under random orders with a random quoter, for every market type and every attacker script.
- Exit terms do not change after the buy; selling is never blocked and the fee never exceeds 25%; a lowered cap blocks buys and never forces a sale.
- People's orders are identical whether or not the quoter's curve is zeroed, so nothing leaks from the committed curve.
- A second order from the same person for the same coin in one batch is rejected.
- The parity fixture replays to the same balances using only the arithmetic in [settlement-interface.md](../design/settlement-interface.md).

## Calibration from pump.fun

Pump data calibrates the simulator and is never replayed as flow, because recorded trades cannot react to our fees and caps.

- **Attention.** Clustering 724,686 launches by name gave 3,289 memes with at least 20 copies. Launch bursts are bot-driven and decay in minutes, so decay is fitted from distinct buyers in 5-minute bins instead: median half-life about 12 minutes, median burst about 70 minutes, and 1.8 bursts per meme on average within the 17-day window.
- **KOL wallets.** 378 wallets from kolscan.io; 166 trade in epoch 1088.
- **Wallet labels** (bot, terminal, user) were still being computed when this note was written, so the buyer statistics include bots.

Only the half-life feeds the simulator so far. How people respond to exit fees and caps cannot be measured from pump data, so those sensitivities are drawn from wide ranges per world.

## Results

See [results](../results/2026-11-20-evaluation.md).

## Known weaknesses

- **True value is an assumption.** The reward is scored against a hidden value that exists only in the simulator.
- **The crowd has no bots,** one order per person per batch, and nobody can short, so prices sit above the average view when supply is scarce.
- **Scripted attackers are simple.** They lose money in every market tested, including the pump baseline, so they do not yet show that an attack is less profitable here than on pump.
- **The reward has no smoothness term.** A quoter trained on it is not pushed toward small gaps or low price impact.
- **A sim batch stands for about 10 seconds;** production batches are faster.
