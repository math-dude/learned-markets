# Evaluation, November 20

First graded results from the simulator. Every number comes from the crowd model in `packages/simulation`, which is uncalibrated in the ways that matter most (how people respond to fees, caps and choice of coins), so read these as directional. Raw reports are written to `artifacts/eval/` by `learned_markets_training.evaluate` and `evaluate_auction`.

## Markets compared

| Name | What it is |
| --- | --- |
| Pump, sequential | pump.fun's bonding curve, flat 1% fee, no caps, orders executed one at a time with scripted bots first |
| Pump curve in batches | The same curve as the quoter inside our batch auction, no caps |
| Rule-based | Our mechanism with the fixed stand-in quoter and terms |
| Trained v3 | Our mechanism with the quoter trained by PPO for 200M steps (about 8 minutes on one RTX 5060 Ti) |

## Quoter: standard run

64 worlds × 2,000 batches, held-out seed 20001, attackers active at random. Reward is the training reward (distinct people trading × price accuracy); everything else is grading only.

| Metric | Pump, sequential | Pump curve in batches | Rule-based | Trained v3 |
| --- | --- | --- | --- | --- |
| Reward per batch | 0.357 | 0.354 | 0.212 | 0.322 |
| Tracking error to true value (log) | 0.67 | 0.68 | 0.68 | 0.68 |
| Top-10 holder share | 16.1% | 16.1% | 7.2% | 6.8% |
| People trading per coin per batch | 2.47 | 2.39 | 1.48 | 1.90 |
| Variance ratio (10 batches) | 1.02 | 1.21 | 0.82 | 1.45 |
| Transient volatility | 0.012 | 0.010 | 0.020 | 0.021 |
| Largest gaps (99.9th percentile, log) | 0.23 | 0.22 | 0.42 | 0.52 |
| Share of coin-batches in a 90% collapse | 0.009% | 0.007% | 0.013% | 0.80% |
| Half-recovered within 60 batches | 56% | 57% | 30% | 37% |
| Price impact per SOL (Amihud) | 16 | 13 | 23 | 74 |
| Noise-trader profit per person (SOL) | −0.96 | −0.92 | −0.55 | −0.49 |
| Retail profit per person (SOL) | −0.40 | −0.33 | −0.27 | 0.00 |
| Informed profit per person (SOL) | +0.42 | +0.53 | +0.45 | +0.78 |
| Trapped when coins die (SOL per world) | 386 | 386 | 140 | 209 |

- **The trained quoter beats the rule-based one** on the reward by about 52%.
- **It does not beat pump on the reward** (about 10% lower).
- **It is fairer:** holder concentration is under half of pump's, retail breaks even, informed traders earn more, and about 46% less money is trapped in dead coins.
- **It is jumpier:** gaps are more than twice pump's, 90% collapses are far more frequent and price impact is about five times higher. The reward has no term for smoothness.
- **Tracking error is the same everywhere.**

## Quoter: behaviour scenarios

Two attacker seats per world run one script each (32 worlds × 1,200 batches).

| Scenario | Pump, sequential | Rule-based | Trained v3 | Reading |
| --- | --- | --- | --- | --- |
| Hoarder: top-10 share | 19.3% | 7.6% | 7.3% | Prevented by the cap |
| Large dump: exit fee charged | 1.0% | 11.0% | 2.8% | The trained quoter charges less than the rule; the "learns to charge dumps" check fails |
| Sniper: profit per seat (SOL) | −0.84 | −0.55 | +0.10 | Slightly profitable under the trained quoter |
| Stale-quote picker: profit per seat (SOL) | +0.44 | +0.26 | +2.34 | The trained quoter is easier to pick off |
| Pump-and-dump: profit per seat (SOL) | −100 | −5.2 | −3.7 | Not informative: the script buys at any price and caps only limit its loss |
| Wash pair: profit per seat (SOL) | −0.36 | −0.66 | −2.74 | Unprofitable everywhere |

The scripted attackers are too crude to show that attacks pay less here than on pump. Only the hoarding result is clean.

## Auction network: lever policies

Quoter v3 frozen; 64 worlds, 28 epochs with the first 12 excluded, seed 30001. "Open door" means no launch fee and no line cap. Cut rounds are a fixed mechanic and run under every policy, so once slots fill, all policies list about three coins per epoch.

| Policy | Slots | Launch rate | Reward | People per batch | Price accuracy | Live coins | Trapped (SOL per epoch) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Trained network | 32 | 1× | 0.453 | 20.4 | 0.277 | 13.7 | 29.6 |
| Stand-in levers | 32 | 1× | 0.398 | 18.4 | 0.283 | 9.4 | 25.2 |
| Open door | 32 | 1× | 0.460 | 21.0 | 0.240 | 25.8 | 36.7 |
| Open door | 64 | 1× | 0.413 | 21.0 | 0.235 | 56.9 | 35.9 |
| Trained network | 32 | 5× | 0.450 | 20.1 | 0.271 | 13.2 | 34.7 |
| Stand-in levers | 32 | 5× | 0.438 | 20.1 | 0.275 | 13.2 | 31.1 |
| Open door | 32 | 5× | 0.436 | 20.7 | 0.229 | 26.3 | 41.3 |
| Open door | 64 | 5× | 0.412 | 21.1 | 0.219 | 58.1 | 43.8 |

- The trained network pushes the launch fee to its floor and runs a somewhat longer line than the stand-in. The table above is seed 30001 alone.
- Across three seeds (reward, mean ± standard deviation):

| Policy | Slots | Launch rate 1× | Launch rate 5× |
| --- | --- | --- | --- |
| Trained network | 32 | 0.447 ± 0.006 | 0.438 ± 0.010 |
| Stand-in levers | 32 | 0.402 ± 0.004 | 0.442 ± 0.004 |
| Open door | 32 | 0.446 ± 0.013 | 0.435 ± 0.003 |
| Open door | 64 | 0.417 ± 0.012 | 0.403 ± 0.013 |

- The network's edge over the stand-in holds only at the normal launch rate. It ties a 32-slot open door at both rates and beats a 64-slot one by 7–9%.
- In this crowd model, more coins bring more people trading, which is why the open door does well. Whether that is realistic is unknown.

## Environment faults found along the way

These changed the numbers materially and are worth knowing when reading older logs:

- True value grew without bound against a finite crowd; attention now saturates.
- The crowd's money drained into reserves and dead coins; people now receive a steady outside inflow, and profits are reported net of it.
- The rule-based quoter lowered its ask one tick per idle batch and walked thin coins down; it now steps once per five idle batches.
- The quoter's ask could not sit below the last price, so an unsold launch could never reprice.

## Quoter with a smoothness term

The reward gains a charge on the part of a single-batch price move beyond 2% (log), times a weight. Two quoters were trained for 200M steps each and graded on the same standard run as v3. "Reward" below is the original people-and-accuracy term without the charge.

| Metric | Pump, sequential | Trained v3 (no term) | Weight 1 | Weight 5 |
| --- | --- | --- | --- | --- |
| Reward per batch | 0.357 | 0.322 | 0.309 | 0.297 |
| Tracking error to true value (log) | 0.67 | 0.68 | 0.53 | 0.57 |
| Largest gaps (99.9th percentile, log) | 0.23 | 0.52 | 0.42 | 0.30 |
| Share of coin-batches in a 90% collapse | 0.009% | 0.80% | 0 | 0 |
| Transient volatility | 0.012 | 0.021 | 0.019 | 0.009 |
| Price impact per SOL (Amihud) | 16 | 74 | 123 | 51 |
| Half-recovered within 60 batches | 56% | 37% | 29% | 33% |
| Top-10 holder share | 16.1% | 6.8% | 7.0% | 7.2% |
| Retail profit per person (SOL) | −0.40 | 0.00 | −0.23 | −0.15 |
| Informed profit per person (SOL) | +0.42 | +0.78 | +0.57 | +0.68 |
| Trapped when coins die (SOL per world) | 386 | 209 | 183 | 175 |
| Tracking error after information jumps | 0.45 | 0.50 | 0.44 | 0.45 |

- **It works on what it targets.** At weight 5 the largest gaps fall from 0.52 to 0.30 (pump: 0.23), 90% collapses disappear and transient volatility drops below pump's.
- **Tracking error improves** from 0.68 to 0.53–0.57, better than pump, and real news is not slowed: tracking error after information jumps matches pump.
- **It costs some reward** (4–8% on this seed; on a second held-out seed the weight-5 quoter scored 0.342 against 0.329 for v3, so the cost is within seed noise) and retail goes from break-even to a small loss, still less than on pump.
- **Price impact stays well above pump** (3× at weight 5), and recovery after drops is no better.
- One seed per configuration; the scenarios were not rerun for these quoters.

## Open

- Whether the smoothness term should join the decided reward, and at what weight.
- The wallet-class breakdown from pump data is not trusted and is not used.
