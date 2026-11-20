# Learned Markets web

From the root, run `npm ci`, copy `apps/web/.env.example` to `apps/web/.env.local`, then run `npm run dev`. Install Node, npm and uv first. Visit `http://localhost:5173`. The public app ID belongs in Vite configuration. Keep Privy's app secret out of browser configuration. Allow the frontend origin in the Privy dashboard and enable email login and embedded Solana wallets.

The launcher starts Vite, the Python validator backend, and the participant service. The Vite proxy serves `/api` from Python and `/v1` from the participant service. For other ports, set `LM_WEB_API_PORT`, and set `SERVICE_ORIGIN` to the exact browser origin. Set `LM_ATTESTATION_URL` to reuse a running participant service. The chain board lists markets launched through this backend. Keep the gate and backend on the same DB_PATH.

## Surfpool and enrollment

The default network is `surfpool`. The participant service uses `LM_RPC_URL`, defaulting to `http://127.0.0.1:8899` through the Chungus tunnel. The browser calls the service over HTTP. Privy signs a service-prepared transaction and the service verifies its signature, checks the cluster, broadcasts and waits for confirmation. [Privy signing API](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction)

The Surfpool instance needs the Learned Markets and SAS programs and an initialized gate for network `surfpool`. Check `GET /v1/network` on the web origin. The repo's `scripts/rollout.ts` is a disposable-environment setup and exercise script. Run it only against a dedicated Surfpool with its own keys. For devnet, explicitly set `LM_NETWORK=devnet` and configure `LM_RPC_URL` for that cluster.

1. Open Portfolio and sign in. The Privy wallet signs an enrollment challenge. If already eligible, it signs the session challenge directly.
2. Fund the wallet with test SOL on the chosen cluster to cover fees and account rent. On a local Surfpool use `solana airdrop 1 WALLET --url http://127.0.0.1:8899`.
3. The operator approves the request using the existing participant issuance workflow. Set `DB_PATH` to the same database as the web service (default `attestation-surfpool.sqlite`), `LM_KEYS_DIR` to the matching operator key directory, and `LM_RPC_URL` and `LM_NETWORK` to the room's configured cluster. Check enrollment in the UI, sign registration, then sign the session challenge.
4. An operator can initialize a registered participant’s Surfpool trading balance once with `.venv/bin/python scripts/seed-surfpool-balance.py WALLET`. This credits the program ledger. The wallet’s native SOL separately pays fees and rent.
5. Launch a market or submit a limit order. Privy signs the prepared transaction, the backend broadcasts it and the settlement worker clears admitted orders using the shared market core. The wallet and portfolio pages read confirmed validator accounts. The worker groups orders into 32-slot windows and the program accepts at most eight fills. Oversized transactions surface a failed batch outcome.
6. Run `LM_RPC_URL=http://127.0.0.1:8899 node scripts/check-surfpool.mjs --write` for 30 slot reads and ten signed memo confirmations. Use a funded test payer. For a bounded launch, buy and sell, set `SERVICE_URL` and `SERVICE_ORIGIN` to the frontend origin, `DB_PATH` to the shared gate database, `LM_NETWORK=surfpool` and `LM_RPC_URL` to its tunnel, then run `node scripts/surfpool-trading-demo.mjs`.

## Checks

```sh
npx playwright install chromium
npm run test:web
npm run typecheck
npm test
npm run build
uv run --locked --all-packages --all-extras pytest -p no:pytest_anchorpy packages/core/tests packages/simulation/tests apps/backend/tests
```

The reusable Chromium test launches an isolated paper room with `LM_PAPER_SANDBOX=1`, funds a browser account, launches a coin, buys and sells it, and reconciles fills, fees, cash and mobile guest state. The normal launcher uses the Solana gate. Keep the sandbox setting local to the test process.

Privy's Solana signing dialog uses its devnet label for the selected test validator. The signature preview calls the same-origin read/simulation endpoint. Only the wallet transaction relay submits signed messages to the configured validator.

To exercise multiple demo wallets on the running Chungus preview, run the following from the repo root with the operator keys and the matching SQLite database. Each named actor runs once, opens its market if needed, buys, sells, and checks its confirmed position.
```sh
export LM_NETWORK=surfpool LM_RPC_URL=http://127.0.0.1:18991
export SERVICE_URL=http://localhost:5173 SERVICE_ORIGIN=http://localhost:5173 DB_PATH=attestation-chungus.sqlite
node scripts/surfpool-trading-demo.mjs finch
node scripts/surfpool-trading-demo.mjs gecko
```
