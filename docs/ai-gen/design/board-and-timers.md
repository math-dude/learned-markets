# Board, line and timers

Proposed 2026-11-19, not decided (timer + replicator rule is a tentative yes). Coins live on a board with limited seats; a public timer decides when each one dies; an RL stage manager shapes the board but never picks which coins live. All numbers are placeholders for the sim. Assumes one verified person = one wallet and no trading outside our venue.

## Why

We don't want a million coins on the platform, and coins that get boring should effectively be delisted. Most launches die anyway: on pump.fun 68.7% of 18.67M tokens made their last trade on launch day (CoinGecko). Futures exchanges show the same pattern and handle it by listing cheaply and delisting dormant contracts mechanically. So: **list cheaply, let activity decide, delist mechanically.**

## Pieces

- **Line:** where every new coin starts. Real trading with a small per-person cap. Not a presale; a low-stakes lower division.
- **Board:** S seats where coins trade normally, with the learned maker absorbing leftover flow.
- **Rookie seats:** P of the S seats reserved for coins younger than A hours (like airline protected seats).
- **Auction network (stage manager):** RL agent that sets S, P, the drain multiplier, the timer cap and the launch fee (see `rl-formulation.md`).

## A coin's life

1. **Launch.** Any verified person launches a meme and pays the launch fee (below). A duplicate merges into the existing coin. New coins enter the line. No creator allocation.
2. **Heat.** Line trading builds heat, counted as fees from distinct people.
3. **Seating.** Each epoch (e.g. hourly), the hottest line coins take open rookie seats. Each seated coin opens with a single batch auction at one clearing price (no sniping).
4. **Timer.** Each batch: `timer += k × breadth − drain`
   - **Breadth** = Σ over people of √(fees each paid this batch). Ten people paying 1 SOL beat one whale paying 10 (quadratic-funding idea: Buterin, Hitzig, Weyl).
   - **Drain** = k × board-average breadth × stage manager's multiplier. Above-average coins gain time, below-average lose it (replicator dynamics). Works at any platform volume.
   - **Capped** (e.g. 48h) so a coin can't bank time and coast once boring.
5. **Graduation.** After A hours a rookie joins the regular seats. If full, the regular coin with the lowest timer is cut (musical chairs).
6. **Death.** Timer hits zero, checked only at epoch boundaries: coin delisted; its curve reserve flows into survivors' curves, weighted by timer. Holders who stayed lose (accepted). Timers are public and turn red near zero; holds release in the danger zone.
7. **Second chance.** A dead meme can relaunch into the line like any new coin. No extra rules.

## Launch fee (decided requirement, mechanism proposed)

Launching a rookie coin costs a fee that rises when many people are launching and falls when few are. This is congestion pricing, like Ethereum's EIP-1559 base fee: a target launch rate per epoch, and the fee moves toward balancing actual launches against it.

```
launch_fee_next = launch_fee × (1 + α × (launches_this_epoch − target) / target)
```

- Bounded between a floor and a ceiling, published each epoch.
- Owned by the auction network (stage manager): the fixed rule above is the v0 default; the auction network learns the target (and α).
- Where the fee goes is open: platform, maker reserve, or the line's coins.
- Duplicates that merge into an existing coin pay no launch fee (they aren't a new coin).

## What it blocks

- **Duplicate coins:** merged at launch.
- **Launch spam:** dynamic launch fee rises with launch volume.
- **Sniping:** small per-person caps in the line; single opening batch auction.
- **Whale keeping a coin alive:** square-root breadth.
- **Wash trading:** identity plus fees; fees paid exceed the timer value they buy.
- **Cutoff timing tricks:** death checked only at epoch boundaries; timers update at batch close.
- **Cold start:** few seats, many rookie seats.
- **Platform volume swings:** drain is relative to the average; the stage manager resizes the board.

## Known risks

- **Runs near zero:** a red timer can trigger selling that kills the coin faster. Probably acceptable (boring coins should die); measure it.
- **Timer gamers:** people propping a coin near zero or dumping just before death. Needs a scripted attacker.

## Deployment notes

- Social deployment works as UX (Clanker: tag a bot in a post; Believe: reply to an X post), but every post creating a coin is exactly the duplicate problem. We keep launches cheap and merge duplicates.
- Outside trend data (TikTok Creative Center, X, Reddit) is **display only** on coin pages, never an input to survival rules.
- v2: a house agent may seed launch suggestions from trends; it never launches coins or holds supply.
- Content rules needed: real private people (especially minors), brands, copyrighted characters.

## Sim todo

- Run at low, medium, high and bursty platform volume.
- Tune S, P, A, k, timer cap, epoch length, line cap per person, reserve split, launch-fee target and α.
- Track coin lifespans, deaths per day, board occupancy, maker P&L, money lost by holders at death vs money reaching survivors, runs near zero.

## Open

- Who decides two memes are the same (automatic similarity vs a human call)
- Does the maker quote in the line?
- Where timers and board state are computed (suggest off-chain, published)
