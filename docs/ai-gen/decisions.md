# Decisions

Status: **decided** · **leaning** · **proposed** · **open** · **rejected**. Newest changes noted in `docs/ai-gen/sessions/`.

## Decided

| Decision | Date | Notes |
| --- | --- | --- |
| Guiding principle: profit from predicting memes, not from speed, sniping or splitting supply | 2026-11-16 | Check every mechanism against it |
| Solve industrial deployment (copies of the same coin) | 2026-11-16 | Mechanism: duplicates merge (see below) |
| Solve sniping: launch speed is not an edge | 2026-11-16 | |
| No hidden supply, no multi-account buying | 2026-11-16 | |
| Manual trading only: no bots, no API, no automated copy-trading | 2026-11-17 | Enforcement open |
| One wallet per person via identity attestation (World ID, SAS or similar) | 2026-11-19 | Replaces wallet-cluster detection |
| No trading on outside venues; transfers restricted to our venue (Token-2022) | 2026-11-19 | |
| Duplicate coins merge into one coin per meme | 2026-11-19 | Who judges "same meme" is open |
| Manual trading only still holds | 2026-11-19 | Reconfirmed |
| Launching a rookie coin costs a dynamic fee that rises with how many people are launching | 2026-11-19 | Mechanism proposed in `docs/ai-gen/design/board-and-timers.md` |
| Two separate networks: the auction network (= stage manager) and the quoting network (= maker) | 2026-11-19 | Replaces the old "referee head vs stabilizer head" split |
| The launch fee belongs to the auction network | 2026-11-19 | Fixed rule as v0 default; the auction network learns it |
| User and maker curves clear together in a single batch auction | 2026-11-20 | Both contribute to the clearing price and can receive fills in the same clearing pass |
| If several prices maximize executed volume, choose the one nearest the previous clearing price | 2026-11-20 | The opening reference price and equal-distance tie-break are open |
| Apply learned trading terms to every fill in the venue | 2026-11-20 | The quoter sets the policy. The auction clears at one gross price, with applicable per-trader fees and holds regardless of counterparty. Test the alternative of applying personalized terms only through the quoter’s spread after the hackathon. |
| An order is a curve; the curve family is not restricted | 2026-11-20 | Piecewise linear is a common family for testing, not a constraint on the design |
| The auction network never picks or kills individual coins | 2026-11-20 | Reconfirmed. It sets room-level levers only |
| Every lever is owned by a learned policy, with a fixed rule behind the same interface for testing and as a fallback | 2026-11-20 | See the lever table below |
| The line stays, with a cap; the coldest coins are cut in fixed rounds | 2026-11-20 | Ranked by heat. Newcomers get a grace period before they can be ranked. Holders of a cut coin lose their stake, kept small by the per-person line cap |
| The auction network learns the launch fee | 2026-11-20 | Fixed stand-in: the fee follows how full the line is |
| No one may hoard a coin's supply | 2026-11-20 | Learned by the quoter through per-person capacity. Fixed stand-in: a hard ceiling (2% of supply as a sim placeholder) |
| Rookie coins trade wilder than established ones | 2026-11-20 | Bigger price moves are allowed. Dumping right after buying is still discouraged, and hoarding is never allowed |
| The quoter's budget for a coin has two buckets | 2026-11-20 | Safe bucket: that coin's own fees plus its launch-fee share, kept separate per coin. Risk allowance: extra house money behind the coin, zero by default. Raise the allowance if the safe bucket alone proves too restrictive |
| The submission's RL environment covers one coin's whole life, starting in the line | 2026-11-20 | The rest of the line is simulated as background competition for the cut |
| The quoter is the launch: a coin's unissued supply starts with the quoter, which releases it through its own sell curve in the batch auction | 2026-11-20 | No launch formula and no opening event. Bids set the price each batch, the per-person cap limits size, and sale money goes to that coin's safe bucket. Fixed stand-in: a set amount offered per batch at whatever clears. Total supply and every release are public |
| Both networks are trained for the submission | 2026-11-20 | Quoter first against fixed stand-ins, then the auction network against the frozen quoter. The auction network needs a lighter many-coin environment |
| The auction network trains all of its levers | 2026-11-20 | Launch fee, line size, seat count, rookie seats, timer drain rate and timer cap. Not narrowed for the submission; rent more compute if needed |
| The quoter has no holding limit | 2026-11-20 | The only constraint is that the market must not become a honeypot |
| Trading terms may depend on anything about a person | 2026-11-20 | First implementation uses only their position and how recently they bought |

## Leaning / tentative

| Decision | Lean | Notes |
| --- | --- | --- |
| Market structure | Dual flow batch auction where every order is a curve | Launch curve is one maker order, learned maker another |
| Maker's role | Damp short-lived price shocks with a capped share of trading volume | |
| Where clearing runs | Off-chain auctioneer, on-chain settlement, public verification | 2026-11-20: the program likely only settles, so Rust does not need to reproduce the clearing math |
| Graduation from rookie to regular | Earned by activity, not a fixed number of hours | 2026-11-20. The activity measure and threshold are open |
| Deployer reward | A small cut of the coin's trading fees, paid only after the coin earns a seat | 2026-11-20. Idea to consider later: also pay successful deployers from fees collected by coins that died. Not from sale money, which would pay for launching whether or not the meme lasts. Who counts as the deployer after a merge is open. Fee sharing needs legal advice before real money |
| Fee split | Platform and quoter reserve for now | 2026-11-20. Numbers are placeholders |
| Money left by a cut or dead coin | Survivors, the platform and successful deployers | 2026-11-20, "probably". Under quoter-as-launch the reserve is mostly buyers' sale money, so redistributing all of it can look like a honeypot; returning the unspent sale money to holders was raised and not decided |
| Reward for both networks | Distinct people who traded in the batch, each weighted by how close the price was to the meme's hidden true value; the auction network sums it across coins | 2026-11-20, to try. No profit term. The auction network counts each person once per batch across the platform, so adding coins earns nothing unless it brings new people; this needs a finite crowd with limited attention in the sim. Untested combination; check that a trained quoter beats the plain baseline and the rule-based quoter, and that it learns to charge large dumps. Hoarding needs one extra penalty or the hard stand-in |
| Coin survival | Countdown timer + replicator dynamics (drain = board-average activity) | Tentative yes, 2026-11-19 |
| Deployment | List cheaply, let the timer decide; new coins start in the line | Proposed 2026-11-19 |
| Who decides coin death | Public timer rules, never the maker | The auction network not picking coins is decided (2026-11-20); the timer rule itself is still tentative |
| Fees and holds | One formula: base + sell-speed term + soft hold (decaying exit fee). Learned terms apply venue-wide. A fixed shared schedule is the submission fallback. | 2026-11-20 |
| Stress handling | Same mechanism with tighter parameters, public trigger rules | |
| Public record timing | Coarse now, full detail after each epoch | |
| Multi-agent training | Scripted attackers first, PSRO-lite as stretch | |
| Last look for the maker | Drop it | Honeypot-shaped |

### Sealed batch auction for v0 (tentative, 2026-11-20)

Before each batch opens, the quoter commits to a firm, two-sided curve using completed-batch data, public signals, and its own balances. Prices and sizes on the quoter’s curve stay hidden, and incoming user orders stay hidden from other traders and the quoter. The quoter can’t revise or withdraw its curve during the batch. Trader-side verification of the commitment is deferred beyond v0.

At the cutoff, the auctioneer clears user and quoter curves together at one price. The proposed allocation gives users and the quoter equal priority, fills better-priced orders first, and allocates ties at the clearing price pro rata. Traders see their applicable fee and hold terms before submitting. Fills are published, with clearing inputs disclosed on the agreed audit schedule.

### Quoter action space and market constraints (2026-11-20)

- **Funded orders.** Available cash and inventory limit what each account can spend or sell. This is a ledger invariant.
- **Maker exposure (leaning).** Treat exposure limits as configurable hyperparameters. The form and values of the limits are open.
- **Per-person trading capacity (preferred direction).** The quoter sets the coin-wide trading-capacity policy within the market's configured hyperparameters. The policy uses coin age and can use identity-linked positions and recent fills to set per-person capacity. Stricter inventory limits for rookie coins are the intended behavior. A simple heuristic can serve as a baseline for the same interface.
- **Fee and hold bounds (decided direction).** The quoter learns the fee and soft-hold bounds. The exact parameterization and training objective are open.
- **Revenue (working model).** Start with a fixed fee on executed trades and room for a learned early-exit surcharge. Track platform fee revenue, fees allocated to the maker, and maker trading P&L separately. Revisit the fee model and the split as we evaluate the market.

### Learned levers and their fixed stand-ins (2026-11-20)

| Lever | Learned by | Fixed stand-in |
| --- | --- | --- |
| Launch fee | Auction network | Fee follows how full the line is |
| Line size | Auction network | Constant |
| Per-person holding cap (hoarding) | Quoter | Hard ceiling, 2% of supply as a sim placeholder |
| Quoter risk allowance per coin | House setting | Zero |
| Exit fee and hold | Quoter | Constant schedule |
| Quoter's price curve | Quoter | Rule-based lean against flow |
| Release of unissued supply | Quoter, through its sell curve | A set amount per batch at whatever price clears |

Hold time and capacity are expressed through the quoter's curve taking an identity parameter, so they are outputs of one function and not separate rules. Coin stage and age are inputs to the quoter, which learns how rookie terms differ from established ones.

Fixed mechanics, not learned: curve orders clear at one price; the line cap, cut rounds and grace period; graduation earned by activity.

## Open

- Sim placeholders to tune: cut round length, grace period, line size, per-person line cap, heat formula, seating and graduation thresholds, timer parameters, batch interval, whether limit prices include fees, integer rounding, opening price for a new coin, launch-fee share to the quoter, trader types and how they react to fees, how a meme's true value moves
- Whether a person's rookie buying is limited across all coins per day, so backing one rookie means passing on another
- Length of the cut round and of the newcomer grace period; whether line coins are shown to users
- Maker reward formula (markout-based direction; weights, horizon h)
- Stage manager reward formula
- Healthy-chart weights (proposed definition exists)
- Maker caps on share of volume (X% per batch, Y% per epoch)
- Batch interval (slot-aligned ~400 ms–1 s for now)
- Order types: curve families and per-batch caps; paced (TWAP) orders
- Outside makers allowed, or only our maker quotes? (Unsure. Sole quoter: cleaner product, but more honeypot/house-wins scrutiny and all liquidity risk on us. Outside makers: more depth, but they compete with and can pick off our maker.)
- Who keeps surplus above the safety buffer (now interacts with dead-coin reserves)
- Where timers, board state and the stage manager run (suggest: off-chain, published)
- One maker policy across coins or per coin; shared or isolated reserves (v0: isolated)
- Does the maker quote in the line?
- Who decides two memes are the same (automatic similarity vs human call)
- "Wealth tax": sell tax (assumed) or holding tax on large positions?
- Manual-trading enforcement
- Sim parameters: S, P, A, k, timer cap, epoch length, line cap per person, reserve split

## Rejected (don't re-propose without new reasons)

| Idea | Date | Why |
| --- | --- | --- |
| Explicit slot bidding / periodic slot auction for listing | 2026-11-19 | Not fun, not cold-start friendly |
| Harberger slots | 2026-11-19 | A second pricing mechanism to explain |
| Proposer bond (incl. dominant assurance contract) | 2026-11-19 | User: "lowkey a stupid idea" |
| Presales of any kind | 2026-11-19 | Not wanted |
| Maker decides which coins die | 2026-11-19 | Conflict of interest (holds inventory), centralisation / honeypot accusations, gameable |
| Maker bidding in the slot auction | 2026-11-19 | Bidding rejected altogether |
| Wallet-cluster detection as the main sybil defence; "slow rather than ban" flagged clusters | 2026-11-19 | Superseded by identity attestation |
| AMM pool + per-order signed quotes from a gateway | 2026-11-19 | Superseded by batch auction with curve orders |
| Hard migration graduation (pump.fun style) | 2026-11-19 | Replaced by line → board → timers |
| Hard lock holds | 2026-11-19 | Honeypot-shaped; soft hold (decaying exit fee) instead |
| House deploys coins directly | 2026-11-19 | Issuer/legal risk, IP and likeness risk, conflict of interest. A house agent may only seed suggestions (v2) |
| Low volatility as the "boring" signal | 2026-11-19 | Rewards pump-and-dumps |
| Jito BAM alignment / plugin | 2026-11-19 | Faded: out of scope |
| Referee head vs stabilizer head (walled inputs) | 2026-11-19 | Clearing is mechanical; replaced by auction network + quoting network |
| Gemini Prediction Markets bounty | 2026-11-19 | Not relevant |
| Maker's starting inventory as a free config parameter | 2026-11-20 | Inventory has to come from how the rookie market starts |
| A 0-to-1 maturity score per coin driving all terms | 2026-11-20 | Too specific. Keep the rookie and established stages from the seating precedents and let the quoter learn the terms |
| Bonding curve as the launch | 2026-11-20 | A formula-set price is too passive. Kept only as the plain baseline to compare against |
| IPO-style opening auction | 2026-11-20 | Tried before and boring |
| "The drop": equal fixed-price bags claimed with limited daily claims | 2026-11-20 | No price discovery at entry; conviction can't be sized. The rising-fee variant is a bonding curve counted in people |

## Future ideas (out of hackathon scope)

| Idea | Notes |
| --- | --- |
| Competing learned markets: people submit their own makers to compete under shared rules | Fits PSRO (submissions become the population); could start as a simulated league |
