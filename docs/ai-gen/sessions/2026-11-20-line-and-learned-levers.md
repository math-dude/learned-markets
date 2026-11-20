# Line, rookies and learned levers

Design session on November 20, following the [RL environment handoff](2026-11-20-rl-environment-handoff.md). The [decision log](../decisions.md) holds the results. The RL environment is meant to be ready for the submission, because what it can express narrows the rest of the product.

## What changed

- **Orders are curves, with no fixed family.** The program likely only settles fills, so clearing math does not need a Rust mirror. Piecewise linear is a test family.
- **Learned first, fixed rule as stand-in.** Each lever belongs to a learned policy and has a fixed rule behind the same interface. The lever table is in the decision log.
- **The line is capped and cut by rank.** The coldest coins are cut in fixed rounds, so elimination runs as fast as launches. Newcomers get a grace period. This pairs with the dynamic launch fee, which the auction network learns; the stand-in ties the fee to how full the line is.
- **Rookie and established stay distinct.** Rookies trade wilder. Graduation is earned by activity. The quoter sees the stage and learns the terms.
- **Hoarding is never allowed.** The quoter learns the per-person cap; a hard ceiling is the stand-in.
- **Rejected:** a config-parameter starting inventory for the maker, and a 0-to-1 maturity score.

## Later in the session

- **The quoter is the launch.** It starts with the coin's unissued supply and releases it through its sell curve. A bonding curve, an IPO-style auction and an equal-bag "drop" were all rejected; reasons are in the decision log.
- **Quoter budget in two buckets,** the coin's own money and a house risk allowance that starts at zero. The quoter has no holding limit.
- **Both networks are trained,** in turns, on one shared reward to try: distinct people trading, weighted by how close the price is to the meme's hidden true value.
- **Deployers earn a small cut of trading fees** after their coin is seated.
- The remaining sim numbers are placeholders, listed under Open in the decision log.

## Considered, not adopted

- A nomination line where memes are backed before any coin exists. The program already has a `Nomination` intent. It was raised and not taken up; the trading line stays.
- Releasing launch supply in tranches unlocked by sell-through.
- Longer batches for rookie coins.

## Notes for the design docs

`market-rules.md`, `board-and-timers.md` and `rl-formulation.md` have not been updated to match. They still restrict curves to fixed families, call for Python and Rust clearing parity, give the line no elimination rule, and graduate rookies after a fixed number of hours.

With monotone demand and supply curves, the prices that maximize volume form one unbroken range. The nearest one to the previous clearing price is that price clamped into the range, so the equal-distance tie-break may not need a rule. This is an observation from the session, not a decision.

## Next

No design decision blocks the one-coin environment now. Build it with the placeholder numbers, then the many-coin environment for the auction network.
