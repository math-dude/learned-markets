# Learned Markets web

From the root, run `npm ci`, copy `apps/web/.env.example` to `apps/web/.env.local`, then run `npm run dev`. Install Node, npm and uv first. Visit `http://localhost:5173`. The public app ID belongs in Vite configuration. Keep Privy's app secret out of browser configuration. Allow the frontend origin in the Privy dashboard and enable email login and embedded Solana wallets.

The launcher starts Vite, one Python auctioneer, and the participant service. The Vite proxy serves `/api` from Python and `/v1` from the participant service. For other ports, set `LM_WEB_API_PORT`, and set `SERVICE_ORIGIN` to the exact browser origin. Set `LM_ATTESTATION_URL` to reuse a running participant service. The existing relayer feed is available at `/activity` with `VITE_SETTLER_URL` configured.

## Surfpool and enrollment

The default network is `surfpool`. Both the service and the browser default to `http://127.0.0.1:8899`. A forwarded port works with a Surfpool hosted on Chungus. Use `LM_RPC_URL` for the server and `VITE_SURFPOOL_RPC_URL` for the browser to select another local port. The browser checks the Surfpool version and the gate's genesis hash before it asks Privy to sign. The signed bytes go only to the verified RPC. A fork can report its upstream genesis hash. [Privy signing API](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction)

The Surfpool instance needs the Learned Markets and SAS programs and an initialized gate for network `surfpool`. Check `GET /v1/network` on the web origin. The repo's `scripts/rollout.ts` is a disposable-environment setup and exercise script. Run it only against a dedicated Surfpool with its own keys. For devnet, explicitly set `LM_NETWORK=devnet` and configure `LM_RPC_URL` and `VITE_SOLANA_DEVNET_RPC` for that cluster.

1. Open Portfolio and sign in. The Privy wallet signs an enrollment challenge. If already eligible, it signs the session challenge directly.
2. Fund the wallet with test SOL on the chosen cluster to cover fees and account rent. On a local Surfpool use `solana airdrop 1 WALLET --url http://127.0.0.1:8899`.
3. The operator approves the request using the existing participant issuance workflow. Set `DB_PATH` to the same database as the web service (default `attestation-surfpool.sqlite`), `LM_KEYS_DIR` to the matching operator key directory, and `LM_RPC_URL` and `LM_NETWORK` to the room's configured cluster. Check enrollment in the UI, sign registration, then sign the session challenge.
4. An eligible participant receives 2 paper SOL once per room. Submit a limit order or launch. Privy signs a Solana trade or nomination intent. The gate checks the confirmed intent, participant, current wallet binding, badge, payload, target and expiry. The Python auctioneer queues accepted actions for the named batch. Portfolio shows fills, fees and launch outcomes.

Each protected request binds the paper room and batch into the intent target. Paper targets are separate from funded ledger-market accounts. The gate records admissions in SQLite. Paper balances, coin names, history and the room ID reset when the auctioneer restarts. Production custody and on-chain fill delivery are separate integration work. Gated batches last 60 seconds. The board uses a 12-batch demo epoch and a lower seating threshold. Set `LM_QUOTER` to run an exported policy.

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
