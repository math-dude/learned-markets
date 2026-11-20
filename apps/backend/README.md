# Python backend

The backend uses Eren's [settlement interface](../../docs/ai-gen/design/settlement-interface.md).
Quantities are whole tokens, cash is lamports, prices are micro-lamports per token,
and sell fee rates are integer ppm. The simulator, trainer and backend share
`learned_markets_core.market.step_batch`.

The future web client calls this HTTP API. The backend reads program accounts and
builds unsigned program instructions through checked-in Codama Python bindings.

## Run

From the repository root, install the locked workspace and start the service.

```sh
uv sync --locked --all-packages --all-extras
uv run --package learned-markets-backend uvicorn learned_markets_backend.service:app --port 8000
```

FastAPI serves the request schemas at `/docs` and `/openapi.json`. Set
`LM_RPC_URL` to enable confirmed chain account reads.

| Route | Purpose |
| --- | --- |
| `POST /quote` | Public market observation and completed flow imbalance → frozen maker curve and published terms |
| `POST /clear` | Frozen quote, position snapshots and user curves → fills, integer sell fee rates and expected balances |
| `GET /v1/ledger/markets/{address}` | Confirmed ledger market state with the RPC context slot |

All wide integer fields cross HTTP as decimal strings. The tick window currently
has 16 points, matching the program payload's maximum. Each batch accepts at most
eight participants. One person submits one curve per coin per batch. Empty
batches produce an empty fill list.

`/quote` accepts public state only. `/clear` calls the shared core, which clips
intake to funding and position caps before choosing the clearing tick. These
semantics follow the selected environment interface.

Position snapshots include volume-weighted buy time and the exit terms locked on
purchase. The current program bounds the auctioneer's supplied fee rate. The
auctioneer must preserve those off-chain snapshots and the frozen quote between
batches. Program accounts provide cash, tokens and reserve state.

## Learned policy

The rule-based policy and a trained policy implement
`Callable[[Observation], Quote]`. Set
`LM_QUOTER_POLICY_FACTORY=your_module:create_policy` to load a training-owned
factory. The factory supplies its observation encoder and action decoder to
`learned_markets_backend.ppo.load_policy(checkpoint, encode, decode)`. Install
the `ppo` extra for Stable-Baselines3. The adapter checks the checkpoint's
observation space before inference. Training owns the feature and action spaces.

## Codama

```sh
npm run generate:python
```

Generation reads `target/idl/learned_markets.json`. Build the program first when
its interface changes. Generated files live under
`src/learned_markets_backend/generated`. Handwritten code in `chain.py` uses
those account decoders and instruction builders, verifies account ownership,
version and PDA, and returns the RPC slot alongside state.

`chain.settlement_instruction` converts a clearing result and validated account
references into an unsigned `solders.instruction.Instruction`. A settlement
service supplies authority signatures, fetches a recent blockhash, simulates,
submits, and reconciles confirmation before retrying. Those transaction delivery
and restart semantics remain future integration work.

The pinned `codama-py 0.1.7-beta` package omits templates from its npm artifact.
The generator uses matching upstream templates, a pinned compatible render-map
dependency, and code-safe template rendering. Provenance is recorded in
`scripts/vendor/codama-py/README.md`.

## Verification

```sh
uv run --all-packages --all-extras pytest -p no:pytest_anchorpy packages/core/tests apps/backend/tests
uv run --package learned-markets-backend python scripts/export-settlement-episode.py
```

The generated client is checked against `fixtures/ledger-wire.json`, produced
from real SBF execution in LiteSVM. Tests compare account decoding, complete
instruction bytes and account flags. The episode exporter runs the shared core
and produces `fixtures/settlement-episode.json`; Rust replays all six batches
and compares every balance after each one.

AnchorPy installs a pytest plugin whose optional test dependencies are outside
this project's test stack, so the command disables that plugin.

The parity ledger records simulated balances. Its credit instruction requires an
explicit `demo-credit` build, admin signature and a configured development
network label. Cluster targeting relies on the deployment workflow. M1's token
custody accounts use separate PDAs. Live deployment, transaction delivery and
per-position exit-term persistence need end-to-end integration.
