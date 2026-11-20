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

The shared Python core now clears batches and applies the simulator's ledger.
An atomic Anchor parity ledger validates and settles its fills. A six-batch
episode replays in LiteSVM with matching participant, reserve and platform
balances after each batch. The current interface is described in
[Settlement interface](docs/ai-gen/design/settlement-interface.md).

## Run locally

To start the web event feed, use Node and npm from the repository root:

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite. The [Python backend](apps/backend/README.md)
serves quotes, clearing and confirmed ledger account reads. It uses
Codama-generated Python bindings for program access. A future trading client
can call this API.

```sh
uv sync --locked --all-packages --all-extras
uv run --package learned-markets-backend uvicorn learned_markets_backend.service:app --port 8000
```

Program `nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz` has a locally tested
parity ledger. The current build's deployment and live transaction delivery are
pending. Ledger balances are simulated accounting units. The earlier token
custody implementation has separate accounts. QuickNode integration remains
available as an experimental sponsor-bounty adapter.

For setup, program builds, local Solana tests, and the repository layout, see
[Development](docs/DEVELOPMENT.md). Open design questions live in
[Planning](docs/PLANNING.md).
