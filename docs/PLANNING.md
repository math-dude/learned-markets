## Decision Points
1. Should we have the matching engine / market logic be onchain or offchain?
  a. offchain market logic makes it more likely that we'd have a functional product
  b. our neural net / trader will have to be offchain regardless
  c. offchain also may compromise our "best use of solana" award
  d. offchain may be harder to build in the shortest amount of time, which may put our hackathon timeline at risk
2. Should we have a deployer? Should we make a full launchpad or just a few trading pools?
3. Should the market have special privileges over the pool or should it be like any other trader?

## Open Questions
1. What should the RL training optimize for?
  a. fun in the market (roughly measured by volume, number of participants, number of small traders)
  b. healthy price action (no violent swings)
4. Which RL package should we use? should we optimize for adversarial training?
5. Can we think of a flagship coin that would be our "demo" of sorts?
6. What will the interface of the onchain pool be? what will its boundaries be?
