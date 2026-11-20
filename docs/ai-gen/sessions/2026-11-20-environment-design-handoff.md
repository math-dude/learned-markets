# Environment design handoff

The mechanism is settled enough to design the RL environments. The next session designs them in plan mode, then builds. The submission is due Friday, November 20 at noon CST; this note was written at 4:15 AM CST.

Read the [decision log](../decisions.md) first. It is the source of truth. The [session note](2026-11-20-line-and-learned-levers.md) explains how the decisions were reached. `market-rules.md`, `board-and-timers.md` and `rl-formulation.md` predate this session and disagree with the log in places; the log wins.

## Working rules from the team

- Stay in discussion until told to build. Do not write code during design.
- Rules should fall out of a simple action space. Prefer a learned lever with a fixed stand-in over a hand-written rule.
- The quoter's logic must be reusable by the production backend, so keep the market core free of Gym and simulation code.
- Check proposals against the Rejected table before raising them.

## The design in brief

- **Auction.** Every order is a curve, with no fixed family. User and quoter curves clear together at one price that maximizes volume, nearest the previous price on ties. Clearing runs off-chain and the program only settles.
- **Launch.** The quoter is the launch. It starts with the coin's unissued supply and releases it through its own sell curve. Bids set the price each batch. Sale money goes to that coin's reserve.
- **Quoter budget.** A safe bucket (the coin's own fees, sale money and launch-fee share) and a house risk allowance that starts at zero. The quoter has no holding limit.
- **Terms.** The quoter outputs per-person capacity, exit fee and hold through a function of the person's identity. The first version uses their position and how recently they bought. No one may hoard supply.
- **Life of a coin.** It launches into a capped line. The coldest coins are cut in fixed rounds, after a grace period. Hot coins earn rookie seats, and graduation to a regular seat is earned by activity. Rookies trade wilder.
- **Auction network.** It never picks coins. It learns the launch fee, line size, seat count, rookie seats, timer drain rate and timer cap.
- **Reward, to try.** Distinct people who traded in a batch, each weighted by how close the price was to the meme's hidden true value. The auction network counts each person once per batch across the platform. There is no profit term.

## Two environments to design

**One coin, whole life (trains the quoter).** The episode runs from launch in the line to a cut, a death, or the horizon. The rest of the line is background competition.

**Many coins (trains the auction network).** The quoter is frozen. Train the quoter first against fixed stand-ins, then the auction network.

## What the design session must work out

- The simulated traders and how a meme's true value moves. The reward is defined against true value, and every learned behaviour depends on traders reacting to fees and caps. This is the largest risk to the result.
- A finite crowd with limited attention, which the auction network's reward depends on.
- The action encoding: how many numbers describe the quoter's curve, the supply release and the terms function.
- How one coin's heat is ranked against the simulated rest of the line.
- How deployers respond to the launch fee and how memes arrive.
- Whether each coin in the many-coin environment runs the frozen quoter or a cheaper approximation.
- The module split that lets the backend reuse the market core and the quoter.

## Stubs and placeholders

- Money left by a dead coin is only recorded. Its destination is leaning, with an unresolved honeypot concern.
- Hoarding uses the hard 2% ceiling until the reward gets a term for it.
- The board proposal's opening auction on seating is probably unnecessary now that coins trade from launch. Confirm with the team.
- Seated coins die by the timer rule, which is still tentative.
- The numbers to tune are listed under Open in the decision log.

## Checks to run once it trains

- The trained quoter beats the plain bonding-curve baseline and the rule-based quoter.
- A scripted large dump shows whether the quoter learned to charge for it.
- Report markouts, attacker profit, trader profit by type, reserve P&L and money trapped at death as evaluation, not reward.

## Checkout state

The Python packages under `packages/simulation`, `packages/training` and `apps/backend` are empty scaffolds. `settlement.rs` still uses `NotImplementedEngine`. `payload.rs` defines a curve order as up to 16 price and quantity points per side. The doc edits from both November 20 sessions are uncommitted working-tree changes.
