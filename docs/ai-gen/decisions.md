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

## Leaning / tentative

| Decision | Lean | Notes |
| --- | --- | --- |
| Market structure | Dual flow batch auction where every order is a curve | Launch curve is one maker order, learned maker another |
| Maker's role | Shock absorber with a mandate: absorbs leftover imbalance, never the main counterparty | |
| Where clearing runs | Off-chain auctioneer, on-chain settlement, public verification | |
| Coin survival | Countdown timer + replicator dynamics (drain = board-average activity) | Tentative yes, 2026-11-19 |
| Deployment | List cheaply, let the timer decide; new coins start in the line | Proposed 2026-11-19 |
| Who decides coin death | Public timer rules, never the maker | User not 100% sure; revisit if needed |
| Fees and holds | One formula: base + sell-speed term + soft hold (decaying exit fee). v0 fixed rule; goal: learned, per person | 2026-11-19 |
| Stress handling | Same mechanism with tighter parameters, public trigger rules | |
| Public record timing | Coarse now, full detail after each epoch | |
| Multi-agent training | Scripted attackers first, PSRO-lite as stretch | |
| Last look for the maker | Drop it | Honeypot-shaped |

## Open

- Maker reward formula (markout-based direction; weights, horizon h)
- Stage manager reward formula
- Healthy-chart weights (proposed definition exists)
- Maker caps on share of volume (X% per batch, Y% per epoch)
- Batch interval (slot-aligned ~400 ms–1 s for now)
- Order types: curve families and per-batch caps; paced (TWAP) orders
- Outside makers allowed, or only our maker quotes? (Unsure. Sole quoter: cleaner product, but more honeypot/house-wins scrutiny and all liquidity risk on us. Outside makers: more depth, but they compete with and can pick off our maker.)
- Where the maker's starting inventory comes from (a maker can't sell what it doesn't hold; no creator allocation). Unknown; candidates in `docs/ai-gen/design/rl-formulation.md` → Open
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

## Future ideas (out of hackathon scope)

| Idea | Notes |
| --- | --- |
| Competing learned markets: people submit their own makers to compete under shared rules | Fits PSRO (submissions become the population); could start as a simulated league |
