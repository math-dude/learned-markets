# Behaviours

## Problems in existing memecoin markets

- Sniping: bots buying in the launch block and dumping on the first humans
- Bundling: insiders buying supply through many fresh wallets to fake distribution
- Concentrated insider supply
- Creator rugs
- Coordinated pump-and-dumps by KOLs and cabals (incl. KOLs dumping on copy traders)
- Cascade selling after one large sell
- Wash trading to fake volume
- Sybil wallets to dodge per-wallet rules (handled by policy: one verified wallet per person)
- Sandwiching and front-running
- Fake momentum painted by one actor

## Risks to test in our design

- Can traders consistently take the maker's committed batch quote after it becomes stale?
- Can a large exit after a run-up push the maker beyond its inventory or loss limits?
- Can traders game thresholds or farm reputation without doing what the rule is meant to reward?
- Can traders cheaply keep a coin alive near zero or use the predictable cutoff to push losses onto other holders?
- Does a visible near-zero timer accelerate a sell-off?
- Can wash trades buy enough extra timer life to justify their fees?

## Behaviours we don't want to restrict

- Being early and right, and getting paid for it
- Fast pumps driven by real demand
- Taking profit
- Tokens fading when interest fades

## Decided policy

- One wallet per person, enforced by identity attestation (World ID, Solana Attestation Service, or similar)
- No trading on outside venues: token transfers are restricted to our venue (Token-2022)
