# learned-markets

Hackathon scaffold for a learned-market exchange on Solana. The onchain/offchain
matching boundary and market design are still open; see [PLANNING.md](PLANNING.md).
Application source currently comes only from standard initializers.

## Components

| Directory | Purpose |
| --- | --- |
| `programs/learned_markets` | Anchor-generated counter starter; no exchange implementation yet |
| `apps/web` | React + Vite TypeScript starter |
| `apps/backend` | Python package with FastAPI/Uvicorn installed; no server or routes yet |
| `packages/simulation` | Python package for the future market simulator and Gymnasium environment |
| `packages/training` | Python package for future policy training with PyTorch/SB3 |
| [`packages/client`](packages/client/README.md) | Shared TypeScript SDK for interacting with the Anchor program; not generated yet |
| `tests` | Anchor-generated Rust integration test |

The root Bun workspace manages only `apps/web` and `packages/client`. The root uv
workspace manages only the three Python packages. Training and backend depend on
the local simulation package. Bun manages TypeScript dependencies and scripts;
Node runs the frontend tooling.

## Setup

Install the toolchains listed below, then run from the repository root:

```bash
bun install --frozen-lockfile
uv sync --all-packages --locked
anchor build
```

Program keypairs are local and ignored. On a fresh clone, run `anchor keys sync`
before building to align the generated program ID with your local program keypair.
The unmodified generated Rust integration test also has a literal program ID;
update that ID to match if you regenerate the program keypair.

## Development and checks

```bash
bun run dev       # Vite starter at http://localhost:5173
bun run build     # Web TypeScript check and production build
bun run lint      # Generator-provided web lint command
anchor build      # Onchain program and IDL
uv run ruff check apps/backend packages/simulation packages/training
```

The Python packages have no tests or application entrypoints yet. Do not expect a
running FastAPI service or training command at this stage. The TypeScript client
has dependencies and configuration only; client generation is a later step.

For the generated Rust integration test, create a disposable local wallet once:

```bash
mkdir -p .anchor
solana-keygen new --no-bip39-passphrase --silent --outfile .anchor/test-wallet.json
```

Start an offline validator in one terminal:

```bash
surfpool start --offline --no-tui --no-studio --no-deploy --airdrop-keypair-path .anchor/test-wallet.json
```

Then run the test in another terminal:

```bash
anchor test --skip-local-validator --provider.wallet .anchor/test-wallet.json
```

This explicit Surfpool workflow passed locally. Automatic validator startup via
plain `anchor test` failed during runbook startup with a closed RPC connection.
No devnet deployment has been performed.

## Verified versions

| Tool / dependency | Version |
| --- | --- |
| Anchor CLI / anchor-lang | 1.2.2 |
| Agave / Solana CLI | 4.1.2 (recommended by Anchor 1.2.2) |
| Rust | 1.89.0 (generator-pinned) |
| Surfpool | 1.7.0 |
| Python | 3.12.12 |
| uv | 0.9.7 |
| NumPy / Gymnasium | 2.5.4 / 1.4.0 |
| PyTorch / Stable Baselines3 | 2.15.0 / 2.9.2 |
| FastAPI / Uvicorn | 0.162.5 / 0.54.0 |
| Node / Bun | 22.17.0 / 1.3.5 |
| React / Vite / TypeScript | 19.3.1 / 8.3.8 / 7.0.2 |
| Solana Kit / Codama | 8.6.0 / 1.11.0 |

Commit `Cargo.lock`, `bun.lock`, and `uv.lock`. Anchor and Solana versions are
pinned in `Anchor.toml`; Rust and Python have their own toolchain pins.

Likely later Python dependencies: Numba, Polars, PyArrow, ONNX, ONNX Runtime, and
Hypothesis. These have not been installed. Matching, inference, wallet integration,
charting, client generation, keeper/bot services, and deployment remain future work.
