# learned-markets

An experimental exchange on Solana exploring a simple question: **can a market
learn how to make trading more fun, less toxic, and financially sustainable?**

Memecoins bring culture, attention, and speculation together. Our thesis is that
their appeal is held back by market structures that encourage manipulation,
abrupt liquidity changes, and violent price swings. We want to explore market
design as a learning problem: a venue that adapts how it provides liquidity and
responds to trading activity.

The goal is a fun exchange that can make money while supporting a healthier
trading experience. What that means in measurable terms is part of the research.

## The approach

We plan to build a simulated market, train reinforcement-learning policies, and
evaluate how they behave across rising prices, falling prices, volatile regimes,
and adversarial trading. Those policies would inform how the exchange responds
to market conditions, with an Anchor program providing the onchain component and
a web app giving traders access.

We are still exploring what the policy controls, what it should optimize, and
how matching and settlement should be divided between onchain and offchain
components. The design is being developed during the hackathon; this repository
currently contains the scaffold, not a working exchange.

## Run locally

To start the current web starter, use Node and npm from the repository root:

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite. The backend and training packages do not have
runnable entrypoints yet.

For setup, program builds, local Solana tests, and the repository layout, see
[Development](docs/DEVELOPMENT.md). Open design questions live in
[Planning](docs/PLANNING.md).
