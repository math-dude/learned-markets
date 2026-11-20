# Group chat ideas (Nov 12–18, 2026)

> **⚠️ NOT DECISIONS. Context only.**
> These are ideas, suggestions and arguments compiled from the team's "learned markets" group chat (Eren, Soham, Isha) between Nov 12 and Nov 18, 2026. Nothing here is settled. Several items were later replaced or rejected. **`docs/ai-gen/decisions.md` is the source of truth** for what's decided; where this file disagrees with it, `decisions.md` wins.
>
> AI-generated summary (Claude), compiled 2026-11-19 by reading the chat. Logistics messages (rides, rooms, hardware posts) were left out. Attributions are best effort.

## 1. Scope and focus

- **Build the learned AMM, not a full launchpad** (Eren). A full launchpad plus a full training loop isn't realistic for the hackathon, so pick the part that sets us apart and is easy to show. Soham agreed and said the industrial-deployment rules (the Solana attestation stuff) feel trivial next to it. Eren: the learned market is the most interesting part, even if its commercial value is uncertain.
- **Game vs. serious tool.**
  - Isha: something gamified is cool (like Cade markets), but judges may care more about impact.
  - Eren: what judges want and what consumers want often differ.
  - Soham: don't build a full casino, and don't make player-vs-player the main focus.
  - Eren: there should be an element of skill without making it toxic, playable at different skill levels.
- **Hackathon cutoff** (from Eren's assistant): Fri Nov 20 at noon Central. Ship one playable batch-auction round with devnet settlement. Include the trained bot in the demo only if it beats a rule-based baseline in a quick replay.

## 2. Eren's "calm decisions" message (Nov 17)

Eren labelled these "calm decisions (if objections we can scrap)":

- The app emphasizes "allocations" or "attention slots". Coins compete for limited space by paying rent or bidding in an auction.
- Memes that don't trade enough volume get killed, and their liquidity is reinvested into new coins, similar to pump.fun's Mayhem Mode. Both approaches can coexist.
- **Behaviours to suppress:**
  1. sniping
  2. holding value in more than one wallet (fixed with Solana Attestation Service)
  3. violent dumps and swings
  4. copy-trading pump-and-dumps
  5. any kind of latency race

  The winners should be people who predict which memes will do well, not people with fast code or low-latency feeds.
- **Possible fix for #2:** force manual trading, use batch auctions everywhere, and cap sizes so sophisticated actors can't justify spending on infrastructure.
- **Addition to #2:** make it a fun skill-based game, and make sure garage-band quants can't hunt manual traders or KOLs.
- **Industrial deployment:** police what gets deployed, so two semantically identical coins can't both launch. No latency races around launches.
- **Enforcement idea** (from a Claude write-up Eren pasted, Nov 16):
  - one person, one account, verified through SAS
  - a fixed number of listing slots
  - a recurring auction for those slots

## 3. Batch auction mechanics

- **Every order is a curve** in the batch auction (Soham). This makes sniping much less attractive.
  - Soham noted Archer Exchange used dual-flow batch auctions for Colosseum, then switched to separate order books for each market maker. The toy-dfba repo won Colosseum.
  - Eren: we have to do better than that.
- **Sealed orders** during the batch window (Isha), so nobody can wait until the last second, see everyone's bids and snipe the clearing price. Soham agreed. He said arrival order is still an information advantage, but no longer an execution advantage.
- **The end of each batch can still be a latency race** (Eren).
  - Isha: randomize when the batch cuts off.
  - Soham: batch size is something to tune.
- **Keep the rules few** (Eren). Too many rules are hard to present and hard for users to understand, so complexity should ramp up over time. Soham: the backend doesn't need to be fully explained to the average trader.
- **Our AMM is the only quoter** (Soham). No outside market makers. It quotes based on activity in the last ~10ms of each auction. Start simple: we want an AMM after all.

## 4. How the AMM dampens moves

- **Allow big sells, then buy back gradually** using a TWAP or spread-out orders, so the coin steps down instead of crashing (Soham). Holding more supply lets the AMM choose how to respond to other traders.
  - Eren: this can be gamed heavily.
  - Isha: wouldn't this encourage dumping?
  - Eren: people could dump on the AMM again once it's done buying.
- **Taker flow as an input** that decides how much supply the AMM carries (Soham).
- **"Drilling the chart"** (Soham): some traders already act like an RL'd AMM, spamming sells of 1% of their position whenever buyers show up. Isha: measure total amount sold per wallet over a time window, not the number of trades, so 50 tiny sells count as one big dump. Soham: 50 tiny sells is a slow dump, and some of them get cancelled out by buys.
- **Soham's long message (Nov 18):**
  - Batch auctions shrink sharp moves once orders are aggregated.
  - Because bids are curves, the AMM can put more money in at lower prices, which creates a solid floor that's hard to break through.
  - Add rules on how much one person can buy, plus hold-time limits scaled by size. Then run simulations and drop the rules that make the market too restrictive.
  - With low inventory, the AMM buys back more generously, but not forever. At some point (to be found in simulations) it gives up, classifies the coin as not worth keeping alive and protects people. That could add another fun aspect to the game.
  - If the AMM realizes a coin is dying before other traders do, it can't lose money.
- **Pump.fun Mayhem Mode as a reference** (Soham):
  - Its AMM gets 1B tokens (50% of supply) when a token is created, and it is mostly farmed by snipers, who track volume and farm its liquidity plus fees.
  - We could do something similar, but differently, so a coin can still rise instead of being trapped by the AMM's supply control.

## 5. Bad actors and copy trading

- **Penalize bad actors first, rather than reward traders** (Soham). Both go hand in hand. Example: the coin's creator holds no supply and instead earns a share of the AMM's fees and other creator rewards, which limits what people can farm maliciously.
- **Copy trading** (disputed):
  - Soham: dumping on copy traders is part of the game. We can't even tell copy trading from an organic buy.
  - Eren **hard disagreed**: it should be hard to keep dumping on your followers, and the model should catch it automatically. Example: a minimum hold time that depends on activity, with selling allowed if nobody else is buying.
  - Where it landed: copy-trader dumping is a subset of dumping in general and should be handled automatically. Soham also suggested not offering copy trading at all and pitching "copy trader protection" instead.
- **Multi-wallet detection** (Isha): a pump.fun paper clusters wallets by their funding source, and a lot of sniping and copy-trader dumping comes down to one person running many wallets. Also infer intent from markouts (someone keeps buying early and selling into latecomers) and score per person rather than per wallet. Flagged users could be fined or banned.
- **Identity** (Eren): require attestation through SAS. Act at model inference, because once the exchange logic is on-chain we can't intervene after the fact. Soham: SAS wallets save us from wallet-cluster tracking, and SAS plus Token-2022 matches the hackathon's Solana description.
- **Extra behaviours to cover** (Soham):
  - vamps (duplicate or variant coins)
  - large buys and sells that drain the AMM
  - keeping the presentation simple

  Eren: vamps are handled at deployment, and deployment (auctions) and trading could be unified.
- **Pitch framing** (Eren): put the banned behaviours into a learning framework. The core three are supply sniping, multi-wallet, and dumping on copy traders.

## 6. Slots and coin lifecycle

- **Launch windows** (Soham): of the first ~20 coins launched in a 10-minute window, the most liquid one gets the rest's liquidity. This needs to be MEV-resistant so nobody can control a coin with a single 100 SOL buy. Eren liked it because it allows both fast and slow trading, with games on different time scales.
- **Bundle near-identical coins** into one coin when they're suggested together (Eren).
- **Second chance:** coins that don't make it can reappear in the next batch (Soham; Isha liked it).
- **A good meme that isn't a vamp but gets no attention** (Soham): what happens to it? Left open.
- **Merging losing pools into winners** by giving the losers' holders the winning coin's tokens. Soham: this wouldn't make holders richer; it would just make the pool bigger, not swap anything.
- **Harberger-tax slots** (Claude write-up Eren shared, Nov 17): Soham said it made the game boring.

## 7. Simulation, RL and data

- **Scope** (Eren):
  - Teaching the market would be great, but there may not be time to do much RL.
  - It needs to trade across the memecoins in the N slots without losing money.
  - After the hackathon it could be published on Hugging Face as an RL environment.
- **Data:**
  - Soham: we can download ~80GB of on-chain parquet (2 months of pump.fun trades, creates and transfers), with derived tables at ~0.5GB per 1k tokens (Token Terminal × Google).
  - Eren: GCP is painful; download it onto chungus. Soham: run simulations on chungus for speed.
  - Eren: we barely need pump.fun data. We could just code agents that take malicious actions and test the market against them.
- **Taker flow** (Claude write-up): calibrated Hawkes background flow plus a population of attackers weighted by a meta-solver (PSRO, OpenSpiel-style).
- **Referee / stabilizer split** (Claude write-up):
  - the referee can't see the order book
  - the stabilizer never trades first
  - it has no profit motive beyond survival
  - everything is on record

  Eren: debatable, more a well-behaved skewed learned market; the open question is how involved the market should be. *(Since replaced by the auction network / quoting network split; see `decisions.md`.)*
- **Market makers' sophistication** (Eren): Claude described something like "100 agent swarms"; nobody will attack that, but if it's the precursor to something like Delta, it's helpful.

## 8. Demo and pitch

- **Demo ideas** (Claude write-up Eren shared):
  - a live season where the audience trades
  - side-by-side attacks on a plain curve vs. the learned market (KOL dump, sniper swarm, pump-and-dump)
  - a "hype vs. attention" meter
  - a replay of a real pump.fun rug
  - daring the judges to profit from a dump

  Run order for a 3-minute pitch: hook, live session, attack demo, results, close.
- **Reuse in the presentation:** the Bando tweet with a table of top traders, 26-second average hold time, $72.6m total PnL, and "this is who you're trading against."
- **Reference material shared in the chat:**
  - Learned Markets: Prior-Art Investigation (Claude doc)
  - Multicoin, "Building the Attention Economy"
  - Jump Crypto, "Dual Flow Batch Auction"
  - Archer-Exchange/toy-dfba on GitHub
  - pump.fun Mayhem Mode

## Left open in the chat

- How hard the AMM should step in vs. let prices fall.
- Whether copy trading is offered at all.
- How many rules to keep for the demo.
- What happens to a good meme that gets no attention.
